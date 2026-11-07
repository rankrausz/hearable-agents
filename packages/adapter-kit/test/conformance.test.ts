// packages/adapter-kit/test/conformance.test.ts — behaviour tests for the
// conformance runner itself: an empty suite set reports every category as
// uncovered, an adapter that emits a denied kind fails, an adapter that emits
// only permitted kinds passes, and each covered path (fixture mapping,
// installer, unknown events) really checks what it claims. The registration
// layer is exercised for real by registering a green suite at the top of this
// file and, end to end, by `pnpm conformance`.

import { fileURLToPath } from "node:url";
import type { NormalizedEvent } from "@hearable/core";
import { describe, expect, it } from "vitest";
import { checkRedactionCase, recordedLinesFor } from "../src/conformance/redaction.js";
import { measureRelayPayload } from "../src/conformance/relay-timing.js";
import { registerConformance } from "../src/conformance/runner.js";
import type { ConformanceCase, ConformanceCategory } from "../src/index.js";
import { CONFORMANCE_CATEGORIES, planConformance, RELAY_TIMING_BUDGET_MS } from "../src/index.js";
import {
  ALL_OBSERVED,
  capableTestAdapter,
  claudeShapedTestAdapter,
  installerDouble,
  leanTestAdapter,
  minimalEventFor,
  permittedEvents,
  selfcheckRedaction,
  selfcheckRelayTiming,
  stubAdapter,
  testContext,
  testEvent,
} from "./doubles.js";

// A green, covered registration: these cases run as part of this very file,
// proving the registration layer produces real passing Vitest cases.
registerConformance(capableTestAdapter, {
  emissions: permittedEvents,
  relayTiming: selfcheckRelayTiming,
  redaction: selfcheckRedaction,
});

// A registered installer suite with shared state: the idempotence and
// byte-exact cases run back-to-back against the same config, so a runner
// that did not give each case a clean baseline would fail its own green
// suite (this registration is the regression guard for exactly that).
const registeredInstaller = installerDouble();
registerConformance(registeredInstaller.adapter, { installer: registeredInstaller.suite });

function casesFor(plan: readonly ConformanceCase[], category: ConformanceCategory) {
  return plan.filter((testCase) => testCase.category === category);
}

function theCase(plan: readonly ConformanceCase[], category: ConformanceCategory) {
  const found = casesFor(plan, category);
  expect(found.length, `expected exactly one ${category} case`).toBe(1);
  const testCase = found[0];
  if (testCase === undefined) {
    throw new Error(`missing ${category} case`);
  }
  return testCase;
}

async function expectCoveredRunToReject(testCase: ConformanceCase, pattern: RegExp): Promise<void> {
  expect(testCase.status).toBe("covered");
  await expect(async () => {
    if (testCase.status === "covered") {
      await testCase.run();
    }
  }).rejects.toThrow(pattern);
}

