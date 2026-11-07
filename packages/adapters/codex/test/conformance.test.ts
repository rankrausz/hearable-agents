// packages/adapters/codex/test/conformance.test.ts — the Codex
// conformance registration: every fixture payload in
// fixtures/hooks/codex/ mapped to its expected events, the installer
// checked idempotent and byte-exact against a throwaway config, the relay
// timed on this agent's own payloads, unknown events proven preserved, the
// mapped events proven free of raw-payload secrets, and emissions checked
// against the declared capabilities. Never a new category — exactly the
// seven docs/ARCHITECTURE.md demands.

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FixtureCase,
  RedactionCase,
  RelayTimingPayload,
  UnknownEventCase,
} from "@hearable/adapter-kit";
import { registerConformance } from "@hearable/adapter-kit/conformance";
import type { NormalizedEvent } from "@hearable/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapter.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "hooks",
  "codex",
);

function rawText(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

function raw(name: string): unknown {
  return JSON.parse(rawText(name));
}

const RECEIVED_AT = 1000;
const CWD = "/home/user/project";
const DAEMON_URL = "http://127.0.0.1:3939";

function ctxWith(
  pendingToolStarts: {
    sessionId: string;
    toolName: string;
    toolUseId?: string;
    startedAt: number;
  }[] = [],
) {
  return { receivedAt: RECEIVED_AT, cwd: CWD, pendingToolStarts };
}

function event(base: Record<string, unknown>): NormalizedEvent {
  return base as unknown as NormalizedEvent;
}

// Expected events, derived from the mapping contract (not from map
// itself): ids follow the adapter's deterministic id scheme, timestamps
// come from ctx.receivedAt, categories from the classify table.
function expectedFor(name: string): {
  raw: unknown;
  ctx: ReturnType<typeof ctxWith>;
  expected: readonly NormalizedEvent[];
} {
  switch (name) {
    case "session-start.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-session-start",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "s1",
            kind: "session.start",
            meta: { source: "startup" },
          }),
        ],
      };
    case "turn-start.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-628b49d96dcde97a-turn-start",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "s1",
            kind: "turn.start",
            meta: { turnId: "t1" },
          }),
        ],
      };
    case "tool-start.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-u1-tool-start",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "s1",
            kind: "tool.start",
            tool: {
              name: "Bash",
              category: "exec",
              fingerprint: "71a96ef8f6456ece",
              execKind: "test",
              target: "pytest",
            },
            meta: { turnId: "t1" },
          }),
        ],
      };
    case "tool-end.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-u1-tool-end",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "s1",
            kind: "tool.end",
            tool: {
              name: "Bash",
              category: "exec",
              fingerprint: "71a96ef8f6456ece",
              execKind: "test",
              target: "pytest",
              outcome: { ok: true, exitCode: 0 },
            },
            meta: { turnId: "t1" },
          }),
        ],
      };
    case "tool-fail.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-u2-tool-fail",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "s1",
            kind: "tool.fail",
            tool: {
              name: "Bash",
              category: "exec",
              fingerprint: "71a96ef8f6456ece",
              execKind: "test",
              target: "pytest",
              outcome: { ok: false, exitCode: 1, errorClass: "other" },
            },
            meta: { turnId: "t1" },
          }),
        ],
      };
    case "permission-request.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-628b49d96dcde97a-permission-request",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "s1",
            kind: "permission.request",
            lifecycle: { reason: "permission", confidence: "inferred" },
            tool: {
              name: "Bash",
              category: "exec",
              fingerprint: "a1704edd6c904d5f",
              execKind: "other",
              target: "rm",
            },
            meta: { turnId: "t1" },
          }),
        ],
      };
    case "turn-end-completed.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-628b49d96dcde97a-turn-end",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "s1",
            kind: "turn.end",
            lifecycle: { reason: "completed", confidence: "inferred" },
            meta: { turnId: "t1" },
          }),
        ],
      };
    case "turn-end-question.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-628b49d96dcde97a-turn-end",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "s1",
            kind: "turn.end",
            lifecycle: { reason: "question", confidence: "inferred" },
            meta: { turnId: "t1" },
          }),
        ],
      };
    case "interrupt.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-628b49d96dcde97a-turn-end-cancelled",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "s1",
            kind: "turn.end",
            lifecycle: { reason: "cancelled", confidence: "observed" },
          }),
        ],
      };
    case "subagent-start.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-sub1-subagent-start",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "sub1",
            parentSessionId: "s1",
            kind: "subagent.start",
            meta: { agentType: "Explore" },
          }),
        ],
      };
    case "subagent-stop.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-sub1-subagent-end",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "sub1",
            parentSessionId: "s1",
            kind: "subagent.end",
            meta: { agentType: "Explore" },
          }),
        ],
      };
    case "compaction.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-compaction",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "s1",
            kind: "compaction",
            meta: { trigger: "manual" },
          }),
        ],
      };
    case "compaction-post.json":
      return {
        raw: raw(name),
        ctx: ctxWith(),
        expected: [
          event({
            v: 1,
            id: "s1-compaction",
            ts: RECEIVED_AT,
            receivedAt: RECEIVED_AT,
            agent: "codex",
            sessionId: "s1",
            kind: "compaction",
            meta: { trigger: "auto" },
          }),
        ],
      };
    case "session-end-ignored.json":
      return { raw: raw(name), ctx: ctxWith(), expected: [] };
    default:
      throw new Error(`no expectation for fixture ${name}`);
  }
}

const FIXTURE_NAMES = [
  "session-start.json",
  "turn-start.json",
  "tool-start.json",
  "tool-end.json",
  "tool-fail.json",
  "permission-request.json",
  "turn-end-completed.json",
  "turn-end-question.json",
  "interrupt.json",
  "subagent-start.json",
  "subagent-stop.json",
  "compaction.json",
  "compaction-post.json",
  "session-end-ignored.json",
];

