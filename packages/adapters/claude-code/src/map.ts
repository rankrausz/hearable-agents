// packages/adapters/claude-code/src/map.ts — the pure hook-payload to
// normalized-events mapping, implementing docs/EVENTS.md §Claude Code mapping
// row by row. What this is for: being the reference every later adapter is
// measured against — the smallest mapping the table supports, with each
// judgement call recorded in the package README. What it must not do:
// classify tools itself (it delegates to the p1-t01 classifier), invent a
// field the payload did not carry, throw on unknown input, or keep state.

import type { MapContext } from "@hearable/adapter-kit";
import { findToolStart, parseClaudeShapedHook, readLastToolName } from "@hearable/adapter-kit";
import type { NormalizedEvent } from "@hearable/core";
import { classify, SCHEMA_VERSION } from "@hearable/core";
import { isDuplicatePermissionPrompt } from "./dedup.js";
import { errorClassFor } from "./error-class.js";
import { isRecord, numberField, stringField } from "./fields.js";
import { eventId } from "./ids.js";
import { isQuestionTool, stopReason } from "./turn-reason.js";

type Base = {
  sessionId: string;
  receivedAt: number;
  sequence: number;
};

function base(sessionId: string, receivedAt: number, sequence: number): Base {
  return { sessionId, receivedAt, sequence };
}

/** The effective session for this payload: a subagent id when present. */
function effectiveSession(raw: Record<string, unknown>, sessionId: string): string {
  const agentId = stringField(raw, "agent_id");
  return agentId !== null && agentId !== "" ? agentId : sessionId;
}

/** parentSessionId exactly when the payload fires inside a subagent. */
function parentOf(raw: Record<string, unknown>, sessionId: string): string | undefined {
  const agentId = stringField(raw, "agent_id");
  return agentId !== null && agentId !== "" ? sessionId : undefined;
}

function eventTime(raw: Record<string, unknown>, receivedAt: number): number {
  const timestamp = numberField(raw, "timestamp");
  return timestamp !== null ? timestamp : receivedAt;
}

function notification(
  hookEventName: string,
  baseArgs: Base,
  eventTimeMs: number,
  meta: Record<string, string | number | boolean>,
  parentSessionId?: string,
): NormalizedEvent {
  const event = {
    v: SCHEMA_VERSION,
    id: eventId(baseArgs.sessionId, hookEventName, baseArgs.sequence),
    ts: eventTimeMs,
    receivedAt: baseArgs.receivedAt,
    agent: "claude-code",
    sessionId: baseArgs.sessionId,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    kind: "notification",
    meta,
  } as const;
  return event as unknown as NormalizedEvent;
}

function mapSessionStart(
  raw: Record<string, unknown>,
  sessionId: string,
  ctx: MapContext,
  hookEventName: string,
): readonly NormalizedEvent[] {
  const source = stringField(raw, "source");
  const ts = eventTime(raw, ctx.receivedAt);
  return [
    {
      v: SCHEMA_VERSION,
      id: eventId(sessionId, hookEventName, 0),
      ts,
      receivedAt: ctx.receivedAt,
      agent: "claude-code",
      sessionId,
      kind: "session.start",
      ...(source !== null ? { meta: { source } } : {}),
    } as unknown as NormalizedEvent,
  ];
}

function mapSessionEnd(
  sessionId: string,
  ctx: MapContext,
  hookEventName: string,
  raw: Record<string, unknown>,
): readonly NormalizedEvent[] {
  return [
    {
      v: SCHEMA_VERSION,
      id: eventId(sessionId, hookEventName, 0),
      ts: eventTime(raw, ctx.receivedAt),
      receivedAt: ctx.receivedAt,
      agent: "claude-code",
      sessionId,
      kind: "session.end",
    } as unknown as NormalizedEvent,
  ];
}

