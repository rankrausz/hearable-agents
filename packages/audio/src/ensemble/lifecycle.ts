// packages/audio/src/ensemble/lifecycle.ts — the p5-t04 ensemble-lifecycle seam.
// What this is for: routing one mixed frame the way ADR 0021 requires —
// routine lanes (active/quiet) feed the core planner driver, while
// waiting/completion/attention keep their immediate hard-signal path and
// bypass routine eligibility, cooldowns and arbitration entirely. Joins
// take the current compatible part (the lane's construction pitch — in
// key, in register, common tones with the macro world, never a leap);
// departures release only their own lane (the scene path fades it to idle
// and no other lane's banks are touched). What it must not do: plan
// anything (planning stays in `packages/core`), sound anything, keep
// state, touch time/randomness, or delay a hard cue to a musical opening
// — one completion never resolves another lane's waiting, and the
// player's pre-emption/debouncing (question cuts, attention spacing) is
// read through untouched, never re-decided here.
import type { LaneRender, LaneSignal } from "@hearable/core";
import {
  type EnsembleDriver,
  type EnsembleTick,
  ensembleTick,
  laneSignalFromRender,
} from "@hearable/core";
import { evaluateGestureTriggers, type GestureTrigger } from "../gestures/index.js";
import { startPitchForLane } from "./palette.js";

/** Lifecycles that bypass the planner onto the immediate hard-signal path. */
export type HardCueLifecycle = "waiting" | "turn_complete" | "stale";

/** True while the lane's lifecycle bypasses routine planning. */
export function isHardCueLifecycle(lifecycle: LaneRender["lifecycle"]): boolean {
  return lifecycle === "waiting" || lifecycle === "turn_complete" || lifecycle === "stale";
}

/** True while the lane may feed the routine planner (active or quiet). */
export function isRoutineLifecycle(lifecycle: LaneRender["lifecycle"]): boolean {
  return lifecycle === "active" || lifecycle === "quiet";
}

/**
 * The current compatible part a joining lane takes: its construction
 * pitch — the D-pentatonic candidate its own voice banks are built at,
 * common tones (D/A/E/F#/B) with the macro world. Joining therefore
 * voices no move at all: the lane starts where the graph already sounds
 * it, and no lane already here retunes.
 */
export function compatiblePartForLane(laneIndex: number): number {
  return startPitchForLane(laneIndex);
}

/**
 * The lanes whose voice banks audio may touch when `departedLane` leaves:
 * exactly the departed lane (the scene path fades it to idle) and no
 * other — a departure releases its own part without making all other
 * agents move. Pure set logic the integration tests pin; the caller still
 * voices the release through the existing scene/idle path, never a move.
 */
export function lanesTouchedByLeave(
  activeLanes: readonly number[],
  departedLane: number,
): readonly number[] {
  void activeLanes;
  return [departedLane];
}

/**
 * One routed frame: the routine `LaneSignal` subset the core driver folds
 * (active/quiet lanes only — a changed agent influences its own
 * eligibility, and ordinary harmonic repair on another lane never reads
 * as a false progress signal), plus the immediate hard-cue triggers for
 * this tick. The triggers come straight from the existing evaluator over
 * the full frames — routine holds, cooldowns and arbitration are never
 * consulted, so no important cue waits for a musical opening. Routine
 * moves emit no gestures at all; the player's own pre-emption (question
 * cuts a busy bus) and debouncing (3 s refractory, 12 s attention
 * spacing) apply downstream exactly as before.
 */
export function routeEnsembleFrame(
  driver: EnsembleDriver,
  previous: readonly LaneRender[],
  next: readonly LaneRender[],
  nowS: number,
  palette?: readonly number[],
): {
  readonly driver: EnsembleDriver;
  readonly move: EnsembleTick["move"];
  readonly moveIndex: number | null;
  readonly triggers: readonly GestureTrigger[];
} {
  const routine = next.filter((lane) => isRoutineLifecycle(lane.lifecycle));
  const signals: LaneSignal[] = routine.map((lane) =>
    laneSignalFromRender({
      laneId: lane.laneId,
      lifecycle: lane.lifecycle,
      mode: lane.mode,
      activity: lane.activity,
      progress: lane.progress,
    }),
  );
  const tick = ensembleTick(driver, nowS, signals, palette);
  const triggers = evaluateGestureTriggers(previous, next, nowS);
  return { driver: tick.driver, move: tick.move, moveIndex: tick.moveIndex, triggers };
}
