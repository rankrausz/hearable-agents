// packages/adapter-kit/src/conformance/plan.ts — the pure brain of the
// conformance runner: turns an adapter plus its suites into the exact list of
// cases a run consists of, each either covered (with a real, runnable check)
// or explicitly not covered (with a plain-language reason). What this is
// for: making the runner's behaviour testable without a test framework, and
// making an absent suite impossible to miss — every category always produces
// at least one case. What it must not do: import a test framework, perform
// I/O, or invent coverage; a category with no suite is reported as absent,
// never silently passed.

import type { NormalizedEvent } from "@hearable/core";
import { NormalizedEventSchema } from "@hearable/core";
import type { Adapter } from "../adapter.js";
import { findCapabilityViolations } from "../capability-honesty.js";
import { checkRedactionCase } from "./redaction.js";
import { measureRelayPayload } from "./relay-timing.js";
import {
  CATEGORY_TITLES,
  type ConformanceCategory,
  type ConformanceSuites,
  type InstallerSuite,
  RELAY_TIMING_BUDGET_MS,
  type RedactionSuite,
  type RelayTimingSuite,
} from "./suites.js";

export type ConformanceCase =
  | {
      /** Which non-negotiable category this case belongs to. */
      readonly category: ConformanceCategory;

      /** The human title, shown in the test report. */
      readonly title: string;

      readonly status: "covered";

      /**
       * The real check. Throws with a plain-language message when the
       * adapter violates the contract.
       */
      readonly run: () => void | Promise<void>;
    }
  | {
      readonly category: ConformanceCategory;
      readonly title: string;

      readonly status: "not-covered";

      /**
       * Why this category has nothing to check right now; shown in the case
       * title and the warning the runner prints.
       */
      readonly absentReason: string;
    };

function notCovered(category: ConformanceCategory, absentReason: string): ConformanceCase {
  return { category, title: CATEGORY_TITLES[category], status: "not-covered", absentReason };
}

// Structural equality over plain data. NormalizedEvents are JSON-shaped
// (objects, arrays, primitives only), so a small recursive comparison is
// honest here; a dependency for this would not be.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  return keysA.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

// The daemon validates everything at its boundary, so conformance validates
// the same way: an adapter whose map emits events the schema rejects fails
// here with the exact issues, before any comparison happens.
function validateAgainstSchema(events: readonly NormalizedEvent[], what: string): void {
  for (const event of events) {
    const result = NormalizedEventSchema.safeParse(event);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(
        `${what}: an emitted event does not satisfy the normalized event schema (${issues})`,
      );
    }
  }
}

function fixtureCases(adapter: Adapter, suites: ConformanceSuites): readonly ConformanceCase[] {
  const fixtures = suites.fixtures;
  if (fixtures === undefined) {
    return [
      notCovered(
        "fixture-mapping",
        "no fixture payloads were supplied — register a fixtures suite so every payload is checked against its expected events",
      ),
    ];
  }
  if (fixtures.length === 0) {
    return [
      notCovered(
        "fixture-mapping",
        "the fixtures suite is empty — capture payloads from the installed agent so the mapping has something to prove",
      ),
    ];
  }
  return fixtures.map((fixture) => ({
    category: "fixture-mapping" as const,
    title: `fixture "${fixture.name}" maps to the expected events`,
    status: "covered" as const,
    run: () => {
      const events = adapter.map(fixture.raw, fixture.ctx);
      validateAgainstSchema(events, `fixture "${fixture.name}"`);
      if (!deepEqual(events, fixture.expected)) {
        throw new Error(
          `fixture "${fixture.name}": adapter "${adapter.id}" mapped the payload to different events than the expectation — check the fixture's ctx (receivedAt, cwd, pendingToolStarts) and the expected events`,
        );
      }
    },
  }));
}

