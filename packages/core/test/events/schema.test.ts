// packages/core/test/events/schema.test.ts — behaviour tests for the
// normalized event schema in src/events/schema.ts: every event kind
// round-trips through JSON unchanged, the per-kind required fields of
// docs/EVENTS.md §Kinds are enforced, `meta` stays flat, and the schema
// version literal is the single source of truth. These tests must stay
// inside core and rely on no adapter.

import { describe, expect, it } from "vitest";

import {
  type EventKind,
  EventKindSchema,
  type NormalizedEvent,
  NormalizedEventSchema,
  SCHEMA_VERSION,
} from "../../src/events/schema.js";

const EVENT_TIME = 1_757_000_000_000;

const baseEvent = {
  v: SCHEMA_VERSION,
  id: "01JD0EXAMPLE0ULID0KIND0P0T02",
  ts: EVENT_TIME,
  receivedAt: EVENT_TIME + 1,
  agent: "claude-code",
  sessionId: "s1",
} as const;

// One valid event per kind. The mapped annotation fails to compile if a kind
// gains no example, and `Extract` pins each example to the exact union member
// the schema infers for that kind, so the fixtures cannot drift from the
// contract.
const exampleEvents: { [K in EventKind]: Extract<NormalizedEvent, { kind: K }> } = {
  "session.start": { ...baseEvent, kind: "session.start", meta: { source: "startup" } },
  "session.end": { ...baseEvent, kind: "session.end" },
  "turn.start": { ...baseEvent, kind: "turn.start" },
  "turn.end": {
    ...baseEvent,
    kind: "turn.end",
    lifecycle: { reason: "completed", confidence: "observed", message: "Done, two files changed." },
  },
  "tool.start": {
    ...baseEvent,
    kind: "tool.start",
    tool: { name: "Read", category: "read", fingerprint: "f00d", target: "src/index.ts" },
  },
  "tool.end": {
    ...baseEvent,
    kind: "tool.end",
    tool: {
      name: "Bash",
      category: "exec",
      execKind: "test",
      fingerprint: "f00d",
      target: "pnpm test",
      durationMs: 1234,
      outcome: { ok: true, exitCode: 0, outputChars: 4567 },
    },
  },
  "tool.fail": {
    ...baseEvent,
    kind: "tool.fail",
    tool: {
      name: "Bash",
      category: "exec",
      execKind: "test",
      fingerprint: "f00d",
      durationMs: 987,
      outcome: { ok: false, exitCode: 1, errorClass: "test_failure", outputChars: 8901 },
    },
  },
  "permission.request": {
    ...baseEvent,
    kind: "permission.request",
    lifecycle: { reason: "permission", confidence: "observed" },
  },
  "question.asked": {
    ...baseEvent,
    kind: "question.asked",
    lifecycle: { reason: "question", confidence: "observed", message: "Which database?" },
  },
  notification: {
    ...baseEvent,
    kind: "notification",
    meta: { kind: "unknown", hookEvent: "NewThing", count: 2, useful: true },
  },
  "subagent.start": {
    ...baseEvent,
    kind: "subagent.start",
    sessionId: "sub-1",
    parentSessionId: "s1",
  },
  "subagent.end": { ...baseEvent, kind: "subagent.end", sessionId: "sub-1", parentSessionId: "s1" },
  compaction: { ...baseEvent, kind: "compaction" },
  "agent.report": { ...baseEvent, kind: "agent.report" },
};

function omit(value: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  Object.assign(copy, value);
  delete copy[key];
  return copy;
}

function expectRejected(payload: unknown): void {
  const result = NormalizedEventSchema.safeParse(payload);
  expect(result.success).toBe(false);
}

