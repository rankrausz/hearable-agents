// packages/core/src/scene/lifecycle.ts — the single ensemble-lifecycle driver.
// What this is for: the ONE planner path live, sandbox and replay all tick
// (p5-t04, ADR 0023). Callers project their lane state to `LaneSignal`
// through `laneSignalFromRender` (agent-blind: no agent, confidence or
// struggle field survives the projection) and fold one engine-clock frame
// per tick through `ensembleTick` with an explicitly owned driver — the
// driver holds the seed, the planner state, the per-lane observation trails
// and the per-lane move index, so no caller keeps hidden planner globals
// and every decision reads sample timestamps plus stored state only.
// Joins start at the lane's construction pitch (the current compatible
// part — in key, in register, common tones with the macro world) without
// retuning the lanes already here; departures drop only their own state;
// a reassigned lane (new agent, same lane) keeps its pitch but re-baselines
// its evidence and trail, so the new agent earns its own moves and the
// handover itself voices nothing (ordinary repair is not false progress).
// Restarts/resyncs (reconnect, replay seek) rebuild from the same seed with
// the snapshot as baseline, so no burst of missed notes and no duplicate
// gestures: routine moves never emit gestures at all, and hard cues keep
// their immediate attention/player path outside this driver. What it must
// not do: I/O, time, randomness, node:* or workspace imports, infer
// anything, or branch on an agent's name — `LaneSignal` carries none.
import {
  HARMONIC_DEFAULT_TUNING,
  type HarmonicMove,
  type HarmonicState,
  type HarmonicTuning,
  harmonicStartPitch,
  initialHarmonicState,
  planHarmonicStep,
} from "./harmonic.js";
import type { LaneRender, LaneSignal } from "./schema.js";

/** Seed the driver uses when the caller passes none (the QA seed). */
export const ENSEMBLE_DEFAULT_SEED = 161;

/**
 * Engine-clock gap in seconds that means resync, not continuity: a live
 * caller that sees its clock jump forward by this much (reconnect) or
 * backward at all restarts the driver from the snapshot instead of folding
 * the gap, so a resumed stream cannot burst. The driver itself folds any
 * forward time; the gap constant documents the caller-side resync rule.
 */
export const ENSEMBLE_RESYNC_GAP_S = 30;

/** Maximum observation-trail entries retained per lane (window + margin). */
const TRAIL_RETAIN_CAP = 64;

/**
 * The explicitly owned planner path: seed, tuning, planner state, the
 * per-lane observation trails the eligibility rule reads, the per-lane
 * voiced-move count behind the audio bank parity, and the last engine
 * clock folded. Plain data — the caller holds it, threads it back every
 * tick, and rebuilds it via `ensembleRestart` on reconnect/seek/restart.
 */
export type EnsembleDriver = {
  /** Seed threaded into every planning step (determinism owner). */
  readonly seed: number;
  /** Planner tuning (engine seconds and move budgets). */
  readonly tuning: HarmonicTuning;
  /** Per-lane eligibility state plus ensemble arbitration memory. */
  readonly state: HarmonicState;
  /** Per-lane observation trails: `{ atS, signal }`, ascending time. */
  readonly history: ReadonlyMap<
    number,
    readonly { readonly atS: number; readonly signal: LaneSignal }[]
  >;
  /** Per-lane count of planned moves (audio bank parity reads this). */
  readonly moveIndex: ReadonlyMap<number, number>;
  /** Engine-clock seconds of the last folded tick, if any. */
  readonly lastAtS: number | null;
};

/** Creates a fresh driver: same seed always replays the same trajectory. */
export function createEnsembleDriver(
  seed: number = ENSEMBLE_DEFAULT_SEED,
  tuning?: Partial<HarmonicTuning>,
): EnsembleDriver {
  return {
    seed,
    tuning: { ...HARMONIC_DEFAULT_TUNING, ...tuning },
    state: { lanes: new Map(), lastEnsembleAt: null },
    history: new Map(),
    moveIndex: new Map(),
    lastAtS: null,
  };
}

/**
 * Projects one render lane to the planner's signal subset: lifecycle, mode
 * weights, activity and progress only. Agent identity never enters (there
 * is no such field to read), lifecycle confidence never enters (observed
 * and inferred waiting plan identically), and struggle never enters
 * (structurally stuck phrases favour re-articulation, never a harmonic
 * move). Live, sandbox and replay all project through this one function,
 * so the three paths cannot drift apart on what the planner saw.
 */
