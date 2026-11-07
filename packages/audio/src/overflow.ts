// packages/audio/src/overflow.ts — the announced-overflow behaviour beyond
// the lane cap (p7b-t03). What this is for: deciding, purely, when a newly
// queued session earns the one soft overflow cue, and planning that cue's
// voices from the Clearing tuning. What it must not do: touch Tone nodes
// (apply.ts schedules the plan), read a clock (callers pass engine time),
// or give a queued agent a voice of its own — it is unheard, and the cue
// only says so.

import { type CueHarmony, pianoRoll } from "./piano/chord.js";
import { OVERFLOW_CUE } from "./scenes/clearing/index.js";

/**
 * The one switch for the audible half of announced overflow. The owner's
 * choice between announced overflow and a UI-only statement is batched
 * into p7b-t05; `false` turns this into the UI-only option with no other
 * change (the UI statement is shown either way).
 */
export const OVERFLOW_CUE_ENABLED = true;

/** What the watcher remembers between frames. */
export type OverflowWatch = {
  /** Queued session ids already seen; null until the first frame seeds it. */
  readonly known: ReadonlySet<string> | null;
  /** Engine seconds of the last cue, or −∞ before the first. */
  readonly lastCueAtS: number;
};

export const INITIAL_OVERFLOW_WATCH: OverflowWatch = {
  known: null,
  lastCueAtS: Number.NEGATIVE_INFINITY,
};

/**
 * Folds one frame's queued session ids into the watch. A cue is due when a
 * session id appears in the queue that was not there on the previous frame,
 * and the last cue is at least `OVERFLOW_CUE.minSpacingS` old. The first
 * frame only seeds what is already queued: a reconnect or a fresh page
 * load is told by the UI, not by a burst of cues. A session that leaves
 * the queue and re-queues later is new again.
 */
export function watchOverflow(
  watch: OverflowWatch,
  queuedSessionIds: readonly string[],
  nowS: number,
): { readonly watch: OverflowWatch; readonly cue: boolean } {
  const current = new Set(queuedSessionIds);
  if (watch.known === null) {
    return { watch: { known: current, lastCueAtS: watch.lastCueAtS }, cue: false };
  }
  const known = watch.known;
  const arrived = queuedSessionIds.some((id) => !known.has(id));
  const spaced = nowS - watch.lastCueAtS >= OVERFLOW_CUE.minSpacingS;
  const cue = arrived && spaced;
  return { watch: { known: current, lastCueAtS: cue ? nowS : watch.lastCueAtS }, cue };
}

/** A quiet, room-centred piano roll; queueing semantics remain unchanged. */
export type OverflowCueVoice = {
  readonly midi: number;
  readonly startS: number;
  readonly touch: number;
};
export type OverflowCuePlan = {
  readonly voices: readonly OverflowCueVoice[];
  readonly peakGain: number;
  readonly holdUntilS: number;
  readonly releaseS: number;
};
export function overflowCuePlan(harmony?: CueHarmony): OverflowCuePlan {
  return {
    voices: pianoRoll("overflow", 0, harmony),
    peakGain: 0.1,
    holdUntilS: 2.1,
    releaseS: 0.65,
  };
}