function mapTurnStart(
  sessionId: string,
  ctx: MapContext,
  hookEventName: string,
  raw: Record<string, unknown>,
): readonly NormalizedEvent[] {
  return [
    {
      v: SCHEMA_VERSION,
      id: eventId(sessionId, hookEventName, 0),
      ts: eventTime(raw, ctx.receivedAt),
      receivedAt: ctx.receivedAt,
      agent: "claude-code",
      sessionId,
      kind: "turn.start",
    } as unknown as NormalizedEvent,
  ];
}

function mapPreToolUse(
  raw: Record<string, unknown>,
  hook: { toolName: string | null; toolInput: Readonly<Record<string, unknown>> | null },
  rootSessionId: string,
  ctx: MapContext,
  hookEventName: string,
): readonly NormalizedEvent[] {
  const sessionId = effectiveSession(raw, rootSessionId);
  const parent = parentOf(raw, rootSessionId);
  const toolName = hook.toolName;
  if (toolName === null || toolName === "") {
    return [
      notification(
        hookEventName,
        base(sessionId, ctx.receivedAt, 0),
        eventTime(raw, ctx.receivedAt),
        { kind: "unknown", hookEvent: hookEventName },
        parent,
      ),
    ];
  }
  if (isQuestionTool(toolName)) {
    // A question tool call is both a question and a tool call: the
    // question.asked carries the observed question for the engine, and the
    // tool.start threads the pending question-tool fact through the caller's
    // context so a later Stop can observe it (map keeps no state of its
    // own). Distinct sequence numbers keep the two event ids distinct.
    const ts = eventTime(raw, ctx.receivedAt);
    const questionClassification = classify({
      agent: "claude-code",
      toolName,
      toolInput: (hook.toolInput ?? {}) as unknown,
      cwd: ctx.cwd,
    });
    return [
      {
        v: SCHEMA_VERSION,
        id: eventId(sessionId, hookEventName, 0),
        ts,
        receivedAt: ctx.receivedAt,
        agent: "claude-code",
        sessionId,
        ...(parent !== undefined ? { parentSessionId: parent } : {}),
        kind: "question.asked",
        lifecycle: { reason: "question", confidence: "observed" },
      } as unknown as NormalizedEvent,
      {
        v: SCHEMA_VERSION,
        id: eventId(sessionId, hookEventName, 1),
        ts,
        receivedAt: ctx.receivedAt,
        agent: "claude-code",
        sessionId,
        ...(parent !== undefined ? { parentSessionId: parent } : {}),
        kind: "tool.start",
        tool: {
          name: toolName,
          category: questionClassification.category,
          ...(questionClassification.execKind !== undefined
            ? { execKind: questionClassification.execKind }
            : {}),
          fingerprint: questionClassification.fingerprint,
          ...(questionClassification.target !== undefined
            ? { target: questionClassification.target }
            : {}),
        },
      } as unknown as NormalizedEvent,
    ];
  }
  const classification = classify({
    agent: "claude-code",
    toolName,
    toolInput: (hook.toolInput ?? {}) as unknown,
    cwd: ctx.cwd,
  });
  return [
    {
      v: SCHEMA_VERSION,
      id: eventId(sessionId, hookEventName, 0),
      ts: eventTime(raw, ctx.receivedAt),
      receivedAt: ctx.receivedAt,
      agent: "claude-code",
      sessionId,
      ...(parent !== undefined ? { parentSessionId: parent } : {}),
      kind: "tool.start",
      tool: {
        name: toolName,
        category: classification.category,
        ...(classification.execKind !== undefined ? { execKind: classification.execKind } : {}),
        fingerprint: classification.fingerprint,
        ...(classification.target !== undefined ? { target: classification.target } : {}),
      },
    } as unknown as NormalizedEvent,
  ];
}

