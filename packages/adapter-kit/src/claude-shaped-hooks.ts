// packages/adapter-kit/src/claude-shaped-hooks.ts — shared parsing for hook
// payloads that resemble Claude Code's: the five fields the claude-code,
// codex and cursor preToolUse/postToolUse families all carry
// (docs/EVENTS.md §Claude Code mapping; field names verified against
// https://code.claude.com/docs/en/hooks on 2026-09-05). What this is for:
// letting three adapters share one honest, total, never-throwing parse of the
// common shape. What it must not do: know any agent beyond these shared field
// names, invent fields docs/EVENTS.md does not record, or become a
// substitute for verification — each adapter must still own and verify its
// own fixtures against the live payload its installed agent actually sends,
// because agent hook payloads drift and this helper deliberately claims
// nothing about fields it does not parse.

/**
 * The common fields of a claude-shaped hook payload, extracted and typed.
 * Every field is null when the payload does not carry it or carries the wrong
 * type; an absent field is reported as absent, never invented.
 */
export type ClaudeShapedHook = {
  /** `session_id`: the agent's session identifier. */
  readonly sessionId: string | null;

  /** `hook_event_name`: which lifecycle event fired. */
  readonly hookEventName: string | null;

  /** `cwd`: the session's working directory. */
  readonly cwd: string | null;

  /** `tool_name`: the tool being called, present on tool events only. */
  readonly toolName: string | null;

  /** `tool_input`: the tool's arguments as a JSON object, present on tool events only. */
  readonly toolInput: Readonly<Record<string, unknown>> | null;
};

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the common claude-shaped fields out of any raw payload. Total and
 * pure: never throws, never mutates, and returns null fields for anything it
 * cannot honestly read, including non-object payloads.
 */
export function parseClaudeShapedHook(raw: unknown): ClaudeShapedHook {
  const source = isRecord(raw) ? raw : {};
  const toolInput = source.tool_input;
  return {
    sessionId: stringField(source, "session_id"),
    hookEventName: stringField(source, "hook_event_name"),
    cwd: stringField(source, "cwd"),
    toolName: stringField(source, "tool_name"),
    toolInput: isRecord(toolInput) ? toolInput : null,
  };
}
