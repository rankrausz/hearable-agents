// packages/daemon/test/doubles.ts — the daemon's own test doubles. What this
// is for: giving ingest and the live drill an honest adapter without any real
// agent package (those land in p1-t03/p1-t04 and register with the daemon's
// registry from the composition root). What it must not do: resemble a real
// adapter beyond the claude-shaped wiring needed to exercise the raw path —
// the drill adapter maps SessionStart to session.start and preserves everything
// else as an unknown notification, which is all the daemon path needs.

import type { Adapter, MapContext } from "@hearable/adapter-kit";
import { parseClaudeShapedHook } from "@hearable/adapter-kit";
import type { AdapterCapabilities, EventKind, NormalizedEvent } from "@hearable/core";
import { NormalizedEventSchema, SCHEMA_VERSION } from "@hearable/core";

/** Capabilities a drill adapter can honestly claim for a claude-shaped source. */
export const DRILL_CAPABILITIES: AdapterCapabilities = {
  sessionEvents: true,
  turnStart: "observed",
  turnEnd: "observed",
  toolEvents: true,
  toolFailures: true,
  editEvents: true,
  execEvents: true,
  permissionEvents: true,
  questionEvents: true,
  subagents: true,
  compaction: true,
  toolKinds: "byName",
  durations: true,
};

const TOOL_KINDS: ReadonlySet<EventKind> = new Set(["tool.start", "tool.end", "tool.fail"]);

/**
 * Builds one schema-valid event from a partial raw object, filling the
 * required base fields and the tool block for tool kinds. Validates through
 * the core schema so a malformed test event fails loudly.
 */
export function drillEvent(raw: Record<string, unknown>): NormalizedEvent {
  const base: Record<string, unknown> = {
    v: SCHEMA_VERSION,
    id: "drill-e1",
    ts: 0,
    receivedAt: 0,
    agent: "claude-code",
    sessionId: "drill-s1",
    ...raw,
  };
  if (TOOL_KINDS.has(base.kind as EventKind)) {
    const tool = (base.tool as Record<string, unknown> | undefined) ?? {
      name: "Read",
      category: "read",
      fingerprint: "drill-fp",
    };
    if (base.kind === "tool.end") {
      tool.outcome = { ok: true };
    }
    if (base.kind === "tool.fail") {
      tool.outcome = { ok: false };
    }
    base.tool = tool;
  }
  return NormalizedEventSchema.parse(base) as NormalizedEvent;
}

/** A minimal session.start for a given session id, used across suites. */
export function sessionStartEvent(sessionId: string, agent = "claude-code"): NormalizedEvent {
  return drillEvent({
    id: `e-${sessionId}-start`,
    ts: 1000,
    receivedAt: 1000,
    sessionId,
    kind: "session.start",
    agent,
  });
}

/**
 * The drill adapter maps only a claude-shaped SessionStart into a
 * session.start (as a real adapter's map would, minus the classification
 * logic p1-t03 owns); every other recognised shape is preserved as an unknown
 * notification. This is the smallest honest map the raw wire form needs.
 */
export const drillClaudeShapedAdapter: Adapter = {
  id: "claude-code",
  capabilities: DRILL_CAPABILITIES,
  map(raw: unknown, ctx: MapContext): readonly NormalizedEvent[] {
    const hook = parseClaudeShapedHook(raw);
    if (hook.sessionId === null || hook.hookEventName === null) {
      return [];
    }
    if (hook.hookEventName === "SessionStart") {
      return [
        drillEvent({
          id: `drill-${hook.sessionId}-session-start`,
          ts: ctx.receivedAt,
          receivedAt: ctx.receivedAt,
          agent: "claude-code",
          sessionId: hook.sessionId,
          kind: "session.start",
        }),
      ];
    }
    if (hook.hookEventName === "SubagentStart" || hook.hookEventName === "SubagentStop") {
      const payload = raw as Record<string, unknown>;
      const childId = typeof payload.agent_id === "string" ? payload.agent_id : null;
      if (childId === null || childId === "") {
        return [];
      }
      return [
        drillEvent({
          id: `drill-${childId}-${hook.hookEventName}`,
          ts: ctx.receivedAt,
          receivedAt: ctx.receivedAt,
          agent: "claude-code",
          sessionId: childId,
          parentSessionId: hook.sessionId,
          kind: hook.hookEventName === "SubagentStart" ? "subagent.start" : "subagent.end",
        }),
      ];
    }
    return [
      drillEvent({
        id: `drill-${hook.sessionId}-${hook.hookEventName}`,
        ts: ctx.receivedAt,
        receivedAt: ctx.receivedAt,
        agent: "claude-code",
        sessionId: hook.sessionId,
        kind: "notification",
        meta: { kind: "unknown", hookEvent: hook.hookEventName },
      }),
    ];
  },
  install: async () => ({ changed: false, summary: "drill double: nothing to install" }),
  uninstall: async () => {},
  doctor: async () => [],
};