function mapToolEnd(
  raw: Record<string, unknown>,
  hook: { toolName: string | null; toolInput: Readonly<Record<string, unknown>> | null },
  rootSessionId: string,
  ctx: MapContext,
  hookEventName: string,
  failed: boolean,
): readonly NormalizedEvent[] {
  const sessionId = effectiveSession(raw, rootSessionId);
  const parent = parentOf(raw, rootSessionId);
  const toolName = hook.toolName;
  if (toolName === null || toolName === "") {
    return [
      notification(
        hookEventName,
        base(sessionId, ctx.receivedAt, 0),
        eventTime(raw, ctx.receivedAt),
        { kind: "unknown", hookEvent: hookEventName },
        parent,
      ),
    ];
  }
  const classification = classify({
    agent: "claude-code",
    toolName,
    toolInput: (hook.toolInput ?? {}) as unknown,
    cwd: ctx.cwd,
  });
  const toolUseId = stringField(raw, "tool_use_id");
  // An explicit tool-call id that matches nothing matches nothing: falling
  // back to the first same-name start would pair parallel same-name tools
  // wrongly, so an ID miss yields no duration rather than a wrong one. Only
  // payloads with no id use FIFO-per-name via the kit helper.
  const pending =
    toolUseId !== null
      ? ctx.pendingToolStarts.find(
          (start) => start.sessionId === sessionId && start.toolUseId === toolUseId,
        )
      : findToolStart(ctx.pendingToolStarts, { sessionId, toolName });
  const ts = eventTime(raw, ctx.receivedAt);
  const durationFromPayload = numberField(raw, "duration_ms");
  const durationMs =
    durationFromPayload !== null
      ? Math.max(0, Math.round(durationFromPayload))
      : pending !== undefined
        ? Math.max(0, ts - pending.startedAt)
        : undefined;
  const errorText = stringField(raw, "error");
  const toolResponse = raw.tool_response;
  const outputChars =
    typeof toolResponse === "string"
      ? toolResponse.length
      : isRecord(toolResponse)
        ? JSON.stringify(toolResponse).length
        : undefined;
  const kind = failed ? "tool.fail" : "tool.end";
  // A computed zero duration (end in the same millisecond as the start) is
  // no duration: it carries no signal and fixtures stay honest about what
  // was observed. An explicit payload duration_ms (including 0) is kept.
  const keepDuration = durationMs !== undefined && (durationMs > 0 || durationFromPayload !== null);
  return [
    {
      v: SCHEMA_VERSION,
      id: eventId(sessionId, hookEventName, 0),
      ts,
      receivedAt: ctx.receivedAt,
      agent: "claude-code",
      sessionId,
      ...(parent !== undefined ? { parentSessionId: parent } : {}),
      kind,
      tool: {
        name: toolName,
        category: classification.category,
        ...(classification.execKind !== undefined ? { execKind: classification.execKind } : {}),
        fingerprint: classification.fingerprint,
        ...(classification.target !== undefined ? { target: classification.target } : {}),
        ...(keepDuration && durationMs !== undefined ? { durationMs } : {}),
        outcome: {
          ok: !failed,
          ...(failed ? { errorClass: errorClassFor(errorText) } : {}),
          ...(outputChars !== undefined ? { outputChars } : {}),
        },
      },
    } as unknown as NormalizedEvent,
  ];
}

function mapPermissionRequest(
  raw: Record<string, unknown>,
  hook: { toolName: string | null },
  sessionId: string,
  ctx: MapContext,
  hookEventName: string,
): readonly NormalizedEvent[] {
  return [
    {
      v: SCHEMA_VERSION,
      id: eventId(sessionId, hookEventName, 0),
      ts: eventTime(raw, ctx.receivedAt),
      receivedAt: ctx.receivedAt,
      agent: "claude-code",
      sessionId,
      ...(parentOf(raw, sessionId) !== undefined
        ? { parentSessionId: parentOf(raw, sessionId) as string }
        : {}),
      kind: "permission.request",
      lifecycle: { reason: "permission", confidence: "observed" },
      ...(hook.toolName !== null ? { meta: { toolName: hook.toolName } } : {}),
    } as unknown as NormalizedEvent,
  ];
}

