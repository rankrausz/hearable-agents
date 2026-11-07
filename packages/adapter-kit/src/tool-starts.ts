// packages/adapter-kit/src/tool-starts.ts — pure helpers for the
// pending-tool-start bookkeeping that MapContext carries between map calls
// (docs/ARCHITECTURE.md §packages/adapter-kit, docs/EVENTS.md §Claude Code
// mapping). The matching rule lives here once so every adapter family shares
// it: match by the agent's tool-call id when both sides carry one, otherwise
// first-in-first-out per session and tool name — the exact rule
// docs/EVENTS.md states. This module must not mutate its inputs, keep state,
// or know any agent by name; it is pure so the daemon can thread one list
// through every map call of a session.

import type { PendingToolStart, PendingToolStarts } from "./adapter.js";

/**
 * The start a tool end or fail should be paired with: an exact tool-call id
 * when the caller knows one, otherwise the oldest start for that session and
 * tool name.
 */
export function findToolStart(
  pending: PendingToolStarts,
  match: { sessionId: string; toolName: string; toolUseId?: string },
): PendingToolStart | undefined {
  if (match.toolUseId !== undefined) {
    const byId = pending.find(
      (start) => start.toolUseId === match.toolUseId && start.sessionId === match.sessionId,
    );
    if (byId !== undefined) {
      return byId;
    }
  }
  return pending.find(
    (start) => start.sessionId === match.sessionId && start.toolName === match.toolName,
  );
}

/** Records a new tool start. Pure: returns a new list, never mutates. */
export function rememberToolStart(
  pending: PendingToolStarts,
  start: PendingToolStart,
): PendingToolStarts {
  return [...pending, start];
}

/**
 * Removes the start that `findToolStart` would pair with this match, leaving
 * every other start untouched. When nothing matches, the list is returned
 * unchanged.
 */
export function forgetToolStart(
  pending: PendingToolStarts,
  match: { sessionId: string; toolName: string; toolUseId?: string },
): PendingToolStarts {
  const found = findToolStart(pending, match);
  if (found === undefined) {
    return pending;
  }
  return pending.filter((start) => start !== found);
}
