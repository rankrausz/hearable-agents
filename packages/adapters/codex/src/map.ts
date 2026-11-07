// packages/adapters/codex/src/map.ts — the pure Codex hook-payload to
// normalized-event mapping (docs/EVENTS.md §Codex CLI mapping). What this
// is for: turning each verified Codex hook event into the event kinds the
// table promises — session start, turn start with turn_id, tool
// start/end/fail with exit-code failure detection and a coarse errorClass
// (`not_found` for exit 127, else `other` — the only classes the exit-code
// evidence honestly supports), permission requests,
// heuristic turn ends, subagents, compaction, and unknown events preserved
// as notifications. What it must not do: invent session.end (Codex has no
// SessionEnd worth that name; SessionEnd payloads are explicitly ignored),
// invent fields the payload did not provide, or emit what capabilities
// deny — edit-class tools never occur because core has no verified codex
// row for them and unrecorded names classify as `other`, never `edit`.

import { createHash } from "node:crypto";
import type { MapContext, PendingToolStart } from "@hearable/adapter-kit";
import { findToolStart, parseClaudeShapedHook } from "@hearable/adapter-kit";
import {
  type AdapterCapabilities,
  type AgentId,
  classify,
  type NormalizedEvent,
  SCHEMA_VERSION,
  type ToolInfo,
} from "@hearable/core";
import { CODEX_CAPABILITIES } from "./capabilities.js";
import { parseCodexFields } from "./payloads.js";

/** The adapter id this mapping emits events for. */
export const CODEX_AGENT_ID: AgentId = "codex";

type CodexToolInfo = {
  readonly name: string;
  readonly toolUseId: string | null;
  readonly toolInput: unknown;
  readonly toolResponse: unknown;
};

function stringFieldOf(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
}

// Codex-specific tool names arrive as `Bash` (shell) or `apply_patch`
// (file edits); the classify table is keyed by lowercase `shell` and
// `apply_patch`. This is a lookup key, not a category branch: classify()
// still decides the category from the table plus the tool input.
function lookupToolName(toolName: string): string {
  if (toolName === "Bash") {
    return "shell";
  }
  return toolName;
}

type OutcomeInput =
  | {
      readonly ok: true;
      readonly exitCode?: number;
      readonly outputChars?: number;
    }
  | {
      readonly ok: false;
      readonly exitCode?: number;
      readonly outputChars?: number;
      readonly errorClass?: string;
    };

type SucceededTool = {
  readonly name: string;
  readonly category: ToolInfo["category"];
  readonly fingerprint: string;
  readonly execKind?: ToolInfo["execKind"];
  readonly target?: string;
  readonly outcome: {
    readonly ok: true;
    readonly exitCode?: number;
    readonly outputChars?: number;
  };
  readonly durationMs?: number;
};

type FailedTool = {
  readonly name: string;
  readonly category: ToolInfo["category"];
  readonly fingerprint: string;
  readonly execKind?: ToolInfo["execKind"];
  readonly target?: string;
  readonly outcome: {
    readonly ok: false;
    readonly exitCode?: number;
    readonly outputChars?: number;
    readonly errorClass?: string;
  };
  readonly durationMs?: number;
};

function buildStartedTool(
  info: CodexToolInfo,
  cwd: string,
): Omit<ToolInfo, "outcome" | "durationMs"> {
  const classification = classify({
    agent: CODEX_AGENT_ID,
    toolName: lookupToolName(info.name),
    toolInput: info.toolInput,
    cwd,
  });
  return {
    name: info.name,
    category: classification.category,
    fingerprint: classification.fingerprint,
    ...(classification.execKind !== undefined ? { execKind: classification.execKind } : {}),
    ...(classification.target !== undefined ? { target: classification.target } : {}),
  };
}

function buildFailedTool(
  info: CodexToolInfo,
  cwd: string,
  outcome: Extract<OutcomeInput, { ok: false }>,
): FailedTool {
  const started = buildStartedTool(info, cwd);
  return {
    ...started,
    outcome: {
      ok: false as const,
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.errorClass !== undefined ? { errorClass: outcome.errorClass } : {}),
      ...(outcome.outputChars !== undefined ? { outputChars: outcome.outputChars } : {}),
    },
  };
}