function mapNotification(
  raw: Record<string, unknown>,
  sessionId: string,
  ctx: MapContext,
  hookEventName: string,
): readonly NormalizedEvent[] {
  const notificationType = stringField(raw, "notification_type");
  const ts = eventTime(raw, ctx.receivedAt);
  const args = base(sessionId, ctx.receivedAt, 0);
  if (notificationType === "permission_prompt") {
    if (isDuplicatePermissionPrompt(ctx, sessionId, ts)) {
      return [];
    }
    return [
      {
        v: SCHEMA_VERSION,
        id: eventId(sessionId, hookEventName, 0),
        ts,
        receivedAt: ctx.receivedAt,
        agent: "claude-code",
        sessionId,
        kind: "permission.request",
        lifecycle: { reason: "permission", confidence: "observed" },
      } as unknown as NormalizedEvent,
    ];
  }
  if (notificationType === "idle_prompt") {
    return [
      notification(
        hookEventName,
        args,
        ts,
        { kind: "idle_prompt", hookEvent: hookEventName },
        parentOf(raw, sessionId),
      ),
    ];
  }
  return [
    notification(
      hookEventName,
      args,
      ts,
      {
        kind: notificationType ?? "notification",
        hookEvent: hookEventName,
      },
      parentOf(raw, sessionId),
    ),
  ];
}

function mapStop(
  raw: Record<string, unknown>,
  sessionId: string,
  ctx: MapContext,
  hookEventName: string,
  failed: boolean,
): readonly NormalizedEvent[] {
  const ts = eventTime(raw, ctx.receivedAt);
  if (failed) {
    return [
      {
        v: SCHEMA_VERSION,
        id: eventId(sessionId, hookEventName, 0),
        ts,
        receivedAt: ctx.receivedAt,
        agent: "claude-code",
        sessionId,
        kind: "turn.end",
        lifecycle: { reason: "error", confidence: "observed" },
      } as unknown as NormalizedEvent,
    ];
  }
  const lastMessage = stringField(raw, "last_assistant_message");
  // The documented "last tool was a question tool" rule reads, in order:
  // the caller-threaded bounded record (survives the tool's own end/fail),
  // then the live pending starts (the tool is still running when Stop fires),
  // then nothing — a plain MapContext without either stays honest.
  const lastToolName = readLastToolName(ctx, sessionId) ?? lastQuestionToolName(ctx, sessionId);
  const reason = stopReason(lastMessage, lastToolName);
  return [
    {
      v: SCHEMA_VERSION,
      id: eventId(sessionId, hookEventName, 0),
      ts,
      receivedAt: ctx.receivedAt,
      agent: "claude-code",
      sessionId,
      kind: "turn.end",
      lifecycle: { reason, confidence: reason === "question" ? "inferred" : "observed" },
    } as unknown as NormalizedEvent,
  ];
}

/**
 * The name of the most recent question tool for this session, from the
 * pending starts the daemon threads: a question tool whose start is still
 * pending when Stop fires ran last. Null when none is pending.
 */
function lastQuestionToolName(ctx: MapContext, sessionId: string): string | null {
  const pending = ctx.pendingToolStarts.filter((start) => start.sessionId === sessionId);
  if (pending.length === 0) {
    return null;
  }
  const last = pending[pending.length - 1];
  if (last === undefined) {
    return null;
  }
  return isQuestionTool(last.toolName) ? last.toolName : null;
}

function mapSubagent(
  raw: Record<string, unknown>,
  rootSessionId: string,
  ctx: MapContext,
  hookEventName: string,
  starting: boolean,
): readonly NormalizedEvent[] {
  const agentId = stringField(raw, "agent_id");
  if (agentId === null || agentId === "") {
    return [
      notification(
        hookEventName,
        base(rootSessionId, ctx.receivedAt, 0),
        eventTime(raw, ctx.receivedAt),
        { kind: "unknown", hookEvent: hookEventName },
      ),
    ];
  }
  return [
    {
      v: SCHEMA_VERSION,
      id: eventId(agentId, hookEventName, 0),
      ts: eventTime(raw, ctx.receivedAt),
      receivedAt: ctx.receivedAt,
      agent: "claude-code",
      sessionId: agentId,
      parentSessionId: rootSessionId,
      kind: starting ? "subagent.start" : "subagent.end",
    } as unknown as NormalizedEvent,
  ];
}

