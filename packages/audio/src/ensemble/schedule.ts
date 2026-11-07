// packages/audio/src/ensemble/schedule.ts — deterministic A/B scheduling.
// What this is for: deciding WHEN routine lane notes move — the one
// variable the p5-t01 A/B isolates. `independentSchedule` fires each lane
// on its own seeded Poisson-ish clock (never lane state, never agent
// events); `hybridEligibility` marks when a lane's smoothed state PERMITS
// a move (sustained activity/mode change or fresh positive progress, with
// hysteresis, minimum hold and cooldown), and `hybridSchedule` arbitrates
// eligible lanes into single moves with deterministic fair rotation.
// What it must not do: choose pitches (palette), voice audio, or read
// events — inputs are semantic LaneRender trajectories plus seed/clock.

import { createRng } from "@hearable/core";

/** One scheduled lane-note move: which lane moves, and when. */
export type EnsembleMove = {
  /** Lane index that moves (0/1/2). */
  readonly laneIndex: number;
  /** Seconds from the slice start the move sounds at. */
  readonly atS: number;
  /** New pitch the lane carries from this move until its next move. */
  readonly pitch: number;
  /** Pitch the lane carried just before this move (two-note articulation). */
  readonly fromPitch: number;
};

/** Which voice carries the move on the lane. */
export type EnsembleMode = "grain";

/** Version under comparison. */
export type EnsembleVersion = "independent" | "hybrid";

/** Minimum hold per lane: no lane moves twice inside this window. */
export const ENSEMBLE_MIN_HOLD_S = 15;

/** Cooldown between routine ensemble moves: only one move at a time. */
export const ENSEMBLE_COOLDOWN_S = 6;

/** Slice length in seconds (2–3 minute versions). */
export const ENSEMBLE_SLICE_S = 150;

/** Render seed shared by both versions (scheduling is the variable). */
export const ENSEMBLE_SEED = 161;

/**
 * Minimum smoothed activity/mode delta that counts as a sustained change
 * (hysteresis: the delta must persist across the eligibility window, not
 * spike once).
 */
export const ENSEMBLE_SUSTAINED_DELTA = 0.1;

/** Eligibility window in seconds: deltas persist across this span. */
export const ENSEMBLE_ELIGIBILITY_WINDOW_S = 8;

/** Fresh positive progress evidence earns at most this many moves. */
export const ENSEMBLE_PROGRESS_EVIDENCE_MOVES = 1;

/** Per-lane smoothed snapshot the hybrid rules read (pure data). */
export type EnsembleLaneReading = {
  readonly laneIndex: number;
  /** Smoothed activity 0..1 (engine signal, already smoothed upstream). */
  readonly activity: number;
  /** Smoothed dominant mode weight 0..1 (highest of exploring/editing/testing). */
  readonly dominantMode: number;
  /**
   * Smoothed mode weights when known: the sustained-change rule reads
   * the vector (L1) distance, so a change of mode identity with a
   * similar peak weight still counts. Absent, the rule falls back to
   * the dominant-weight delta.
   */
  readonly mode?: {
    readonly exploring: number;
    readonly editing: number;
    readonly testing: number;
  };
  /** Last positive progress evidence: progress level plus its timestamp. */
  readonly progress: number;
  readonly progressAtS: number;
  /** True while the lane is routine (active or quiet), never waiting/complete. */
  readonly routine: boolean;
};

/**
 * Independent scheduling: each lane fires on its own seeded clock —
 * seeded per (seed, lane) draws of inter-move gaps uniform in 18–30 s,
 * so moves are sparse, lane-local and provably independent of agent
 * state (no LaneRender input at all). The first move per lane lands in
 * 10–20 s so a 2–3 minute slice always hears each voice move.
 */
export function independentMoves(
  laneCount: number,
  durationS: number,
  seed: number,
  pitchFor: (laneIndex: number, moveIndex: number) => number,
): readonly EnsembleMove[] {
  const moves: EnsembleMove[] = [];
  for (let lane = 0; lane < laneCount; lane += 1) {
    const rng = createRng((seed | 0) + lane * 104729);
    let at = 10 + rng.next() * 10;
    let index = 0;
    while (at < durationS) {
      const pitch = pitchFor(lane, index);
      moves.push({
        laneIndex: lane,
        atS: round2(at),
        pitch,
        // `pitchFor` is defined at index −1 (it returns the lane's start
        // pitch), so the first move reports the pitch it actually leaves
        // rather than its own target.
        fromPitch: pitchFor(lane, index - 1),
      });
      at += 18 + rng.next() * 12;
      index += 1;
    }
  }
  return [...moves].sort(
    (a: EnsembleMove, b: EnsembleMove) => a.atS - b.atS || a.laneIndex - b.laneIndex,
  );
}

/**
 * Marks when each lane's smoothed state PERMITS a routine move (pure, per
 * lane): sustained activity/mode change (delta ≥ threshold persisting
 * across the window) or fresh positive progress evidence (progress rose
 * since the last acknowledged evidence). A held progress level never
 * re-earns; non-routine lanes are never eligible. Returns per-lane
 * eligibility times in ascending order.
 */
