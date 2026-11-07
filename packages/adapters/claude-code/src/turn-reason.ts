// packages/adapters/claude-code/src/turn-reason.ts — the turn.end reason
// heuristics of docs/EVENTS.md §Claude Code mapping. What this is for:
// deciding between "question" and "completed" for Stop payloads from the
// final assistant message (ends in `?`) or the last tool being a question
// tool. What it must not do: read prompts or outputs — the message is the
// only text consulted, and it is never recorded.

/** Tool names that mark a turn as a question when they ran last. */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion"]);

/**
 * The turn.end reason for a Stop payload. "question" when the final message
 * ends in a question mark or the last tool was a question tool; "completed"
 * otherwise. Pure and total: absent inputs decide "completed".
 */
export function stopReason(
  lastMessage: string | null,
  lastToolName: string | null,
): "question" | "completed" {
  if (lastToolName !== null && QUESTION_TOOLS.has(lastToolName)) {
    return "question";
  }
  if (lastMessage?.trimEnd().endsWith("?") === true) {
    return "question";
  }
  return "completed";
}

/**
 * Whether a PreToolUse payload calls a question tool. The adapter maps such
 * payloads to question.asked instead of tool.start.
 */
export function isQuestionTool(toolName: string | null): boolean {
  return toolName !== null && QUESTION_TOOLS.has(toolName);
}
