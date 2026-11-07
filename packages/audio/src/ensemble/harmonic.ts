// packages/audio/src/ensemble/harmonic.ts — the p5-t03 harmonic-move voicing seam.
// What this is for: turning the p5-t02 core planner's `HarmonicMove` plans
// into the pitched lane layers the p5-t01 prototype path already voices —
// the same `EnsembleQaSchedule` triples the QA entry crossfades via
// `crossfadeLaneVoices` — so the auditioned equal-power handover (old note
// fades out, new note fades in over the `crossfade` class, no pitch bends)
// carries the planned pitches with no second voicing engine. What it must
// not do: plan anything (planning stays in `packages/core`), sound
// anything, keep state, touch time/randomness, or retune unrelated lanes —
// a move voices exactly its own lane's scheduled pitch.

import type { HarmonicMove, LaneSignal } from "@hearable/core";
import type { EnsembleQaSchedule } from "../qa/scenarios.js";
import { abTimeline, lanesAt } from "./timeline.js";

/**
 * The voicing contract a `HarmonicMove` must satisfy before it reaches
 * audio: a planned pitch is only a step the QA entry can crossfade when it
 * is an in-key, in-register candidate 2–3 semitones from the pitch the
 * lane already carries, and its anchor lies inside the voiced window.
 * Anything else is a plan-side problem the voicing never repairs — hold,
 * never reinterpret.
 */
export type HarmonicVoicing = {
  /** Lane index that moves (0/1/2). */
  readonly laneIndex: number;
  /** Seconds from the slice start the handover starts at. */
  readonly atS: number;
  /** New pitch the lane carries after the handover. */
  readonly pitch: number;
  /** Pitch the lane carried just before the handover. */
  readonly fromPitch: number;
};

/** One voiced routine-note handover: harmonic-plan in, prototype path out. */
export type HarmonicVoicePlan = {
  /** The exact schedule the QA entry voices (`voiceEnsembleSchedule`). */
  readonly schedule: EnsembleQaSchedule;
};

/** Upper bound of one routine harmonic step, in semitones (ADR 0022). */
export const HARMONIC_VOICE_MAX_STEP = 3;

/**
 * Maximum handover length that can start before the window ends: the
 * `crossfade` class (3 s) is scheduled as two linear half-ramps anchored
 * at the move time, and a move anchored past `durationS` never starts —
 * the same horizon the audition schedulers gate on.
 */
export function harmonicVoiceIsInWindow(atS: number, durationS: number): boolean {
  return atS >= 0 && atS < durationS;
}

/**
 * True when one planned move is voiceable as a routine handover: same
 * lane, non-negative time, in-key and in-register, an adjacent step (1–3
 * semitones from the carried pitch — never a hold disguised as a move,
 * never a leap), and anchored inside the voiced window. The key/register
 * checks take the lane's own predicates so the seam never duplicates the
 * curated grammar — it reuses the guards the scheduler already applies.
 */
export function harmonicMoveIsVoiceable(
  move: HarmonicMove,
  durationS: number,
  predicates: {
    readonly isInKey: (midi: number) => boolean;
    readonly isInRegister: (midi: number, laneIndex: number) => boolean;
  },
): boolean {
  if (move.laneIndex < 0 || !Number.isInteger(move.laneIndex)) return false;
  if (!harmonicVoiceIsInWindow(move.atS, durationS)) return false;
  if (!Number.isInteger(move.pitch) || !Number.isInteger(move.fromPitch)) return false;
  if (move.pitch === move.fromPitch) return false;
  if (Math.abs(move.pitch - move.fromPitch) > HARMONIC_VOICE_MAX_STEP) return false;
  if (!predicates.isInKey(move.pitch)) return false;
  if (!predicates.isInRegister(move.pitch, move.laneIndex)) return false;
  return true;
}

/**
 * Voices core `HarmonicMove` plans through the prototype path: filters the
 * plan to voiceable handovers on the calling lane set and returns the exact
 * `EnsembleQaSchedule` the QA entry crossfades — no re-planning, no
 * re-pitching, no second engine. Moves arrive in plan order, so the entry's
 * per-lane move index keeps the crossfade stateless (even moves hand bank
 * 0 → 1, odd moves hand it back) and unrelated lanes are never touched.
 *
 * Planner-voiced plans are tagged `"harmonic"`: the tag is provenance (a
 * real core-planner plan reached the crossfade path), never a second
 * scheduler. The default carries the tag — callers that need the audition
 * labels pass `"hybrid"` explicitly for a hand-authored plan.
 */
export function harmonicVoicePlan(
  moves: readonly HarmonicMove[],
  durationS: number,
  predicates: {
    readonly isInKey: (midi: number) => boolean;
    readonly isInRegister: (midi: number, laneIndex: number) => boolean;
  },
  options: { readonly version?: EnsembleQaSchedule["version"] } = {},
): HarmonicVoicePlan {
  const voiced: HarmonicVoicing[] = [];
  for (const move of moves) {
    if (!harmonicMoveIsVoiceable(move, durationS, predicates)) continue;
    voiced.push({
      laneIndex: move.laneIndex,
      atS: move.atS,
      pitch: move.pitch,
      fromPitch: move.fromPitch,
    });
  }
  return {
    schedule: { version: options.version ?? "harmonic", moves: voiced },
  };
}

/**
 * The shared slice's trajectory as the planner's own input: the
 * `LaneSignal` subset (lifecycle, mode weights, activity, progress — no
 * agent field, no struggle) each lane shows at whole engine-clock seconds.
 * The QA entry sounds this same trajectory, so a plan built from these
 * signals and the render agree on what the lanes did by construction.
 * Test/QA surface only; production planners read live signals, never this
 * slice.
 */
export function harmonicSliceSignals(
  durationS: number,
  sampleS = 1,
): { readonly atS: number; readonly signals: readonly LaneSignal[] }[] {
  const steps = abTimeline();
  const frames: { readonly atS: number; readonly signals: readonly LaneSignal[] }[] = [];
  for (let t = 0; t <= durationS; t += sampleS) {
    const atS = Math.round(t * 100) / 100;
    frames.push({
      atS,
      signals: lanesAt(atS, steps).map((lane) => ({
        laneIndex: lane.laneId,
        lifecycle: lane.lifecycle,
        mode: { ...lane.mode },
        activity: lane.activity,
        progress: lane.progress,
      })),
    });
  }
  return frames;
}
