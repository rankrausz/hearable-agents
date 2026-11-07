// Presentation/playback policy over observed daemon states; never infers agent work.
import type { LaneSignal } from "./protocol.js";

export type PlaybackMode = "continuous" | "activity";
export const COMPLETION_TAIL_MS = 8_000;

export function ongoing(signal: Pick<LaneSignal, "lifecycle">): boolean {
  return ["active", "quiet", "waiting"].includes(signal.lifecycle);
}

export function playbackWanted(
  signals: readonly LaneSignal[],
  mode: PlaybackMode,
  connected: boolean,
  now: number,
): boolean {
  if (!connected) return false;
  if (mode === "continuous") return true;
  return signals.some(
    (signal) =>
      ongoing(signal) ||
      (signal.lifecycle === "turn_complete" &&
        now >= signal.lastEventAt &&
        now - signal.lastEventAt < COMPLETION_TAIL_MS) ||
      signal.gestures.some(
        (cue) => cue.gesture === "resolve" && now >= cue.at && now - cue.at < COMPLETION_TAIL_MS,
      ),
  );
}

/**
 * Activity-only is the default (owner direction 2026-10-29: "the sound
 * when no agents are running should fade to absolutely no sound").
 * Continuous stays one explicit choice away.
 */
export function readPlaybackMode(): PlaybackMode {
  try {
    return localStorage.getItem("hearable.playbackMode") === "continuous"
      ? "continuous"
      : "activity";
  } catch {
    return "activity";
  }
}

export function savePlaybackMode(mode: PlaybackMode): void {
  try {
    localStorage.setItem("hearable.playbackMode", mode);
  } catch {
    /* Session control still works without storage. */
  }
}