function mapCompaction(
  raw: Record<string, unknown>,
  sessionId: string,
  ctx: MapContext,
  hookEventName: string,
): readonly NormalizedEvent[] {
  const trigger = stringField(raw, "trigger");
  return [
    {
      v: SCHEMA_VERSION,
      id: eventId(sessionId, hookEventName, 0),
      ts: eventTime(raw, ctx.receivedAt),
      receivedAt: ctx.receivedAt,
      agent: "claude-code",
      sessionId,
      kind: "compaction",
      ...(trigger !== null ? { meta: { trigger } } : {}),
    } as unknown as NormalizedEvent,
  ];
}

function mapUnknown(
  raw: Record<string, unknown> | unknown,
  sessionId: string,
  ctx: MapContext,
  hookEventName: string | null,
): readonly NormalizedEvent[] {
  return [
    notification(
      hookEventName ?? "unknown",
      base(sessionId, ctx.receivedAt, 0),
      isRecord(raw) ? eventTime(raw, ctx.receivedAt) : ctx.receivedAt,
      {
        kind: "unknown",
        ...(hookEventName !== null ? { hookEvent: hookEventName } : {}),
      },
      isRecord(raw) ? parentOf(raw, sessionId) : undefined,
    ),
  ];
}

/**
 * Maps one raw Claude Code hook payload to normalized events. Pure: reads no
 * clock and performs no I/O; event time comes from the payload's `timestamp`
 * where present and from `ctx.receivedAt` otherwise. Never throws and never
 * drops a recognised session's payload: hook events the table does not know
 * are preserved as `notification` with `meta.kind = "unknown"`. Payloads
 * without a session id map to nothing — there is no lane to attribute them
 * to, and inventing one would be dishonest.
 */
export function mapClaudeCode(raw: unknown, ctx: MapContext): readonly NormalizedEvent[] {
  const hook = parseClaudeShapedHook(raw);
  if (hook.sessionId === null || hook.sessionId === "" || hook.hookEventName === null) {
    return [];
  }
  const rawRecord: Record<string, unknown> = isRecord(raw) ? raw : {};
  const sessionId = hook.sessionId;
  const hookEventName = hook.hookEventName;

  switch (hookEventName) {
    case "SessionStart":
      return mapSessionStart(rawRecord, sessionId, ctx, hookEventName);
    case "SessionEnd":
      return mapSessionEnd(sessionId, ctx, hookEventName, rawRecord);
    case "UserPromptSubmit":
      return mapTurnStart(sessionId, ctx, hookEventName, rawRecord);
    case "PreToolUse":
      return mapPreToolUse(rawRecord, hook, sessionId, ctx, hookEventName);
    case "PostToolUse":
      return mapToolEnd(rawRecord, hook, sessionId, ctx, hookEventName, false);
    case "PostToolUseFailure":
      return mapToolEnd(rawRecord, hook, sessionId, ctx, hookEventName, true);
    case "PermissionRequest":
      return mapPermissionRequest(rawRecord, hook, sessionId, ctx, hookEventName);
    case "Notification":
      return mapNotification(rawRecord, sessionId, ctx, hookEventName);
    case "Stop":
      return mapStop(rawRecord, sessionId, ctx, hookEventName, false);
    case "StopFailure":
      return mapStop(rawRecord, sessionId, ctx, hookEventName, true);
    case "SubagentStart":
      return mapSubagent(rawRecord, sessionId, ctx, hookEventName, true);
    case "SubagentStop":
      return mapSubagent(rawRecord, sessionId, ctx, hookEventName, false);
    case "PreCompact":
    case "PostCompact":
      return mapCompaction(rawRecord, sessionId, ctx, hookEventName);
    default:
      return mapUnknown(raw, sessionId, ctx, hookEventName);
  }
}