describe("NormalizedEvent", () => {
  describe("round-trip through JSON", () => {
    it.each(EventKindSchema.options)("preserves %s unchanged", (kind) => {
      const event = exampleEvents[kind];
      const parsed = NormalizedEventSchema.parse(JSON.parse(JSON.stringify(event)));
      expect(parsed).toEqual(event);
    });
  });

  describe("per-kind required fields (docs/EVENTS.md §Kinds)", () => {
    it("rejects turn.end without lifecycle", () => {
      expectRejected(omit(exampleEvents["turn.end"], "lifecycle"));
    });

    it("rejects turn.end with a lifecycle that has no reason", () => {
      expectRejected({ ...exampleEvents["turn.end"], lifecycle: { confidence: "observed" } });
    });

    it("rejects tool.start without tool", () => {
      expectRejected(omit(exampleEvents["tool.start"], "tool"));
    });

    it("rejects tool.end without tool", () => {
      expectRejected(omit(exampleEvents["tool.end"], "tool"));
    });

    it("rejects tool.fail without tool", () => {
      expectRejected(omit(exampleEvents["tool.fail"], "tool"));
    });

    it("rejects tool.end without outcome", () => {
      expectRejected({
        ...exampleEvents["tool.end"],
        tool: omit(exampleEvents["tool.end"].tool, "outcome"),
      });
    });

    it("rejects tool.end with outcome.ok = false", () => {
      expectRejected({
        ...exampleEvents["tool.end"],
        tool: { ...exampleEvents["tool.end"].tool, outcome: { ok: false, exitCode: 1 } },
      });
    });

    it("rejects tool.fail without outcome", () => {
      expectRejected({
        ...exampleEvents["tool.fail"],
        tool: omit(exampleEvents["tool.fail"].tool, "outcome"),
      });
    });

    it("rejects tool.fail with outcome.ok = true", () => {
      expectRejected({
        ...exampleEvents["tool.fail"],
        tool: { ...exampleEvents["tool.fail"].tool, outcome: { ok: true, exitCode: 0 } },
      });
    });

    it("rejects subagent.start without parentSessionId", () => {
      expectRejected(omit(exampleEvents["subagent.start"], "parentSessionId"));
    });

    it("rejects subagent.end without parentSessionId", () => {
      expectRejected(omit(exampleEvents["subagent.end"], "parentSessionId"));
    });

    it("rejects notification without meta", () => {
      expectRejected(omit(exampleEvents.notification, "meta"));
    });

    it("rejects notification whose meta has no kind", () => {
      expectRejected({ ...exampleEvents.notification, meta: { hookEvent: "NewThing" } });
    });

    it("rejects permission.request whose lifecycle reason is not permission", () => {
      expectRejected({
        ...exampleEvents["permission.request"],
        lifecycle: { reason: "completed", confidence: "observed" },
      });
    });

    it("rejects question.asked whose lifecycle reason is not question", () => {
      expectRejected({
        ...exampleEvents["question.asked"],
        lifecycle: { reason: "completed", confidence: "observed" },
      });
    });
  });

  describe("meta", () => {
    it("accepts flat string, number and boolean values", () => {
      const result = NormalizedEventSchema.safeParse({
        ...exampleEvents["session.start"],
        meta: { source: "resume", files: 3, clean: true },
      });
      expect(result.success).toBe(true);
    });

    it("rejects nested objects in meta", () => {
      expectRejected({ ...exampleEvents["session.start"], meta: { deep: { nope: 1 } } });
    });

    it("rejects arrays in meta", () => {
      expectRejected({ ...exampleEvents["session.start"], meta: { list: [1, 2] } });
    });

    it("rejects null in meta", () => {
      expectRejected({ ...exampleEvents["session.start"], meta: { nothing: null } });
    });

    it("rejects a meta that is not an object", () => {
      expectRejected({ ...exampleEvents["session.start"], meta: ["kind"] });
    });
  });

  describe("schema version", () => {
    it("exports 1 and enforces it as the event literal", () => {
      expect(SCHEMA_VERSION).toBe(1);
      expectRejected({ ...exampleEvents["session.start"], v: SCHEMA_VERSION + 1 });
    });
  });

  describe("base shape (docs/EVENTS.md §Shape)", () => {
    it("rejects an event with an unknown top-level key", () => {
      expectRejected({ ...exampleEvents["session.start"], unexpected: true });
    });

    it("rejects an event without receivedAt", () => {
      expectRejected(omit(exampleEvents["session.start"], "receivedAt"));
    });

    it("rejects an event without an id", () => {
      expectRejected(omit(exampleEvents["session.start"], "id"));
    });

    it("rejects an unknown event kind", () => {
      expectRejected({ ...exampleEvents["session.start"], kind: "turn.middle" });
    });

    it("rejects an unknown agent id", () => {
      expectRejected({ ...exampleEvents["session.start"], agent: "gemini-cli" });
    });
  });
});