function installerCases(adapter: Adapter, suite: InstallerSuite): readonly ConformanceCase[] {
  return [
    {
      category: "installer-idempotence" as const,
      title: CATEGORY_TITLES["installer-idempotence"],
      status: "covered" as const,
      run: async () => {
        await suite.resetConfig();
        const first = await adapter.install(suite.opts);
        if (!first.changed) {
          throw new Error(
            "the first install into the reset baseline reported changed: false — resetConfig must restore the pristine, never-installed config before each installer case",
          );
        }
        const afterFirst = await suite.readConfig();
        const second = await adapter.install(suite.opts);
        const afterSecond = await suite.readConfig();
        if (second.changed) {
          throw new Error("the second install reported changed: true — install must be idempotent");
        }
        if (afterFirst !== afterSecond) {
          throw new Error(
            "the second install changed the config bytes — installing twice must leave the config exactly as the first install left it",
          );
        }
      },
    },
    {
      category: "byte-exact-uninstall" as const,
      title: CATEGORY_TITLES["byte-exact-uninstall"],
      status: "covered" as const,
      run: async () => {
        await suite.resetConfig();
        const before = await suite.readConfig();
        await adapter.install(suite.opts);
        await adapter.uninstall(suite.opts);
        const after = await suite.readConfig();
        if (after !== before) {
          throw new Error(
            `uninstall did not restore the config byte-for-byte — before install it was ${before.length} bytes, after uninstall it is ${after.length} bytes`,
          );
        }
      },
    },
  ];
}

function relayTimingCases(adapter: Adapter, suites: ConformanceSuites): readonly ConformanceCase[] {
  const timing = suites.relayTiming;
  if (timing === undefined) {
    return [
      notCovered(
        "relay-timing",
        "no relay-timing payloads were supplied — register a relayTiming suite with this agent's hook payloads so wall time through the real hearable-hook binary is measured against the 50 ms budget",
      ),
    ];
  }
  if (timing.payloads.length === 0) {
    return [
      notCovered(
        "relay-timing",
        "the relayTiming suite is empty — supply this agent's hook payloads so the relay measurement has something to time",
      ),
    ];
  }
  return timing.payloads.map((payload) => ({
    category: "relay-timing" as const,
    title: `relay delivers "${payload.name}" inside the ${RELAY_TIMING_BUDGET_MS} ms budget`,
    status: "covered" as const,
    run: () => relayTimingRun(adapter, timing, payload.name),
  }));
}

// The case body behind one covered relay-timing case. The payload's own
// --agent value is what the relay sends in the x-hearable-agent header, so
// the case first proves the suite is honest: a payload that would route to
// another adapter's map fails with a plain-language message instead of
// measuring the wrong delivery path.
async function relayTimingRun(
  adapter: Adapter,
  timing: RelayTimingSuite,
  payloadName: string,
): Promise<void> {
  const payload = timing.payloads.find((candidate) => candidate.name === payloadName);
  if (payload === undefined) {
    throw new Error(
      `relay-timing payload "${payloadName}" is missing from its own suite — register the payload so the measurement has something to time`,
    );
  }
  if (payload.agentId !== adapter.id) {
    throw new Error(
      `relay-timing payload "${payload.name}" names adapter "${payload.agentId}" but the suite runs for adapter "${adapter.id}" — payloads must carry the registering adapter's own id so the relay header routes to its map`,
    );
  }
  const measurement = await measureRelayPayload(payload, {
    samples: timing.samples,
    retries: timing.retries,
  });
  if (measurement.medianMs >= RELAY_TIMING_BUDGET_MS) {
    throw new Error(
      `relay-timing payload "${payload.name}": median wall time ${measurement.medianMs.toFixed(1)} ms per event is not inside the ${RELAY_TIMING_BUDGET_MS} ms budget`,
    );
  }
}

function redactionCases(suites: ConformanceSuites): readonly ConformanceCase[] {
  const redaction = suites.redaction;
  if (redaction === undefined) {
    return [
      notCovered(
        "redaction",
        "no redaction cases were supplied — register a redaction suite with this adapter's mapped events and the secrets they must not leak",
      ),
    ];
  }
  if (redaction.length === 0) {
    return [
      notCovered(
        "redaction",
        "the redaction suite is empty — register a case per secret family (prompts, absolute paths, tool I/O, lifecycle.message, non-allowlisted meta) so the recorder contract is proven",
      ),
    ];
  }
  return redaction.map((redactionCase) => ({
    category: "redaction" as const,
    title: `redaction case "${redactionCase.name}" keeps its secrets out of the recorded lines`,
    status: "covered" as const,
    run: () => redactionRun(redaction, redactionCase.name),
  }));
}