function buildSucceededTool(
  info: CodexToolInfo,
  cwd: string,
  outcome: Extract<OutcomeInput, { ok: true }>,
): SucceededTool {
  const started = buildStartedTool(info, cwd);
  return {
    ...started,
    outcome: {
      ok: true as const,
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.outputChars !== undefined ? { outputChars: outcome.outputChars } : {}),
    },
  };
}

function durationMs(
  pending: PendingToolStart | undefined,
  receivedAt: number,
  capabilities: AdapterCapabilities,
): number | undefined {
  if (!capabilities.durations || pending === undefined) {
    return undefined;
  }
  return Math.max(0, receivedAt - pending.startedAt);
}

// A tool failure Codex reports carries no error text — only the numeric
// exit code, the status token, or isError — and the mapping never reads
// output text. From that coarse evidence the only honest classes are:
// exit code 127 (or a not-found status) is `not_found`, any other nonzero
// exit is `other`, and a failure with no numeric exit is `other`. Anything
// finer would invent evidence the payload did not provide.
// errorClassFromFailure — the coarse errorClass for a Codex tool failure,
// from the failure evidence only (exit code / status / isError), never from
// output text. Exit code 127 reads as `not_found` (the shell's command-not-
// found convention); every other failure reads as `other`. Anything finer
// (a test_failure or compile_error label) would invent evidence the payload
// did not provide.
function errorClassFromFailure(exitCode: number | null): "not_found" | "other" {
  return exitCode === 127 ? "not_found" : "other";
}

