// Maps existing daemon evidence to a portrait; must not infer work, audio playback or success.
import { signalLifecycleWord } from "../copy.js";
import type { LaneSignal, SessionRefView } from "../protocol.js";

export function portraitKey(session: Pick<SessionRefView, "agent" | "sessionId">): string {
  return JSON.stringify([session.agent, session.sessionId]);
}

export function portraitIdentity(session: SessionRefView) {
  let hash = 2166136261;
  for (const character of portraitKey(session)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return { color: hash % 6, accessory: Math.floor(hash / 6) % 4 };
}

/** Keep current identities seated; only new sessions take an unused color. */
export function portraitColors(
  sessions: readonly SessionRefView[],
  previous: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  if (
    sessions.length === previous.size &&
    sessions.every((session) => previous.has(portraitKey(session)))
  ) {
    return previous;
  }
  const colors = new Map<string, number>();
  const used = new Set<number>();
  for (const session of sessions) {
    const key = portraitKey(session);
    const color = previous.get(key);
    if (color !== undefined) {
      colors.set(key, color);
      used.add(color);
    }
  }
  for (const session of [...sessions].sort((a, b) =>
    portraitKey(a).localeCompare(portraitKey(b)),
  )) {
    const key = portraitKey(session);
    if (colors.has(key)) continue;
    const preferred = portraitIdentity(session).color;
    let color = preferred;
    for (let offset = 0; used.has(color); offset += 1) {
      color = offset < 6 ? (preferred + offset + 1) % 6 : offset;
    }
    colors.set(key, color);
    used.add(color);
  }
  return colors;
}

export function portraitState(signal: LaneSignal | undefined, connected: boolean, queued: boolean) {
  if (!connected) return { expression: "unavailable", label: "Status unavailable" };
  if (queued) return { expression: "queued", label: "Waiting for an audio lane" };
  if (!signal) return { expression: "quiet", label: "Quiet" };
  const label = signalLifecycleWord(signal);
  switch (signal.lifecycle) {
    case "active":
      return {
        expression: signal.displayedMode === "other" ? "working" : signal.displayedMode,
        label,
      };
    case "waiting":
      return { expression: "waiting", label };
    case "turn_complete":
      return { expression: "done", label };
    case "stale":
      return { expression: "stale", label };
    default:
      return { expression: "quiet", label };
  }
}

/** Only agents that are not working or asking for you may be dismissed. */
export function isDismissible(expression: string): boolean {
  return expression === "quiet" || expression === "stale" || expression === "done";
}

/** A dismissed agent comes back as soon as it is no longer quiet, or when it leaves. */
export function pruneDismissed(
  dismissed: ReadonlySet<string>,
  entries: readonly { key: string; expression: string }[],
): ReadonlySet<string> {
  const stillQuiet = new Set(
    entries.filter((entry) => isDismissible(entry.expression)).map((entry) => entry.key),
  );
  const kept = [...dismissed].filter((key) => stillQuiet.has(key));
  return kept.length === dismissed.size ? dismissed : new Set(kept);
}
