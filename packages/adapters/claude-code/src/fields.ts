// packages/adapters/claude-code/src/fields.ts — total, never-throwing
// readers for the fields the Claude Code mapping needs beyond the kit's
// shared claude-shaped five. Every reader returns null for a missing or
// mistyped field so `map` reports absence instead of inventing data. Field
// names were verified against https://code.claude.com/docs/en/hooks on
// 2026-09-06 (see README); nothing here is read from memory.

/** True for plain JSON objects; arrays and primitives are not field sources. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string field, or null when absent or mistyped. Never throws. */
export function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

/** A numeric field, or null when absent or mistyped. Never throws. */
export function numberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A boolean field, or null when absent or mistyped. Never throws. */
export function booleanField(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * The matcher-carried qualifier for matcher-scoped events: `source` on
 * SessionStart, `trigger` on PreCompact/PostCompact, `reason` on SessionEnd,
 * `notification_type` on Notification, `error` on StopFailure. Null when the
 * payload carries nothing usable.
 */
export function qualifierField(raw: unknown): string | null {
  if (!isRecord(raw)) {
    return null;
  }
  for (const key of ["source", "trigger", "reason", "notification_type", "error"]) {
    const value = stringField(raw, key);
    if (value !== null) {
      return value;
    }
  }
  return null;
}
