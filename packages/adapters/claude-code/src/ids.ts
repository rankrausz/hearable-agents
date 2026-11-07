// packages/adapters/claude-code/src/ids.ts — deterministic event ids. What
// this is for: giving every mapped event a stable id derived from the hook
// payload (session, hook event, sequence within the payload) so replaying a
// fixture twice yields identical events. What it must not do: read a clock or
// randomness — ids come from data alone, because `map` is pure.

/**
 * Builds a deterministic event id from the session id, the hook event name
 * and a per-payload sequence number. Payload fields are sanitised to id-safe
 * characters; nothing outside these three inputs contributes.
 */
export function eventId(sessionId: string, hookEventName: string, sequence: number): string {
  const safe = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "event";
  return `claude-${safe(sessionId)}-${safe(hookEventName)}-${sequence}`;
}