export function laneSignalFromRender(
  lane: Pick<LaneRender, "laneId" | "lifecycle" | "mode" | "activity" | "progress">,
): LaneSignal {
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  return {
    laneIndex: lane.laneId,
    lifecycle: lane.lifecycle,
    mode: {
      exploring: clamp01(lane.mode.exploring),
      editing: clamp01(lane.mode.editing),
      testing: clamp01(lane.mode.testing),
      other: clamp01(lane.mode.other),
    },
    activity: clamp01(lane.activity),
    progress: clamp01(lane.progress),
  };
}

/** One folded tick: the updated driver plus at most one routine move. */
export type EnsembleTick = {
  readonly driver: EnsembleDriver;
  /** The planned routine move, if any — holding is the common case. */
  readonly move: HarmonicMove | null;
  /**
   * The moved lane's voice-bank index for this move (0 for its first),
   * so audio hands the note over statelessly; null when nothing moves.
   */
  readonly moveIndex: number | null;
};

/**
 * Folds one engine-clock frame through the planner: auto-joins lanes the
 * driver has never seen (acknowledging their first observed progress, so
 * joining never earns a move for work it did not do), builds each lane's
 * window trail from stored history, arbitrates at most one move, and
 * appends the frame to the trails. Deterministic: the same driver seed,
 * timestamped signal trajectory and tuning always plan the same moves,
 * however the caller slices frames, seeks, or replays at another speed —
 * every decision reads `atS` plus stored state, never tick timing. A tick
 * dated at or before the last folded tick is ignored (stale/duplicate
 * delivery voices nothing — routine moves emit no gestures at all, and
 * holds/cooldowns would block a same-time refold anyway); a caller that
 * seeks backward restarts first. Callers tick on time advance only (live
 * folds at most once per engine second — the eligibility window counts
 * samples at the 1 Hz tick, so a 10 Hz fold would shorten persistence
 * tenfold); every render still sounds through the scene path each frame,
 * the planner tick only decides routine moves.
 */
export function ensembleTick(
  driver: EnsembleDriver,
  atS: number,
  signals: readonly LaneSignal[],
  palette?: readonly number[],
): EnsembleTick {
  if (!Number.isFinite(atS) || atS < 0) return { driver, move: null, moveIndex: null };
  if (driver.lastAtS !== null && atS <= driver.lastAtS) {
    return { driver, move: null, moveIndex: null };
  }
  const tuning = driver.tuning;
  const lanes = new Map(driver.state.lanes);
  const history = new Map<number, { readonly atS: number; readonly signal: LaneSignal }[]>();
  for (const [laneIndex, trail] of driver.history) {
    history.set(laneIndex, [...trail]);
  }
  const ordered = [...signals].sort((a, b) => a.laneIndex - b.laneIndex);
  for (const signal of ordered) {
    if (!lanes.has(signal.laneIndex)) {
      // Mid-trajectory join at its construction pitch with its first
      // observed level already acknowledged: joining never retunes the
      // lanes already here, and never earns a move for progress it did
      // no new work for.
      const joined = initialHarmonicState(
        [signal.laneIndex],
        new Map([[signal.laneIndex, signal.progress]]),
      ).lanes.get(signal.laneIndex);
      if (joined !== undefined) lanes.set(signal.laneIndex, joined);
      if (!history.has(signal.laneIndex)) history.set(signal.laneIndex, []);
    }
  }
  const historyFor = new Map<number, readonly LaneSignal[]>();
  for (const signal of ordered) {
    historyFor.set(
      signal.laneIndex,
      (history.get(signal.laneIndex) ?? [])
        .filter((entry) => entry.atS >= atS - tuning.eligibilityWindowS - 1 && entry.atS < atS)
        .sort((a, b) => a.atS - b.atS)
        .map((entry) => entry.signal),
    );
  }
  const frame = ordered.map((signal) => ({ laneIndex: signal.laneIndex, atS, signal }));
  const step = planHarmonicStep(
    { lanes, lastEnsembleAt: driver.state.lastEnsembleAt },
    frame,
    historyFor,
    { seed: driver.seed, tuning, palette },
  );
  for (const signal of ordered) {
    const trail = history.get(signal.laneIndex) ?? [];
    trail.push({ atS, signal });
    const retained = trail
      .filter((entry) => entry.atS >= atS - tuning.eligibilityWindowS - 1)
      .sort((a, b) => a.atS - b.atS)
      .slice(-TRAIL_RETAIN_CAP);
    history.set(signal.laneIndex, retained);
  }
  const moveIndex = new Map(driver.moveIndex);
  let voicedIndex: number | null = null;
  if (step.move !== null) {
    voicedIndex = moveIndex.get(step.move.laneIndex) ?? 0;
    moveIndex.set(step.move.laneIndex, voicedIndex + 1);
  }
  return {
    driver: { seed: driver.seed, tuning, state: step.state, history, moveIndex, lastAtS: atS },
    move: step.move,
    moveIndex: voicedIndex,
  };
}