describe("the conformance runner", () => {
  it("reports every category as not covered when no suites are supplied", () => {
    const plan = planConformance(leanTestAdapter);
    expect(plan.map((testCase) => testCase.category)).toEqual([...CONFORMANCE_CATEGORIES]);
    for (const testCase of plan) {
      expect(testCase.status).toBe("not-covered");
      if (testCase.status === "not-covered") {
        expect(testCase.absentReason.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps reporting a supplied-but-empty suite as uncovered, with a distinct reason", () => {
    const plan = planConformance(leanTestAdapter, { fixtures: [], emissions: [] });
    const fixtures = theCase(plan, "fixture-mapping");
    const emissions = theCase(plan, "capability-honesty");
    expect(fixtures.status).toBe("not-covered");
    expect(emissions.status).toBe("not-covered");
    if (fixtures.status === "not-covered") {
      expect(fixtures.absentReason).toContain("empty");
    }
    if (emissions.status === "not-covered") {
      expect(emissions.absentReason).toContain("empty");
    }
  });

  it("fails an adapter that emits a kind its capabilities deny", async () => {
    const adapter = stubAdapter({
      capabilities: { ...ALL_OBSERVED, toolEvents: false, toolFailures: false },
      map: () => [minimalEventFor("tool.start")],
    });
    const emissions = adapter.map({}, testContext());
    const plan = planConformance(adapter, { emissions });
    await expectCoveredRunToReject(
      theCase(plan, "capability-honesty"),
      /emits kinds its capabilities deny.*toolEvents/s,
    );
  });

  it("passes an adapter that emits only kinds its capabilities permit", async () => {
    const plan = planConformance(capableTestAdapter, { emissions: permittedEvents });
    const testCase = theCase(plan, "capability-honesty");
    expect(testCase.status).toBe("covered");
    if (testCase.status === "covered") {
      await testCase.run();
    }
  });

  it("fails emissions that do not satisfy the event schema", async () => {
    // A tool.end without its tool block: type-checked code cannot build this,
    // but a lying adapter at runtime can, which is exactly what the boundary
    // validation exists to catch.
    const broken = {
      v: 1,
      id: "broken",
      ts: 0,
      receivedAt: 0,
      agent: "emit",
      sessionId: "s1",
      kind: "tool.end",
    } as unknown as NormalizedEvent;
    const lyingAdapter = stubAdapter({
      capabilities: ALL_OBSERVED,
      map: () => [broken],
    });
    const emissions = lyingAdapter.map({}, testContext());
    const plan = planConformance(lyingAdapter, { emissions });
    await expectCoveredRunToReject(
      theCase(plan, "capability-honesty"),
      /does not satisfy the normalized event schema/,
    );
  });

  it("checks each fixture payload against its expected events", async () => {
    const raw = { session_id: "abc", hook_event_name: "SessionStart", cwd: "/repo" };
    const expected = [
      testEvent({
        id: "stub-abc-session-start",
        ts: 1000,
        receivedAt: 1000,
        agent: "claude-code",
        sessionId: "abc",
        kind: "session.start",
      }),
    ];
    const plan = planConformance(claudeShapedTestAdapter, {
      fixtures: [{ name: "session-start", raw, ctx: testContext(), expected }],
    });
    const testCase = theCase(plan, "fixture-mapping");
    expect(testCase.status).toBe("covered");
    if (testCase.status === "covered") {
      await testCase.run();
    }
  });

  it("fails a fixture whose mapped events differ from the expectation", async () => {
    const raw = { session_id: "abc", hook_event_name: "SessionStart", cwd: "/repo" };
    const wrongExpectation = [
      testEvent({
        id: "stub-abc-session-start",
        agent: "claude-code",
        sessionId: "abc",
        kind: "session.end",
      }),
    ];
    const plan = planConformance(claudeShapedTestAdapter, {
      fixtures: [{ name: "session-start", raw, ctx: testContext(), expected: wrongExpectation }],
    });
    await expectCoveredRunToReject(
      theCase(plan, "fixture-mapping"),
      /mapped the payload to different events/,
    );
  });

  it("fails a fixture whose mapped events violate the event schema", async () => {
    const raw = { session_id: "abc", hook_event_name: "SessionStart", cwd: "/repo" };
    const broken = {
      v: 1,
      id: "broken",
      ts: 0,
      receivedAt: 0,
      agent: "emit",
      sessionId: "s1",
      kind: "tool.end",
    } as unknown as NormalizedEvent;
    const lyingAdapter = stubAdapter({
      capabilities: ALL_OBSERVED,
      map: () => [broken],
    });
    const plan = planConformance(lyingAdapter, {
      fixtures: [{ name: "session-start", raw, ctx: testContext(), expected: [] }],
    });
    await expectCoveredRunToReject(
      theCase(plan, "fixture-mapping"),
      /does not satisfy the normalized event schema/,
    );
  });

  it("passes an unknown-event payload that is preserved as a notification", async () => {
    const raw = { session_id: "abc", hook_event_name: "SomeNewEvent", cwd: "/repo" };
    const plan = planConformance(claudeShapedTestAdapter, {
      unknownEvents: [{ name: "some-new-event", raw, ctx: testContext() }],
    });
    const testCase = theCase(plan, "unknown-event-preservation");
    expect(testCase.status).toBe("covered");
    if (testCase.status === "covered") {
      await testCase.run();
    }
  });

  it("fails an adapter that drops unknown events", async () => {
    const raw = { session_id: "abc", hook_event_name: "SomeNewEvent", cwd: "/repo" };
    const droppingAdapter = stubAdapter({ capabilities: ALL_OBSERVED });
    const plan = planConformance(droppingAdapter, {
      unknownEvents: [{ name: "some-new-event", raw, ctx: testContext() }],
    });
    await expectCoveredRunToReject(
      theCase(plan, "unknown-event-preservation"),
      /was not preserved/,
    );
  });

  it("passes an idempotent installer against a throwaway config", async () => {
    const { adapter, suite } = installerDouble({ secondInstallChanges: false });
    const plan = planConformance(adapter, { installer: suite });
    const testCase = theCase(plan, "installer-idempotence");
    expect(testCase.status).toBe("covered");
    if (testCase.status === "covered") {
      await testCase.run();
    }
  });

  it("fails an installer that changes something on the second install", async () => {
    const { adapter, suite } = installerDouble({ secondInstallChanges: true });
    const plan = planConformance(adapter, { installer: suite });
    await expectCoveredRunToReject(
      theCase(plan, "installer-idempotence"),
      /second install reported changed: true/,
    );
  });

  it("passes a byte-exact uninstall", async () => {
    const { adapter, suite } = installerDouble({ secondInstallChanges: false });
    const plan = planConformance(adapter, { installer: suite });
    const testCase = theCase(plan, "byte-exact-uninstall");
    expect(testCase.status).toBe("covered");
    if (testCase.status === "covered") {
      await testCase.run();
    }
  });

  it("fails an uninstall that does not restore the config bytes", async () => {
    const { adapter, suite } = installerDouble({
      secondInstallChanges: false,
      uninstallRestores: false,
    });
    const plan = planConformance(adapter, { installer: suite });
    await expectCoveredRunToReject(
      theCase(plan, "byte-exact-uninstall"),
      /did not restore the config byte-for-byte/,
    );
  });

  it("keeps absent relay-timing and redaction visibly uncovered, and covered once registered", () => {
    const bare = planConformance(capableTestAdapter, { emissions: permittedEvents });
    const bareRelay = theCase(bare, "relay-timing");
    const bareRedaction = theCase(bare, "redaction");
    expect(bareRelay.status).toBe("not-covered");
    expect(bareRedaction.status).toBe("not-covered");
    if (bareRelay.status === "not-covered") {
      expect(bareRelay.absentReason).toContain("relayTiming");
    }
    if (bareRedaction.status === "not-covered") {
      expect(bareRedaction.absentReason).toContain("redaction");
    }

    const covered = planConformance(capableTestAdapter, {
      emissions: permittedEvents,
      relayTiming: selfcheckRelayTiming,
      redaction: selfcheckRedaction,
    });
    const relay = theCase(covered, "relay-timing");
    const redaction = theCase(covered, "redaction");
    expect(relay.status).toBe("covered");
    expect(redaction.status).toBe("covered");
    if (relay.status === "covered") {
      expect(relay.title).toContain(`${RELAY_TIMING_BUDGET_MS} ms`);
    }
  });

  it("keeps reporting supplied-but-empty timing and redaction suites as uncovered", () => {
    const plan = planConformance(leanTestAdapter, {
      relayTiming: { payloads: [] },
      redaction: [],
    });
    const relay = theCase(plan, "relay-timing");
    const redaction = theCase(plan, "redaction");
    expect(relay.status).toBe("not-covered");
    expect(redaction.status).toBe("not-covered");
    if (relay.status === "not-covered") {
      expect(relay.absentReason).toContain("empty");
    }
    if (redaction.status === "not-covered") {
      expect(redaction.absentReason).toContain("empty");
    }
  });

  it("fails relay timing when a payload names another adapter's id", async () => {
    const plan = planConformance(capableTestAdapter, {
      relayTiming: {
        payloads: [{ name: "wrong-agent", payload: "{}", agentId: "codex" }],
      },
    });
    await expectCoveredRunToReject(theCase(plan, "relay-timing"), /must carry the registering/);
  });

  it("passes a fast stub relay and fails a deliberately slow one", async () => {
    const payload = { name: "stubbed", payload: "{}", agentId: "emit" };
    const fast = fileURLToPath(new URL("./fixtures/fast-relay.mjs", import.meta.url));
    const fastMeasurement = await measureRelayPayload(payload, {
      samples: 2,
      retries: 1,
      relayPath: fast,
    });
    expect(fastMeasurement.medianMs).toBeLessThan(RELAY_TIMING_BUDGET_MS);

    const slow = fileURLToPath(new URL("./fixtures/slow-relay.mjs", import.meta.url));
    await expect(
      measureRelayPayload(payload, {
        samples: 1,
        retries: 1,
        relayPath: slow,
      }),
    ).rejects.toThrow(/exceeds|stdout|exit/i);
  }, 30_000);

  it("measures against the fixed 50 ms budget with no override", () => {
    const plan = planConformance(capableTestAdapter, {
      relayTiming: { payloads: [{ name: "any", payload: "{}", agentId: "claude-code" }] },
    });
    const testCase = theCase(plan, "relay-timing");
    expect(testCase.status).toBe("covered");
    if (testCase.status === "covered") {
      expect(testCase.title).toContain(`${RELAY_TIMING_BUDGET_MS} ms`);
    }
  });

  it("times the real relay inside the budget on a representative payload", async () => {
    const plan = planConformance(capableTestAdapter, { relayTiming: selfcheckRelayTiming });
    const testCase = theCase(plan, "relay-timing");
    expect(testCase.status).toBe("covered");
    if (testCase.status === "covered") {
      await testCase.run();
    }
  }, 30_000);

  it("fails redaction when a forbidden secret survives in the recorded lines", async () => {
    // The leak travels through a field the recorder legitimately keeps — a
    // relative read target is persisted verbatim — so a secret smuggled
    // there survives recording and the suite must fail. (A hostile
    // meta.kind, by contrast, is correctly scrubbed by the projection, so
    // it would pass: that is the removal path the next test proves.)
    const secret = "delete-everything-module";
    const plan = planConformance(capableTestAdapter, {
      redaction: [
        {
          name: "leaking",
          events: [
            testEvent({
              id: "leak-1",
              kind: "tool.start",
              tool: {
                name: "Read",
                category: "read",
                fingerprint: "fp-leak",
                target: `src/${secret}.ts`,
              },
            }),
          ],
          forbidden: [secret],
        },
      ],
    });
    await expectCoveredRunToReject(theCase(plan, "redaction"), /survived recording/);
  });

  it("removes sensitive normalized fields from the actual recorded representation", async () => {
    const { createHash } = await import("node:crypto");
    const sha16 = (text: string): string =>
      createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
    const promptMessage = "assistant words that must never be recorded";
    const absoluteTarget = "/home/user/secret-project/deploy.sh";
    const hostileMeta = "sk-live-secret";
    const turnId = "turn_01HWxyz";
    const crafted = [
      testEvent({
        id: "craft-1",
        ts: 2000,
        receivedAt: 2000,
        agent: "claude-code",
        sessionId: "craft-session",
        kind: "turn.end",
        lifecycle: { reason: "completed", confidence: "observed", message: promptMessage },
      }),
      testEvent({
        id: "craft-2",
        ts: 2100,
        receivedAt: 2100,
        agent: "claude-code",
        sessionId: "craft-session",
        kind: "tool.start",
        tool: { name: "Read", category: "read", fingerprint: "fp-craft", target: absoluteTarget },
      }),
      testEvent({
        id: "craft-3",
        ts: 2200,
        receivedAt: 2200,
        agent: "claude-code",
        sessionId: "craft-session",
        kind: "notification",
        meta: { kind: hostileMeta, hookEvent: "FutureHookEvent", source: "teleport" },
      }),
      testEvent({
        id: "craft-4",
        ts: 2300,
        receivedAt: 2300,
        agent: "codex",
        sessionId: "craft-session",
        kind: "notification",
        meta: { kind: "unknown", turnId },
      }),
    ];
    const dumped = recordedLinesFor(crafted).join("\n");
    for (const secret of [promptMessage, absoluteTarget, hostileMeta, turnId, "craft-session"]) {
      expect(dumped).not.toContain(secret);
    }
    expect(dumped).not.toContain("FutureHookEvent");
    expect(dumped).not.toContain("teleport");
    expect(dumped).toContain('"sessionId":"s1"');
    expect(dumped).toContain(`"turnId":"${sha16(turnId)}"`);
    // `via` follows the recorder contract: a contracted wrapped-agent token
    // survives (data-driven known values only — no kit branch names an
    // agent), while free text is dropped.
    const knownVia = recordedLinesFor([
      testEvent({ id: "via-1", kind: "session.start", via: "gemini-cli" }),
    ])[0] as string;
    expect(knownVia).toContain('"via":"gemini-cli"');
    const hostileVia = "some-internal-agent build 123";
    const droppedVia = recordedLinesFor([
      testEvent({ id: "via-2", kind: "session.start", via: hostileVia }),
    ])[0] as string;
    expect(droppedVia).not.toContain(hostileVia);
    expect(dumped).not.toContain(hostileVia);
    expect(() =>
      checkRedactionCase({
        name: "crafted",
        events: crafted,
        forbidden: [promptMessage, absoluteTarget, hostileMeta, turnId, "FutureHookEvent"],
      }),
    ).not.toThrow();
    // The turn-id hash uses the same digest the recorder uses (sha256,
    // 16 hex chars): pin the projection's digest against node:crypto so a
    // drift in the self-contained implementation fails loudly instead of
    // silently recording a different token than the recorder writes.
    expect(sha16("abc")).toBe("ba7816bf8f01cfea");
    expect(recordedLinesFor(crafted)[3]).toContain(`"turnId":"${sha16(turnId)}"`);
  });

  it("retains the fork session source in the recorded projection", () => {
    // `fork` is a verified Claude SessionStart source (p1-t10): the
    // projection keeps it, while an uncontracted source stays dropped.
    const dumped = recordedLinesFor([
      testEvent({ id: "fork-1", kind: "session.start", meta: { source: "fork" } }),
    ]).join("\n");
    expect(dumped).toContain('"source":"fork"');
  });

  it("fails redaction on an empty event list instead of passing vacuously", async () => {
    const plan = planConformance(capableTestAdapter, {
      redaction: [{ name: "empty", events: [], forbidden: ["anything"] }],
    });
    await expectCoveredRunToReject(theCase(plan, "redaction"), /no events/);
  });

  it("checks the registered redaction suite for real", async () => {
    const plan = planConformance(capableTestAdapter, { redaction: selfcheckRedaction });
    const testCase = theCase(plan, "redaction");
    expect(testCase.status).toBe("covered");
    if (testCase.status === "covered") {
      await testCase.run();
    }
    expect(() =>
      checkRedactionCase({
        name: "direct",
        events: permittedEvents,
        forbidden: ["a-secret-that-never-appears"],
      }),
    ).not.toThrow();
  });

  it("gives each installer case a clean baseline even when they share one suite", async () => {
    // One adapter/suite pair, one config: the idempotence case leaves the
    // config installed, so the byte-exact case can only pass by starting
    // from the reset baseline. Before per-case reset, the second case
    // measured the first case's leftovers and failed for a correct
    // installer.
    const { adapter, suite } = installerDouble();
    const plan = planConformance(adapter, { installer: suite });
    const idempotence = theCase(plan, "installer-idempotence");
    const byteExact = theCase(plan, "byte-exact-uninstall");
    expect(idempotence.status).toBe("covered");
    expect(byteExact.status).toBe("covered");

    await suite.resetConfig();
    const pristine = await suite.readConfig();
    if (idempotence.status === "covered") {
      await idempotence.run();
    }
    expect(await suite.readConfig()).not.toBe(pristine);
    if (byteExact.status === "covered") {
      await byteExact.run();
    }
  });
});