function exitCodeOf(toolResponse: unknown): number | null {
  if (typeof toolResponse === "number" && Number.isInteger(toolResponse)) {
    return toolResponse;
  }
  if (toolResponse === null || typeof toolResponse !== "object" || Array.isArray(toolResponse)) {
    return null;
  }
  const record = toolResponse as Record<string, unknown>;
  for (const key of ["exit_code", "exitCode"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
  }
  return null;
}

function failedFromResponse(toolResponse: unknown): boolean | null {
  const exitCode = exitCodeOf(toolResponse);
  if (exitCode !== null) {
    return exitCode !== 0;
  }
  if (toolResponse === null || typeof toolResponse !== "object" || Array.isArray(toolResponse)) {
    return null;
  }
  const record = toolResponse as Record<string, unknown>;
  const status = record.status;
  if (status === "failed" || status === "failure" || status === "error") {
    return true;
  }
  if (status === "completed" || status === "success" || status === "ok") {
    return false;
  }
  const isError = record.isError;
  if (typeof isError === "boolean") {
    return isError;
  }
  return null;
}

// The Stop reason heuristic of docs/EVENTS.md §Codex CLI mapping: a final
// message ending in "?" reads as a question; anything else reads as
// completed. Codex never tells us which, so confidence stays `inferred`
// and the stop_hook_active re-continuation signal is deliberately not
// interpreted as a reason — it describes hook plumbing, not turn outcome.
function stopReason(lastMessage: string | null): { reason: "question" | "completed" } {
  if (lastMessage?.trimEnd().endsWith("?") === true) {
    return { reason: "question" };
  }
  return { reason: "completed" };
}

type BaseEvent = {
  readonly v: typeof SCHEMA_VERSION;
  readonly id: string;
  readonly ts: number;
  readonly receivedAt: number;
  readonly agent: AgentId;
  readonly sessionId: string;
};

function baseEvent(id: string, ts: number, receivedAt: number, sessionId: string): BaseEvent {
  return { v: SCHEMA_VERSION, id, ts, receivedAt, agent: CODEX_AGENT_ID, sessionId };
}

function turnEventId(sessionId: string, turnId: string | null, ts: number, suffix: string): string {
  const identity =
    turnId === null ? String(ts) : createHash("sha256").update(turnId).digest("hex").slice(0, 16);
  return `${sessionId}-${identity}-${suffix}`;
}

function unknownNotification(
  sessionId: string,
  hookEventName: string,
  ts: number,
  receivedAt: number,
  extraMeta?: Record<string, string | number | boolean>,
): NormalizedEvent {
  return {
    ...baseEvent(`${sessionId}-${hookEventName}-unknown`, ts, receivedAt, sessionId),
    kind: "notification",
    meta: { kind: "unknown", hookEvent: hookEventName, ...(extraMeta ?? {}) },
  };
}

/**
 * Maps one raw Codex hook payload to normalized events. Pure: reads no
 * clock and performs no I/O; event time is `ctx.receivedAt` (Codex hook
 * payloads carry no timestamp) and matching tool-start state comes from
 * `ctx.pendingToolStarts`. Never throws on input it cannot make sense
 * of; returns an empty array when the payload names no session, and a
 * preserved `notification` when the payload names an event this adapter
 * does not know.
 */
export function mapCodexPayload(raw: unknown, ctx: MapContext): readonly NormalizedEvent[] {
  const hook = parseClaudeShapedHook(raw);
  const codex = parseCodexFields(raw);
  if (hook.sessionId === null || hook.hookEventName === null) {
    return [];
  }
  const sessionId = hook.sessionId;
  const eventName = hook.hookEventName;
  const ts = ctx.receivedAt;
  const cwd = hook.cwd ?? ctx.cwd;
  switch (eventName) {
    case "SessionStart": {
      const meta = codex.source !== null ? { source: codex.source } : undefined;
      return [
        {
          ...baseEvent(`${sessionId}-session-start`, ts, ctx.receivedAt, sessionId),
          kind: "session.start",
          ...(meta !== undefined ? { meta } : {}),
        },
      ];
    }
    case "SessionEnd": {
      // No session.end is invented: Codex's SessionEnd is advisory (the
      // lane is released by idle timeout per docs/EVENTS.md), so the
      // payload is acknowledged by dropping it — never by ending a lane
      // the agent did not end.
      return [];
    }
    case "UserPromptSubmit": {
      const meta = codex.turnId !== null ? { turnId: codex.turnId } : undefined;
      return [
        {
          ...baseEvent(
            turnEventId(sessionId, codex.turnId, ts, "turn-start"),
            ts,
            ctx.receivedAt,
            sessionId,
          ),
          kind: "turn.start",
          ...(meta !== undefined ? { meta } : {}),
        },
      ];
    }
    case "PreToolUse": {
      if (hook.toolName === null) {
        return [unknownNotification(sessionId, eventName, ts, ctx.receivedAt)];
      }
      const info: CodexToolInfo = {
        name: hook.toolName,
        toolUseId: codex.toolUseId,
        toolInput: hook.toolInput,
        toolResponse: null,
      };
      const tool = buildStartedTool(info, cwd);
      return [
        {
          ...baseEvent(
            `${sessionId}-${codex.toolUseId ?? hook.toolName}-tool-start`,
            ts,
            ctx.receivedAt,
            sessionId,
          ),
          kind: "tool.start",
          tool,
          ...(codex.turnId !== null ? { meta: { turnId: codex.turnId } } : {}),
        },
      ];
    }
    case "PostToolUse": {
      if (hook.toolName === null) {
        return [unknownNotification(sessionId, eventName, ts, ctx.receivedAt)];
      }
      const pending = findToolStart(ctx.pendingToolStarts, {
        sessionId,
        toolName: hook.toolName,
        ...(codex.toolUseId !== null ? { toolUseId: codex.toolUseId } : {}),
      });
      const info: CodexToolInfo = {
        name: hook.toolName,
        toolUseId: codex.toolUseId,
        toolInput: hook.toolInput,
        toolResponse: codex.toolResponse,
      };
      const failed = CODEX_CAPABILITIES.toolFailures
        ? failedFromResponse(codex.toolResponse)
        : null;
      const exitCode = exitCodeOf(codex.toolResponse);
      const ms = durationMs(pending, ctx.receivedAt, CODEX_CAPABILITIES);
      const responseText = typeof codex.toolResponse === "string" ? codex.toolResponse : null;
      const outputChars = responseText !== null ? responseText.length : undefined;
      if (failed === true) {
        const errorClass = errorClassFromFailure(exitCode);
        const outcome: Extract<OutcomeInput, { ok: false }> =
          outputChars !== undefined || exitCode !== null
            ? {
                ok: false as const,
                ...(exitCode !== null ? { exitCode } : {}),
                errorClass,
                ...(outputChars !== undefined ? { outputChars } : {}),
              }
            : { ok: false as const, errorClass };
        const tool = buildFailedTool(info, cwd, outcome);
        return [
          {
            ...baseEvent(
              `${sessionId}-${codex.toolUseId ?? hook.toolName}-tool-fail`,
              ts,
              ctx.receivedAt,
              sessionId,
            ),
            kind: "tool.fail",
            tool: ms !== undefined ? { ...tool, durationMs: ms } : tool,
            ...(codex.turnId !== null ? { meta: { turnId: codex.turnId } } : {}),
          },
        ];
      }
      const outcome: Extract<OutcomeInput, { ok: true }> =
        outputChars !== undefined || exitCode !== null
          ? {
              ok: true as const,
              ...(exitCode !== null ? { exitCode } : {}),
              ...(outputChars !== undefined ? { outputChars } : {}),
            }
          : { ok: true as const };
      const tool = buildSucceededTool(info, cwd, outcome);
      return [
        {
          ...baseEvent(
            `${sessionId}-${codex.toolUseId ?? hook.toolName}-tool-end`,
            ts,
            ctx.receivedAt,
            sessionId,
          ),
          kind: "tool.end",
          tool: ms !== undefined ? { ...tool, durationMs: ms } : tool,
          ...(codex.turnId !== null ? { meta: { turnId: codex.turnId } } : {}),
        },
      ];
    }
    case "PermissionRequest": {
      // The named tool lets core end the wait when that tool runs: Codex
      // has no approval-reply hook, so the run itself is the only evidence.
      const tool =
        hook.toolName !== null
          ? buildStartedTool(
              {
                name: hook.toolName,
                toolUseId: null,
                toolInput: hook.toolInput,
                toolResponse: null,
              },
              cwd,
            )
          : undefined;
      return [
        {
          ...baseEvent(
            turnEventId(sessionId, codex.turnId, ts, "permission-request"),
            ts,
            ctx.receivedAt,
            sessionId,
          ),
          kind: "permission.request",
          lifecycle: { reason: "permission", confidence: "observed" },
          ...(tool !== undefined ? { tool } : {}),
          ...(codex.turnId !== null ? { meta: { turnId: codex.turnId } } : {}),
        },
      ];
    }
    case "Stop": {
      const { reason } = stopReason(codex.lastAssistantMessage);
      return [
        {
          ...baseEvent(
            turnEventId(sessionId, codex.turnId, ts, "turn-end"),
            ts,
            ctx.receivedAt,
            sessionId,
          ),
          kind: "turn.end",
          lifecycle: { reason, confidence: "inferred" },
          ...(codex.turnId !== null ? { meta: { turnId: codex.turnId } } : {}),
        },
      ];
    }
    case "Interrupt": {
      return [
        {
          ...baseEvent(
            turnEventId(sessionId, codex.turnId, ts, "turn-end-cancelled"),
            ts,
            ctx.receivedAt,
            sessionId,
          ),
          kind: "turn.end",
          lifecycle: { reason: "cancelled", confidence: "observed" },
        },
      ];
    }
    case "SubagentStart": {
      if (codex.agentId === null) {
        return [unknownNotification(sessionId, eventName, ts, ctx.receivedAt)];
      }
      return [
        {
          ...baseEvent(
            `${sessionId}-${codex.agentId}-subagent-start`,
            ts,
            ctx.receivedAt,
            codex.agentId,
          ),
          kind: "subagent.start",
          parentSessionId: sessionId,
          ...(codex.agentType !== null ? { meta: { agentType: codex.agentType } } : {}),
        },
      ];
    }
    case "SubagentStop": {
      if (codex.agentId === null) {
        return [unknownNotification(sessionId, eventName, ts, ctx.receivedAt)];
      }
      return [
        {
          ...baseEvent(
            `${sessionId}-${codex.agentId}-subagent-end`,
            ts,
            ctx.receivedAt,
            codex.agentId,
          ),
          kind: "subagent.end",
          parentSessionId: sessionId,
          ...(codex.agentType !== null ? { meta: { agentType: codex.agentType } } : {}),
        },
      ];
    }
    case "PreCompact":
    case "PostCompact": {
      const meta = codex.trigger !== null ? { trigger: codex.trigger } : undefined;
      return [
        {
          ...baseEvent(`${sessionId}-compaction`, ts, ctx.receivedAt, sessionId),
          kind: "compaction",
          ...(meta !== undefined ? { meta } : {}),
        },
      ];
    }
    default: {
      const rawName = stringFieldOf(raw, "hook_event_name") ?? eventName;
      return [unknownNotification(sessionId, rawName, ts, ctx.receivedAt)];
    }
  }
}