/**
 * Registers a lane the caller knows joined before its first signal (e.g.
 * lane allocation ahead of the first frame): it starts at its
 * construction pitch with no evidence held, like every lane. Already
 * known lanes are untouched.
 */
export function ensembleJoinLane(driver: EnsembleDriver, laneIndex: number): EnsembleDriver {
  if (driver.state.lanes.has(laneIndex)) return driver;
  const lanes = new Map(driver.state.lanes);
  lanes.set(laneIndex, {
    laneIndex,
    lastEvidence: 0,
    lastEligibleAt: null,
    lastMoveAt: null,
    pitch: harmonicStartPitch(laneIndex),
    direction: 1,
  });
  const history = new Map(driver.history);
  if (!history.has(laneIndex)) history.set(laneIndex, []);
  return {
    seed: driver.seed,
    tuning: driver.tuning,
    state: { lanes, lastEnsembleAt: driver.state.lastEnsembleAt },
    history,
    moveIndex: new Map(driver.moveIndex),
    lastAtS: driver.lastAtS,
  };
}

/**
 * Releases a departed lane: only its own planner state and trail are
 * dropped. Remaining lanes keep their pitches, holds, arbitration memory
 * and move indexes — a departure never makes all other agents move. The
 * departed lane's move count is kept so a later rejoin continues the bank
 * parity instead of retuning the bank the graph is still sounding.
 */
export function ensembleLeaveLane(driver: EnsembleDriver, laneIndex: number): EnsembleDriver {
  if (!driver.state.lanes.has(laneIndex) && !driver.history.has(laneIndex)) return driver;
  const lanes = new Map(driver.state.lanes);
  lanes.delete(laneIndex);
  const history = new Map(driver.history);
  history.delete(laneIndex);
  return {
    seed: driver.seed,
    tuning: driver.tuning,
    state: { lanes, lastEnsembleAt: driver.state.lastEnsembleAt },
    history,
    moveIndex: new Map(driver.moveIndex),
    lastAtS: driver.lastAtS,
  };
}

/**
 * Re-baselines a lane whose agent changed while the lane stayed put: the
 * lane keeps its carried pitch, direction, holds and move index (no
 * forced retune, no borrowed timing), but its current progress becomes
 * the new baseline and its old trail is cleared. The handover itself
 * earns nothing — the new agent influences only its own future
 * eligibility — and ordinary harmonic repair (the lane holding its
 * compatible part) never reads as a false progress signal.
 */
export function ensembleReassignLane(
  driver: EnsembleDriver,
  laneIndex: number,
  progress: number,
): EnsembleDriver {
  const known = driver.state.lanes.get(laneIndex);
  const lanes = new Map(driver.state.lanes);
  if (known === undefined) {
    const joined = initialHarmonicState(
      [laneIndex],
      new Map([[laneIndex, Math.min(1, Math.max(0, progress))]]),
    ).lanes.get(laneIndex);
    if (joined !== undefined) lanes.set(laneIndex, joined);
  } else {
    lanes.set(laneIndex, { ...known, lastEvidence: Math.min(1, Math.max(0, progress)) });
  }
  const history = new Map(driver.history);
  history.delete(laneIndex);
  return {
    seed: driver.seed,
    tuning: driver.tuning,
    state: { lanes, lastEnsembleAt: driver.state.lastEnsembleAt },
    history,
    moveIndex: new Map(driver.moveIndex),
    lastAtS: driver.lastAtS,
  };
}

/**
 * Restarts the path on the same seed and tuning: reconnects, replay seeks
 * and restarts rebuild from the fresh driver and fold the snapshot as its
 * baseline, so a resumed stream replays no history, misses no note it
 * should have planned, and duplicates nothing.
 */
export function ensembleRestart(driver: EnsembleDriver): EnsembleDriver {
  return createEnsembleDriver(driver.seed, driver.tuning);
}