function redactionRun(redaction: RedactionSuite, caseName: string): void {
  const found = redaction.find((candidate) => candidate.name === caseName);
  if (found === undefined) {
    throw new Error(
      `redaction case "${caseName}" is missing from its own suite — register the case so there is something to check`,
    );
  }
  checkRedactionCase(found);
}

function unknownEventCases(
  adapter: Adapter,
  suites: ConformanceSuites,
): readonly ConformanceCase[] {
  const unknownEvents = suites.unknownEvents;
  if (unknownEvents === undefined) {
    return [
      notCovered(
        "unknown-event-preservation",
        "no unknown-event payloads were supplied — register an unknownEvents suite so preservation is proven, not assumed",
      ),
    ];
  }
  if (unknownEvents.length === 0) {
    return [
      notCovered(
        "unknown-event-preservation",
        "the unknownEvents suite is empty — capture a payload the adapter does not know so preservation is proven, not assumed",
      ),
    ];
  }
  return unknownEvents.map((payload) => ({
    category: "unknown-event-preservation" as const,
    title: `unknown-event payload "${payload.name}" is preserved as a notification`,
    status: "covered" as const,
    run: () => {
      const events = adapter.map(payload.raw, payload.ctx);
      validateAgainstSchema(events, `unknown-event payload "${payload.name}"`);
      const preserved = events.some(
        (event) => event.kind === "notification" && event.meta.kind === "unknown",
      );
      if (events.length === 0 || !preserved) {
        throw new Error(
          `unknown-event payload "${payload.name}" was not preserved — map an event the adapter does not know to a notification with meta.kind "unknown" and never drop it`,
        );
      }
    },
  }));
}

function capabilityCases(adapter: Adapter, suites: ConformanceSuites): readonly ConformanceCase[] {
  const emissions = suites.emissions;
  const absent = (reason: string) => [notCovered("capability-honesty", reason)];
  if (emissions === undefined) {
    return absent(
      "no emitted events were supplied — register an emissions suite (the events the adapter produces, typically from its fixtures) so they can be checked against its capabilities",
    );
  }
  if (emissions.length === 0) {
    return absent(
      "the emissions suite is empty — supply the events the adapter produces so they can be checked against its capabilities",
    );
  }
  return [
    {
      category: "capability-honesty" as const,
      title: CATEGORY_TITLES["capability-honesty"],
      status: "covered" as const,
      run: () => {
        validateAgainstSchema(emissions, "the emissions suite");
        const violations = findCapabilityViolations(adapter.capabilities, emissions);
        if (violations.length > 0) {
          const details = violations.map((found) => found.message).join("; ");
          throw new Error(`adapter "${adapter.id}" emits kinds its capabilities deny — ${details}`);
        }
      },
    },
  ];
}

/**
 * Plans the conformance run for one adapter: one or more cases per
 * non-negotiable category, covered where a suite was supplied and explicitly
 * not covered where it was not. Pure — safe to call anywhere, including
 * outside a test runner, to inspect what a run would check.
 */
export function planConformance(
  adapter: Adapter,
  suites: ConformanceSuites = {},
): readonly ConformanceCase[] {
  const installer =
    suites.installer === undefined
      ? [
          notCovered(
            "installer-idempotence",
            "no installer suite was supplied — register one pointing at a throwaway copy of the agent config so install is proven idempotent",
          ),
          notCovered(
            "byte-exact-uninstall",
            "no installer suite was supplied — register one pointing at a throwaway copy of the agent config so uninstall is proven byte-exact",
          ),
        ]
      : installerCases(adapter, suites.installer);

  // Relay-timing and redaction are covered where the adapter registers
  // their suites and visibly not covered where it does not.
  return [
    ...fixtureCases(adapter, suites),
    ...installer,
    ...relayTimingCases(adapter, suites),
    ...unknownEventCases(adapter, suites),
    ...redactionCases(suites),
    ...capabilityCases(adapter, suites),
  ];
}