export function hybridEligibility(
  samples: readonly (readonly EnsembleLaneReading[])[],
  sampleS: number,
): ReadonlyMap<number, readonly number[]> {
  const out = new Map<number, number[]>();
  const lastEvidence = new Map<number, number>();
  const baselineProgress = new Map<number, number>();
  const push = (lane: number, at: number): void => {
    const list = out.get(lane) ?? [];
    list.push(round2(at));
    out.set(lane, list);
  };
  for (let step = 0; step < samples.length; step += 1) {
    const at = step * sampleS;
    const frame = samples[step];
    if (frame === undefined) continue;
    for (const reading of frame) {
      if (step === 0) baselineProgress.set(reading.laneIndex, reading.progress);
      if (!reading.routine) continue;
      const windowSteps = Math.max(1, Math.round(ENSEMBLE_ELIGIBILITY_WINDOW_S / sampleS));
      const base = step - windowSteps >= 0 ? samples[step - windowSteps] : undefined;
      const baseline = base?.find((item) => item.laneIndex === reading.laneIndex);
      if (baseline !== undefined && baseline.routine) {
        const activityDelta = Math.abs(reading.activity - baseline.activity);
        const dominantDelta = Math.abs(reading.dominantMode - baseline.dominantMode);
        const vectorDelta =
          reading.mode !== undefined && baseline.mode !== undefined
            ? Math.abs(reading.mode.exploring - baseline.mode.exploring) +
              Math.abs(reading.mode.editing - baseline.mode.editing) +
              Math.abs(reading.mode.testing - baseline.mode.testing)
            : dominantDelta;
        // The vector (L1) threshold is twice the scalar one: a full
        // identity change (e.g. editing → testing) moves ~1.0 of weight
        // across modes, so 2 × DELTA keeps the same sensitivity while
        // letting genuine mode drift earn moves.
        if (
          activityDelta >= ENSEMBLE_SUSTAINED_DELTA ||
          dominantDelta >= ENSEMBLE_SUSTAINED_DELTA ||
          vectorDelta >= ENSEMBLE_SUSTAINED_DELTA * 2
        ) {
          const eligibleAt = (step - windowSteps + 1) * sampleS;
          const list = out.get(reading.laneIndex) ?? [];
          if (
            list.length === 0 ||
            eligibleAt - (list[list.length - 1] ?? 0) >= windowSteps * sampleS
          ) {
            push(reading.laneIndex, Math.max(0, eligibleAt));
          }
        }
      }
      const seen =
        lastEvidence.get(reading.laneIndex) ?? baselineProgress.get(reading.laneIndex) ?? 0;
      if (reading.progress > seen && reading.progress > 0) {
        for (let m = 0; m < ENSEMBLE_PROGRESS_EVIDENCE_MOVES; m += 1) {
          push(reading.laneIndex, at);
        }
        lastEvidence.set(reading.laneIndex, reading.progress);
      }
    }
  }
  return out;
}

/**
 * Arbitrates eligibility into scheduled moves: walks eligibility times in
 * ascending order (deterministic fair rotation on ties: lowest lane
 * first, then round-robin), enforces the per-lane minimum hold and the
 * global cooldown, coalesces stale eligibility (an eligible time that
 * falls inside a hold/cooldown is dropped, never queued), and steps each
 * lane's pitch adjacently from its start pitch. Quiet lanes may hold
 * forever: no eligibility means no move, never a fabricated one.
 */
export function hybridSchedule(
  eligibility: ReadonlyMap<number, readonly number[]>,
  durationS: number,
  pitchStart: (laneIndex: number) => number,
  pitchStep: (laneIndex: number, current: number, direction: 1 | -1) => number,
  laneCount: number,
): readonly EnsembleMove[] {
  type Candidate = { laneIndex: number; atS: number; order: number };
  const candidates: Candidate[] = [];
  let order = 0;
  for (const [laneIndex, times] of eligibility) {
    for (const atS of times) {
      candidates.push({ laneIndex, atS, order: order++ });
    }
  }
  candidates.sort((a, b) => a.atS - b.atS || a.laneIndex - b.laneIndex || a.order - b.order);
  const moves: EnsembleMove[] = [];
  const lastMoveAt = new Map<number, number>();
  const pitchNow = new Map<number, number>();
  const direction = new Map<number, 1 | -1>();
  let lastEnsembleAt = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.atS >= durationS) continue;
    const held = candidate.atS - (lastMoveAt.get(candidate.laneIndex) ?? Number.NEGATIVE_INFINITY);
    if (held < ENSEMBLE_MIN_HOLD_S) continue;
    if (candidate.atS - lastEnsembleAt < ENSEMBLE_COOLDOWN_S) continue;
    const current = pitchNow.get(candidate.laneIndex) ?? pitchStart(candidate.laneIndex);
    const dir = direction.get(candidate.laneIndex) ?? 1;
    const next = pitchStep(candidate.laneIndex, current, dir);
    if (next === current) continue;
    moves.push({
      laneIndex: candidate.laneIndex,
      atS: round2(candidate.atS),
      pitch: next,
      fromPitch: current,
    });
    lastMoveAt.set(candidate.laneIndex, candidate.atS);
    pitchNow.set(candidate.laneIndex, next);
    lastEnsembleAt = candidate.atS;
    void laneCount;
  }
  return moves;
}

/** Rounds a schedule time to centiseconds (deterministic plan times). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
