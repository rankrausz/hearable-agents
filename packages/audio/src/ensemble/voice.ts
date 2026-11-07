// packages/audio/src/ensemble/voice.ts — the hard cues the A/B slice shares.
// What this is for: placing the production question (waiting) and resolve
// (completion) shapes on the shared slice timeline, so both versions carry
// the identical cues and only routine-note SCHEDULING differs. Routine moves
// themselves voice nothing here: a move hands the lane's note from one
// sustained voice bank to the other (apply.ts crossfadeLaneVoices, driven
// from the QA entry), which is why the earlier soft two-note move
// articulation is gone —
// with the sustained voices really moving, that extra note read as a sudden
// event on top of the morph. What it must not do: import Tone, schedule live
// audio, or change mapping/voices.

import { driveScenario, type GestureVoiceEvent, scenarioFor } from "../gestures/index.js";

/** Lane carrying the shared timeline's waiting/completion cues. */
export const AB_CUE_LANE = 2;

/** Seconds the shared timeline enters waiting (question cue). */
export const AB_WAITING_AT_S = 60;

/** Seconds the shared timeline completes (resolve cue). */
export const AB_RESOLVE_AT_S = 110;

/**
 * The shared timeline's hard cues on the existing gesture path: the
 * production question shape at 60 s and the production resolve shape at
 * 110 s on lane 2, at production calm. Both A/B versions carry the
 * identical cues — only routine-note scheduling differs. Times are
 * absolute slice seconds; callers schedule them at those times.
 *
 * Offset basis: driveScenario plans carry offsets relative to the
 * trigger, and scheduleGesturePlan adds `now` to every offset
 * (render.ts single anchoring) — so shifting here to absolute slice
 * time matches the QA entry contract exactly.
 */
export function abCueEvents(calm: number): readonly GestureVoiceEvent[] {
  const question = driveScenario(scenarioFor("question", AB_CUE_LANE, calm));
  const resolve = driveScenario(scenarioFor("resolve", AB_CUE_LANE, calm));
  const shift = (events: readonly GestureVoiceEvent[], atS: number): readonly GestureVoiceEvent[] =>
    events.map((event) => {
      if (event.kind === "swell") return { ...event, startS: event.startS + atS };
      if (event.kind === "bus")
        return { ...event, startS: event.startS + atS, endS: event.endS + atS };
      return { ...event, startS: event.startS + atS, holdUntilS: event.holdUntilS + atS };
    });
  return [...shift(question, AB_WAITING_AT_S), ...shift(resolve, AB_RESOLVE_AT_S)];
}
