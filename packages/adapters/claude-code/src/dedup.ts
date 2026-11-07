// packages/adapters/claude-code/src/dedup.ts — the Notification
// permission_prompt de-duplication of docs/EVENTS.md §Claude Code mapping.
// What this is for: deciding whether a `permission_prompt` Notification is
// the delayed echo of a PermissionRequest the adapter already mapped, so the
// engine sees one permission.request, not two. What it must not do: keep
// state — `map` is pure, so the window is keyed off the pending tool starts
// the caller threads: a still-pending start proves its PreToolUse was mapped,
// and the PermissionRequest hook fires immediately after PreToolUse whenever
// approval is needed, so a recent pending start means the request was already
// mapped. Keyed by session only: the documented Notification shape carries
// no tool name, so per-tool keying would invent data the source did not
// provide (see README).

import type { MapContext } from "@hearable/adapter-kit";

/** The de-duplication window docs/EVENTS.md names, in ms. */
export const PERMISSION_DEDUP_WINDOW_MS = 2000;

/**
 * Whether a `permission_prompt` Notification duplicates an already-mapped
 * PermissionRequest. True exactly when the session has a pending tool start
 * that began within the window before the notification: recent enough to be
 * the request the notification echoes, old enough (or absent, or another
 * session's) to be unrelated. A negative elapsed (skewed timestamps) never
 * counts as a duplicate.
 */
export function isDuplicatePermissionPrompt(
  ctx: MapContext,
  sessionId: string,
  now: number,
): boolean {
  return ctx.pendingToolStarts.some(
    (start) =>
      start.sessionId === sessionId &&
      now - start.startedAt >= 0 &&
      now - start.startedAt <= PERMISSION_DEDUP_WINDOW_MS,
  );
}
