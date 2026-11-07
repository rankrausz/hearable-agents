// packages/audio/src/ensemble/live.ts — the one live/replay wiring helper.
// What this is for: the small clock/state ownership rules every caller of
// the core ensemble driver shares — tick at most once per engine second
// (the eligibility window counts samples at the 1 Hz tick, so a 10 Hz
// fold would shorten persistence tenfold), prune departed lanes (a lane
// absent from the frame releases only its own state), and restart on
// resync gaps (reconnect, replay seek) instead of folding the gap into a
// burst. What it must not do: plan anything (the core driver owns that),
// sound anything, keep state, or change the production default — every
// caller follows ENSEMBLE_OPT_IN_DEFAULT (adopted hybrid default, p5-t06).
import { ENSEMBLE_RESYNC_GAP_S, type EnsembleDriver, ensembleLeaveLane } from "@hearable/core";

/** Planner tick cadence in engine seconds (matches the 1 Hz trail). */
export const ENSEMBLE_LIVE_TICK_S = 1;

/** Production default: the ensemble path (adopted hybrid default, p5-t06). */
export const ENSEMBLE_OPT_IN_DEFAULT = true;

/**
 * True when the caller should fold a planner tick at `nowS`: the first
 * frame always folds, later frames fold once the engine clock advanced a
 * full tick. Every render still sounds through the scene path each frame;
 * this gate only decides routine moves.
 */
export function ensembleShouldTick(lastAtS: number | null, nowS: number): boolean {
  if (!Number.isFinite(nowS) || nowS < 0) return false;
  if (lastAtS === null) return true;
  return nowS > lastAtS && nowS - lastAtS >= ENSEMBLE_LIVE_TICK_S;
}

/**
 * Releases every driver lane absent from the current frame: a departure
 * drops only its own planner state and trail, so the lanes that remain
 * keep their pitches, holds and arbitration memory. Lanes present in the
 * frame — routine or not — are kept (non-routine lanes simply never feed
 * the planner). Callers pass the DAEMON lane ids (the signals before
 * graph padding), never the padded graph frame: the graph pads departed
 * lanes with idle renders, and pruning on those would keep released
 * lanes alive forever.
 */
export function ensemblePruneDeparted(
  driver: EnsembleDriver,
  presentLaneIds: ReadonlySet<number>,
): EnsembleDriver {
  let next = driver;
  for (const laneIndex of driver.state.lanes.keys()) {
    if (!presentLaneIds.has(laneIndex)) next = ensembleLeaveLane(next, laneIndex);
  }
  return next;
}

/**
 * True when the engine clock jumped far enough forward (or backward) that
 * the caller must restart the driver from the snapshot instead of folding
 * the gap: a reconnect that resumes mid-stream replays no history, misses
 * no note it should have planned, and duplicates nothing.
 */
export function ensembleNeedsRestart(lastAtS: number | null, nowS: number): boolean {
  if (lastAtS === null) return false;
  if (!Number.isFinite(nowS)) return true;
  return nowS < lastAtS || nowS - lastAtS >= ENSEMBLE_RESYNC_GAP_S;
}
