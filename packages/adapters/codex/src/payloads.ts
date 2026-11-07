// packages/adapters/codex/src/payloads.ts — the Codex-specific fields
// that ride alongside the claude-shaped core (docs/EVENTS.md §Codex CLI
// mapping; field names verified against
// https://developers.openai.com/codex/hooks.md on 2026-09-06, and probed
// live on codex-cli 0.152.1 the same day). What this is for: reading the
// Codex extensions — `turn_id`, `permission_mode`, `source`, `prompt`,
// `tool_use_id`, `tool_response`, `trigger`, `agent_id`, `agent_type`,
// `last_assistant_message`, `stop_hook_active` — without inventing any of
// them. What it must not do: parse the claude-shaped core itself (the
// kit's `parseClaudeShapedHook` owns that), or claim anything about
// fields this adapter does not read.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function booleanField(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * The Codex extensions on a hook payload, extracted and typed. Every field
 * is null when the payload does not carry it or carries the wrong type; an
 * absent field is reported as absent, never invented.
 */
export type CodexFields = {
  /** `turn_id`: the active Codex turn, on turn-scoped hooks. */
  readonly turnId: string | null;

  /** `permission_mode`: default, acceptEdits, plan, dontAsk, bypassPermissions. */
  readonly permissionMode: string | null;

  /** `source`: how the session started (startup, resume, clear, compact). */
  readonly source: string | null;

  /** `prompt`: the user prompt, on UserPromptSubmit. Never recorded. */
  readonly prompt: string | null;

  /** `tool_use_id`: the tool-call id, on PreToolUse/PostToolUse. */
  readonly toolUseId: string | null;

  /** `tool_response`: the tool output, on PostToolUse. Never recorded. */
  readonly toolResponse: unknown;

  /** `trigger`: what triggered compaction (manual, auto). */
  readonly trigger: string | null;

  /** `agent_id`: the subagent identifier, on subagent hooks. */
  readonly agentId: string | null;

  /** `agent_type`: the subagent type or profile, on subagent hooks. */
  readonly agentType: string | null;

  /** `last_assistant_message`: the final message, on Stop/SubagentStop. */
  readonly lastAssistantMessage: string | null;

  /** `stop_hook_active`: whether Stop already continued this turn. */
  readonly stopHookActive: boolean | null;
};

/**
 * Parses the Codex extensions out of any raw payload. Total and pure:
 * never throws, never mutates, and returns null fields for anything it
 * cannot honestly read, including non-object payloads.
 */
export function parseCodexFields(raw: unknown): CodexFields {
  const source = isRecord(raw) ? raw : {};
  return {
    turnId: stringField(source, "turn_id"),
    permissionMode: stringField(source, "permission_mode"),
    source: stringField(source, "source"),
    prompt: stringField(source, "prompt"),
    toolUseId: stringField(source, "tool_use_id"),
    toolResponse: source.tool_response ?? null,
    trigger: stringField(source, "trigger"),
    agentId: stringField(source, "agent_id"),
    agentType: stringField(source, "agent_type"),
    lastAssistantMessage: stringField(source, "last_assistant_message"),
    stopHookActive: booleanField(source, "stop_hook_active"),
  };
}