const fixtures: FixtureCase[] = FIXTURE_NAMES.map((name) => {
  const { raw: payload, ctx, expected } = expectedFor(name);
  return { name: name.replace(/\.json$/, ""), raw: payload, ctx, expected };
});

const unknownEvents: UnknownEventCase[] = [
  { name: "unknown-event", raw: raw("unknown-event.json"), ctx: ctxWith() },
];

const emissions: readonly NormalizedEvent[] = fixtures.flatMap((fixture) => [...fixture.expected]);

// The relay-timing inputs: two real Codex payloads — a turn start and a
// tool call — through the real hearable-hook binary, as fixture file bytes.
const relayTiming: { payloads: RelayTimingPayload[] } = {
  payloads: [
    { name: "turn-start", payload: rawText("turn-start.json"), agentId: "codex" },
    { name: "tool-start", payload: rawText("tool-start.json"), agentId: "codex" },
  ],
};

// The redaction inputs: every mapped fixture event with the raw-payload
// secrets they must not leak — the user prompt text, the transcript and
// rollout paths, tool I/O, the final assistant messages, the permission
// command, and the working directory — each named exactly as EVENTS.md
// §Redaction forbids it. Two families stay out of the forbidden list on
// purpose, and the exclusion is itself the contract: the fixture session
// id ("s1") is re-keyed by the recorder and would trivially collide with
// real recorded content, so the check proves secrecy of payload text, not
// of the re-keyed identity. Turn ids get their own hostile-value case below
// because they must be hashed in both metadata and mapped event identity.
const redaction: RedactionCase[] = (() => {
  const allEvents = fixtures.flatMap((fixture) => [...fixture.expected]);
  const payloadOf = (name: string): Record<string, unknown> =>
    JSON.parse(rawText(name)) as Record<string, unknown>;
  const stringOf = (name: string, key: string): string => {
    const value = payloadOf(name)[key];
    return typeof value === "string" ? value : "";
  };
  const secrets = [
    stringOf("turn-start.json", "prompt"),
    stringOf("turn-start.json", "transcript_path"),
    JSON.stringify(payloadOf("tool-start.json").tool_input ?? {}),
    JSON.stringify(payloadOf("tool-end.json").tool_response ?? {}),
    JSON.stringify(payloadOf("tool-fail.json").tool_response ?? {}),
    JSON.stringify(payloadOf("permission-request.json").tool_input ?? {}),
    stringOf("turn-end-completed.json", "last_assistant_message"),
    stringOf("turn-end-question.json", "last_assistant_message"),
    stringOf("turn-start.json", "cwd"),
  ].filter((text) => text !== "");
  const hostileMetaValues = ["codex_probe_secret_kind", "FutureProbeHook"];
  const hostileMetaKeys = ["permission_mode_probe", "model_probe"];
  const lifecycleMessage = "codex assistant message that must never be recorded";
  const sensitiveTurnId = "codex_probe_secret_turn";
  const sensitiveTurnEvents = [
    "turn-start.json",
    "permission-request.json",
    "turn-end-completed.json",
    "interrupt.json",
  ].flatMap((name) =>
    codexAdapter.map({ ...payloadOf(name), turn_id: sensitiveTurnId }, ctxWith()),
  );
  return [
    { name: "prompts, paths and tool payloads", events: allEvents, forbidden: secrets },
    {
      name: "lifecycle.message and non-allowlisted meta",
      events: [
        ...allEvents,
        event({
          v: 1,
          id: "s1-probe-turn-end",
          ts: RECEIVED_AT,
          receivedAt: RECEIVED_AT,
          agent: "codex",
          sessionId: "s1",
          kind: "turn.end",
          lifecycle: {
            reason: "completed",
            confidence: "observed",
            message: lifecycleMessage,
          },
        }),
        event({
          v: 1,
          id: "s1-probe-notification",
          ts: RECEIVED_AT,
          receivedAt: RECEIVED_AT,
          agent: "codex",
          sessionId: "s1",
          kind: "notification",
          meta: {
            kind: hostileMetaValues[0],
            hookEvent: hostileMetaValues[1],
            permission_mode_probe: hostileMetaValues[0],
            model_probe: hostileMetaValues[1],
          },
        }),
      ],
      forbidden: [lifecycleMessage, ...hostileMetaValues, ...hostileMetaKeys],
    },
    {
      name: "turn ids are hashed in lifecycle event identity and metadata",
      events: sensitiveTurnEvents,
      forbidden: [sensitiveTurnId],
    },
  ];
})();

const PRISTINE = `{\n  "description": "user content",\n  "hooks": {\n    "Stop": []\n  }\n}\n`;

let configDir = "";
const installerOpts = { configDir: "", daemonUrl: DAEMON_URL };

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), "codex-conformance-"));
  installerOpts.configDir = configDir;
});

afterAll(async () => {
  if (configDir !== "") {
    await rm(configDir, { recursive: true, force: true });
  }
});

registerConformance(codexAdapter, {
  fixtures,
  installer: {
    opts: installerOpts,
    resetConfig: async () => {
      await writeFile(join(configDir, "hooks.json"), PRISTINE, "utf8");
    },
    readConfig: async () => readFile(join(configDir, "hooks.json"), "utf8"),
  },
  relayTiming,
  unknownEvents,
  redaction,
  emissions,
});

describe("codex conformance installer wiring", () => {
  it("points the runner at the throwaway dir", async () => {
    expect(installerOpts.configDir.length).toBeGreaterThan(0);
  });
});
