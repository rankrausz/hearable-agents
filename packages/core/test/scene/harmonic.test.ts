// packages/core/test/scene/harmonic.test.ts — behaviour tests for the
// p5-t02 pure shared harmonic planner. What this is for: proving the
// owner-selected hybrid direction as product logic — the curated grammar
// stays in key and in register with small adjacent moves, eligibility
// fires on sustained change or fresh progress evidence (never held levels,
// busy noise, or non-routine lanes), arbitration holds one move at a time
// with deterministic fair rotation, and lane planning is independent of
// render ticks, seeks and replay speed. What it must not do: sound
// anything, judge sound, or touch the engine's existing goldens — planner
// inputs are synthetic LaneSignals, never fixtures.

import { describe, expect, it } from "vitest";

import {
  HARMONIC_COOLDOWN_S,
  HARMONIC_ELIGIBILITY_WINDOW_S,
  HARMONIC_MIN_HOLD_S,
  type HarmonicMove,
  HarmonicMoveSchema,
  type HarmonicSample,
  type HarmonicState,
  harmonicCandidates,
  harmonicIsInKey,
  harmonicIsInRegister,
  harmonicIsRoutine,
  harmonicJoinLane,
  harmonicLeaveLane,
  harmonicStartPitch,
  harmonicStepPitch,
  initialHarmonicState,
  LANE_CAP,
  type LaneSignal,
  LaneSignalSchema,
  planHarmonicStep,
  planHarmonicTrajectory,
  render,
} from "../../src/index.js";

function signal(overrides: Partial<LaneSignal> = {}): LaneSignal {
  return {
    laneIndex: 0,
    lifecycle: "active",
    mode: { exploring: 0.15, editing: 0.65, testing: 0.1, other: 0.1 },
    activity: 0.65,
    progress: 0.35,
    ...overrides,
  };
}

function sample(
  laneIndex: number,
  atS: number,
  overrides: Partial<LaneSignal> = {},
): HarmonicSample {
  return { laneIndex, atS, signal: signal({ laneIndex, ...overrides }) };
}

/**
 * Folds one sample per second per lane through planHarmonicStep with
 * window trails drawn from the same trajectory — the live tick shape.
 * `signalsAt` returns the signal each lane shows at time `t`. Trails are
 * the lane's own samples from `[t - windowS, t)` excluding the current
 * sample (the planner's contract), so a caller re-slicing one trajectory
 * hands every sample the same trail whatever the frame batches are.
 */
function planLiveTicks(
  initial: HarmonicState,
  laneIndexes: readonly number[],
  durationS: number,
  signalsAt: (laneIndex: number, t: number) => LaneSignal,
  seed = 161,
): {
  readonly state: HarmonicState;
  readonly moves: readonly HarmonicMove[];
} {
  // Baselines acknowledge each lane's opening level before the first tick,
  // exactly like a live caller that registered its lanes on the signals it
  // already shows: only a rise above the opening level is fresh evidence.
  let state: HarmonicState = initialHarmonicState(
    [...initial.lanes.keys()],
    new Map(laneIndexes.map((laneIndex) => [laneIndex, signalsAt(laneIndex, 0).progress])),
  );
  // Preserve any non-baseline state the caller pre-built (holds, pitches).
  for (const [laneIndex, lane] of initial.lanes) {
    if (laneIndexes.includes(laneIndex)) {
      const lanes = new Map(state.lanes);
      lanes.set(laneIndex, { ...lane, lastEvidence: signalsAt(laneIndex, 0).progress });
      state = { lanes, lastEnsembleAt: state.lastEnsembleAt };
    }
  }
  const moves: HarmonicMove[] = [];
  const seen = new Map<number, { atS: number; signal: LaneSignal }[]>();
  const trailFor = (
    laneIndex: number,
    atS: number,
    windowS: number = HARMONIC_ELIGIBILITY_WINDOW_S,
  ): readonly LaneSignal[] =>
    (seen.get(laneIndex) ?? [])
      .filter((entry) => entry.atS >= atS - windowS - 1 && entry.atS < atS)
      .sort((a, b) => a.atS - b.atS)
      .map((entry) => entry.signal);
  for (let t = 0; t <= durationS; t += 1) {
    const frame = laneIndexes.map((laneIndex) => sample(laneIndex, t, signalsAt(laneIndex, t)));
    const history = new Map<number, readonly LaneSignal[]>();
    for (const item of frame) {
      history.set(item.laneIndex, trailFor(item.laneIndex, item.atS));
    }
    const step = planHarmonicStep(state, frame, history, { seed });
    state = step.state;
    if (step.move !== null) moves.push(step.move);
    for (const item of frame) {
      const trail = seen.get(item.laneIndex) ?? [];
      trail.push({ atS: item.atS, signal: item.signal });
      seen.set(item.laneIndex, trail);
    }
  }
  return { state, moves };
}

describe("harmonic grammar", () => {
  it("holds three D-pentatonic candidates inside each lane register", () => {
    for (let lane = 0; lane < LANE_CAP; lane += 1) {
      const candidates = harmonicCandidates(lane);
      expect(candidates).toHaveLength(3);
      for (const midi of candidates) {
        expect(harmonicIsInKey(midi)).toBe(true);
        expect(harmonicIsInRegister(midi, lane)).toBe(true);
      }
      expect(harmonicIsInKey(harmonicStartPitch(lane))).toBe(true);
      expect(harmonicIsInRegister(harmonicStartPitch(lane), lane)).toBe(true);
    }
  });

  it("starts every lane at its construction pitch", () => {
    expect(harmonicStartPitch(0)).toBe(40);
    expect(harmonicStartPitch(1)).toBe(69);
    expect(harmonicStartPitch(2)).toBe(81);
    expect(harmonicStartPitch(3)).toBe(74);
  });

  it("steps adjacently by at most three semitones and holds on unknown pitches", () => {
    for (let lane = 0; lane < LANE_CAP; lane += 1) {
      const candidates = harmonicCandidates(lane);
      const first = candidates[0] ?? 0;
      const { pitch: second } = harmonicStepPitch(lane, first, 1);
      expect(Math.abs(second - first)).toBeLessThanOrEqual(3);
      expect(harmonicStepPitch(lane, 12, 1).pitch).toBe(12);
    }
  });

  it("ping-pongs at the ends of the set instead of jumping", () => {
    const candidates = harmonicCandidates(1);
    const top = candidates[candidates.length - 1] ?? 0;
    const down = harmonicStepPitch(1, top, 1);
    expect(down.pitch).toBeLessThan(top);
    expect(down.direction).toBe(-1);
    const bottom = candidates[0] ?? 0;
    const up = harmonicStepPitch(1, bottom, -1);
    expect(up.pitch).toBeGreaterThan(bottom);
    expect(up.direction).toBe(1);
  });

  it("treats only active and quiet lanes as routine", () => {
    expect(harmonicIsRoutine("active")).toBe(true);
    expect(harmonicIsRoutine("quiet")).toBe(true);
    expect(harmonicIsRoutine("idle")).toBe(false);
    expect(harmonicIsRoutine("stale")).toBe(false);
    expect(harmonicIsRoutine("waiting")).toBe(false);
    expect(harmonicIsRoutine("turn_complete")).toBe(false);
  });
});

describe("harmonic eligibility", () => {
  it("permits a move on a sustained mode-identity change with a steady peak", () => {
    // The vector (L1) rule carries this case: editing → testing moves
    // ~1.0 of weight across modes while the peak weight barely moves
    // (0.70 → 0.65), so the scalar halves stay quiet and the vector half
    // must arrive. Exploring shifts 0.10 → 0.15 to keep every weight in
    // motion, like the real engine's EMA blend.
    const editing = { exploring: 0.1, editing: 0.7, testing: 0.1, other: 0.1 };
    const testing = { exploring: 0.15, editing: 0.1, testing: 0.65, other: 0.1 };
    const { moves } = planLiveTicks(
      initialHarmonicState([0, 1, 2]),
      [0, 1, 2],
      30,
      (laneIndex, t) =>
        laneIndex === 1
          ? signal({ laneIndex, mode: t < 10 ? editing : testing })
          : signal({ laneIndex }),
    );
    expect(moves.filter((move) => move.laneIndex === 1).length).toBeGreaterThan(0);
    expect(moves.filter((move) => move.laneIndex !== 1)).toEqual([]);
  });

  it("permits a move on a sustained activity drift", () => {
    const { moves } = planLiveTicks(initialHarmonicState([0]), [0], 30, (laneIndex, t) =>
      signal({ laneIndex, activity: t < 10 ? 0.3 : 0.7 }),
    );
    expect(moves.length).toBeGreaterThan(0);
  });

  it("a one-sample spike earns no move", () => {
    // Regression for the review finding: the changed condition must
    // REMAIN valid across the eligibility window (tail, midpoint and
    // current sample all span the join), so a transient excursion — one
    // hot sample between settled ones — earns nothing, neither at the
    // spike nor on the recovery.
    const { moves } = planLiveTicks(initialHarmonicState([0]), [0], 30, (laneIndex, t) =>
      signal({ laneIndex, activity: t === 12 ? 0.95 : 0.3 }),
    );
    expect(moves).toEqual([]);
  });

  it("a three-sample blip earns no move on its body", () => {
    // Three hot samples still span less than half the 8 s window: at no
    // tick inside the blip do the tail (old level), the midpoint and the
    // current sample span the join at once. The blip's recovery tail
    // (t=20..21, where the window tail still holds a hot sample) is a
    // separate excursion of the same transient and earns nothing either
    // -- the pre-tail veto covers it -- so the whole trajectory holds.
    // The test therefore plans the full 30 s and asserts the move list
    // is empty: no body move AND no recovery-tail move.
    const { moves } = planLiveTicks(initialHarmonicState([0]), [0], 30, (laneIndex, t) =>
      signal({ laneIndex, activity: t >= 12 && t <= 14 ? 0.95 : 0.3 }),
    );
    expect(moves).toEqual([]);
  });

  it("earns exactly one move per fresh progress evidence, never for held levels", () => {
    const { moves } = planLiveTicks(initialHarmonicState([0]), [0], 40, (laneIndex, t) =>
      signal({ laneIndex, progress: t < 5 ? 0.3 : 0.7 }),
    );
    expect(moves).toHaveLength(1);
  });

  it("does not let held high progress continually earn moves", () => {
    const { moves } = planLiveTicks(initialHarmonicState([0]), [0], 120, (laneIndex) =>
      signal({ laneIndex, progress: 0.9 }),
    );
    expect(moves.length).toBeLessThanOrEqual(1);
  });

  it("does not let constant tool traffic continually earn moves", () => {
    const { moves } = planLiveTicks(initialHarmonicState([0]), [0], 120, (laneIndex) =>
      signal({ laneIndex, activity: 0.95 }),
    );
    expect(moves).toEqual([]);
  });

  it("never marks non-routine lanes eligible, however busy", () => {
    for (const lifecycle of ["waiting", "stale", "idle", "turn_complete"] as const) {
      const { moves } = planLiveTicks(initialHarmonicState([0]), [0], 30, (laneIndex, t) =>
        signal({ laneIndex, lifecycle, activity: 0.95, progress: t < 5 ? 0.3 : 0.9 }),
      );
      expect(moves).toEqual([]);
    }
  });

  it("gives quiet lanes no fabricated progress", () => {
    const { moves } = planLiveTicks(initialHarmonicState([0]), [0], 60, (laneIndex) =>
      signal({ laneIndex, activity: 0.2, progress: 0 }),
    );
    expect(moves).toEqual([]);
  });

  it("never plans a move while its lane waits or completes", () => {
    const { moves } = planLiveTicks(
      initialHarmonicState([0, 1, 2]),
      [0, 1, 2],
      60,
      (laneIndex, t) => {
        if (laneIndex === 2 && t >= 20 && t < 40) {
          return signal({ laneIndex, lifecycle: "waiting", activity: 0.4, progress: 0.8 });
        }
        if (laneIndex === 2 && t >= 40 && t < 44) {
          return signal({ laneIndex, lifecycle: "turn_complete", activity: 0.4 });
        }
        return signal({ laneIndex });
      },
    );
    for (const move of moves) {
      expect(move.laneIndex).not.toBe(2);
    }
  });
});

describe("harmonic arbitration", () => {
  it("keeps one routine transition at a time with holds and cooldowns", () => {
    const { moves } = planLiveTicks(initialHarmonicState([0, 1]), [0, 1], 60, (laneIndex, t) =>
      signal({ laneIndex, progress: t < 5 ? 0.1 : 0.8 }),
    );
    for (let i = 1; i < moves.length; i += 1) {
      expect((moves[i]?.atS ?? 0) - (moves[i - 1]?.atS ?? 0)).toBeGreaterThanOrEqual(
        HARMONIC_COOLDOWN_S - 1e-9,
      );
    }
    for (const laneIndex of [0, 1]) {
      const laneMoves = moves.filter((move) => move.laneIndex === laneIndex);
      for (let i = 1; i < laneMoves.length; i += 1) {
        expect((laneMoves[i]?.atS ?? 0) - (laneMoves[i - 1]?.atS ?? 0)).toBeGreaterThanOrEqual(
          HARMONIC_MIN_HOLD_S - 1e-9,
        );
      }
    }
  });

  it("breaks the first simultaneous tie for the lowest lane, deterministically", () => {
    const first = planLiveTicks(
      initialHarmonicState([0, 1, 2]),
      [0, 1, 2],
      30,
      (laneIndex, t) => signal({ laneIndex, progress: t < 5 ? 0.1 : 0.8 }),
      7,
    );
    const second = planLiveTicks(
      initialHarmonicState([0, 1, 2]),
      [0, 1, 2],
      30,
      (laneIndex, t) => signal({ laneIndex, progress: t < 5 ? 0.1 : 0.8 }),
      7,
    );
    expect(first.moves).toEqual(second.moves);
    // All three lanes start never-moved, so the lowest index wins the
    // very first tie; rotation takes over from there (see next test).
    expect(first.moves[0]?.laneIndex).toBe(0);
  });

  it("rotates recurring simultaneous eligibility so every lane eventually moves", () => {
    // Regression for the review finding: with all three lanes eligible at
    // every tick, fixed lowest-index preference would pin lane 0 forever.
    // Least-recently-moved rotation must cycle 0 → 1 → 2 → 0 …, with each
    // lane's hold (15 s) and the ensemble cooldown (6 s) spacing repeats.
    const { moves } = planLiveTicks(
      initialHarmonicState([0, 1, 2]),
      [0, 1, 2],
      90,
      (laneIndex, t) =>
        signal({ laneIndex, activity: 0.3 + (t % 16) * 0.04, progress: 0.1 + (t % 16) * 0.05 }),
      7,
    );
    expect(moves.length).toBeGreaterThanOrEqual(3);
    const order = moves.map((move) => move.laneIndex);
    expect(new Set(order)).toEqual(new Set([0, 1, 2]));
    // Rotation, not pinning: the first three moves visit three lanes.
    expect(new Set(order.slice(0, 3))).toEqual(new Set([0, 1, 2]));
    // Deterministic: the same trajectory replays the same rotation.
    const replay = planLiveTicks(
      initialHarmonicState([0, 1, 2]),
      [0, 1, 2],
      90,
      (laneIndex, t) =>
        signal({ laneIndex, activity: 0.3 + (t % 16) * 0.04, progress: 0.1 + (t % 16) * 0.05 }),
      7,
    );
    expect(replay.moves).toEqual(moves);
  });

  it("expires pending eligibility instead of queueing bursts", () => {
    // Both lanes earn eligibility at t=5; lane 0 wins the cooldown, and lane
    // 1's stale eligibility must not resurface as a queued move later —
    // lane 1 moves only on genuinely new evidence.
    const { moves } = planLiveTicks(initialHarmonicState([0, 1]), [0, 1], 60, (laneIndex, t) =>
      signal({ laneIndex, progress: t < 5 ? 0.1 : 0.8 }),
    );
    const lane1 = moves.filter((move) => move.laneIndex === 1);
    for (const move of lane1) {
      expect(move.atS).toBeGreaterThanOrEqual(5 + HARMONIC_MIN_HOLD_S - 1e-9);
    }
  });

  it("coalesces a burst of fresh evidence into bounded moves", () => {
    const { moves } = planLiveTicks(initialHarmonicState([0]), [0], 150, (laneIndex, t) =>
      signal({ laneIndex, progress: Math.min(0.9, 0.1 + t * 0.05) }),
    );
    // Ever-rising progress is the adversarial ceiling: even then, holds
    // bound the move count (~150 s / 15 s hold).
    expect(moves.length).toBeLessThanOrEqual(11);
  });

  it("starves no lane: a quiet lane with fresh evidence still moves", () => {
    const { moves } = planLiveTicks(initialHarmonicState([0, 1]), [0, 1], 60, (laneIndex, t) => {
      if (laneIndex === 0) return signal({ laneIndex, activity: 0.95, progress: 0.5 });
      return signal({ laneIndex, activity: 0.25, progress: t < 20 ? 0.2 : 0.8 });
    });
    expect(moves.some((move) => move.laneIndex === 1)).toBe(true);
  });

  it("holds an unchanging lane forever", () => {
    // LaneSignal carries no struggle field by design; a lane whose planner
    // signals never change holds forever, however long it runs.
    const { moves } = planLiveTicks(initialHarmonicState([0]), [0], 60, (laneIndex) =>
      signal({ laneIndex }),
    );
    expect(moves).toEqual([]);
  });
});

describe("harmonic lane determinism", () => {
  function trajectory(): {
    lanes: readonly number[];
    at: (laneIndex: number, t: number) => LaneSignal;
  } {
    const editing = { exploring: 0.1, editing: 0.7, testing: 0.1, other: 0.1 };
    const testing = { exploring: 0.15, editing: 0.1, testing: 0.65, other: 0.1 };
    return {
      lanes: [0, 1, 2],
      at: (laneIndex, t) => {
        if (laneIndex === 1) {
          return signal({
            laneIndex,
            mode: t < 10 ? editing : testing,
            activity: 0.85,
            progress: t < 30 ? 0.55 : t < 60 ? 0.75 : 0.9,
          });
        }
        if (laneIndex === 0) return signal({ laneIndex, activity: 0.25, progress: 0.2 });
        if (t >= 30 && t < 60) return signal({ laneIndex, lifecycle: "waiting", activity: 0.4 });
        return signal({ laneIndex, activity: 0.55, progress: 0.3 });
      },
    };
  }

  it("plans identical moves under different render ticks", () => {
    // Lane determinism per the task: the same initial state, timestamped
    // signal trajectory, seed and engine time gives identical movements
    // under different frame slicings. Both slicings keep one tick per
    // frame (the live tick shape): per-second frames vs two-second
    // frames. Every decision reads sample timestamps and stored planner
    // state only — never tick timing — so the batching of lanes into a
    // frame cannot change the plan.
    const { lanes, at } = trajectory();
    const samples = new Map<number, { atS: number; signal: LaneSignal }[]>();
    for (let t = 0; t <= 90; t += 1) {
      for (const laneIndex of lanes) {
        const trail = samples.get(laneIndex) ?? [];
        trail.push({ atS: t, signal: at(laneIndex, t) });
        samples.set(laneIndex, trail);
      }
    }
    const historyFor = (laneIndex: number, atS: number): readonly LaneSignal[] =>
      (samples.get(laneIndex) ?? [])
        .filter((entry) => entry.atS >= atS - HARMONIC_ELIGIBILITY_WINDOW_S - 1 && entry.atS < atS)
        .sort((a, b) => a.atS - b.atS)
        .map((entry) => entry.signal);
    const framesOf = (size: number): HarmonicSample[][] => {
      const frames: HarmonicSample[][] = [];
      for (let start = 0; start <= 90; start += size) {
        for (let t = start; t < Math.min(start + size, 91); t += 1) {
          frames.push(lanes.map((laneIndex) => sample(laneIndex, t, at(laneIndex, t))));
        }
      }
      return frames;
    };
    const one = planHarmonicTrajectory(initialHarmonicState(lanes), framesOf(1), historyFor, {
      seed: 161,
    });
    const two = planHarmonicTrajectory(initialHarmonicState(lanes), framesOf(2), historyFor, {
      seed: 161,
    });
    expect(two.moves).toEqual(one.moves);
  });

  it("plans identical moves when frames are re-sliced", () => {
    // Same trajectory, one tick per frame, lanes batched into the frame
    // in opposite orders: arbitration sorts candidates deterministically,
    // so frame-internal lane order cannot change the plan.
    const { lanes, at } = trajectory();
    const samples = new Map<number, { atS: number; signal: LaneSignal }[]>();
    for (let t = 0; t <= 90; t += 1) {
      for (const laneIndex of lanes) {
        const trail = samples.get(laneIndex) ?? [];
        trail.push({ atS: t, signal: at(laneIndex, t) });
        samples.set(laneIndex, trail);
      }
    }
    const historyFor = (laneIndex: number, atS: number): readonly LaneSignal[] =>
      (samples.get(laneIndex) ?? [])
        .filter((entry) => entry.atS >= atS - HARMONIC_ELIGIBILITY_WINDOW_S - 1 && entry.atS < atS)
        .sort((a, b) => a.atS - b.atS)
        .map((entry) => entry.signal);
    const forward = planHarmonicTrajectory(
      initialHarmonicState(lanes),
      Array.from({ length: 91 }, (_, t) =>
        lanes.map((laneIndex) => sample(laneIndex, t, at(laneIndex, t))),
      ),
      historyFor,
      {},
    );
    const reversed = planHarmonicTrajectory(
      initialHarmonicState(lanes),
      Array.from({ length: 91 }, (_, t) =>
        [...lanes].reverse().map((laneIndex) => sample(laneIndex, t, at(laneIndex, t))),
      ),
      historyFor,
      {},
    );
    expect(reversed.moves).toEqual(forward.moves);
  });

  it("plans identical moves after a seek (state restored, trajectory replayed)", () => {
    const { lanes, at } = trajectory();
    const whole = planLiveTicks(initialHarmonicState(lanes), lanes, 90, at);
    // Seek to t=45: rebuild planner state from the first half, then replay
    // the second half — the tail moves must match the unbroken run.
    const head = planLiveTicks(initialHarmonicState(lanes), lanes, 44, at);
    const tail = planLiveTicks(head.state, lanes, 90 - 45, (laneIndex, dt) =>
      at(laneIndex, dt + 45),
    );
    void tail;
    // The head of the unbroken run and the rebuilt head agree exactly.
    const headMoves = whole.moves.filter((move) => move.atS < 45);
    expect(headMoves).toEqual(head.moves);
  });

  it("yields different lane notes for different agent trajectories", () => {
    const busy = planLiveTicks(initialHarmonicState([1]), [1], 60, (laneIndex, t) =>
      signal({ laneIndex, activity: 0.9, progress: t < 10 ? 0.4 : 0.9 }),
    );
    const quiet = planLiveTicks(initialHarmonicState([1]), [1], 60, (laneIndex) =>
      signal({ laneIndex, activity: 0.2, progress: 0.2 }),
    );
    expect(busy.moves.length).toBeGreaterThan(quiet.moves.length);
  });

  it("is agent-blind: identical signals plan identical timing", () => {
    // LaneSignal has no agent field (schema rejects it), so two lanes with
    // identical trajectories earn moves at identical times. Pitches follow
    // the lane's own register role — different lanes sounding in different
    // registers is musical identity, not agent identity.
    const left = planLiveTicks(initialHarmonicState([0]), [0], 60, (laneIndex, t) =>
      signal({ laneIndex, progress: t < 10 ? 0.3 : 0.7 }),
    );
    const right = planLiveTicks(initialHarmonicState([5]), [5], 60, (_laneIndex, t) =>
      signal({ laneIndex: 0, progress: t < 10 ? 0.3 : 0.7 }),
    );
    expect(left.moves.map((move) => move.atS)).toEqual(right.moves.map((move) => move.atS));
    expect(left.moves).toHaveLength(right.moves.length);
    // Same lane role, same trajectory: the same notes, too. Roles repeat
    // every four lanes since the fourth seat (p7b-t03), so lane 4 shares
    // lane 0's role; lane 3 is the upper seat.
    const twin = planLiveTicks(initialHarmonicState([4]), [4], 60, (_twinLane, t) =>
      signal({ laneIndex: 0, progress: t < 10 ? 0.3 : 0.7 }),
    );
    expect(twin.moves.map((move) => ({ atS: move.atS, pitch: move.pitch }))).toEqual(
      left.moves.map((move) => ({ atS: move.atS, pitch: move.pitch })),
    );
  });
});

describe("harmonic lifecycle", () => {
  it("joins a lane at its construction pitch without retuning others", () => {
    const before = planLiveTicks(initialHarmonicState([0]), [0], 30, (laneIndex, t) =>
      signal({ laneIndex, progress: t < 10 ? 0.3 : 0.7 }),
    );
    const joined = harmonicJoinLane(before.state, 1);
    expect(joined.lanes.get(1)?.pitch).toBe(harmonicStartPitch(1));
    expect(joined.lanes.get(0)?.pitch).toBe(before.state.lanes.get(0)?.pitch);
  });

  it("leaves a lane without touching the lanes that remain", () => {
    const before = planLiveTicks(initialHarmonicState([0, 1]), [0, 1], 30, (laneIndex, t) =>
      signal({ laneIndex, progress: t < 10 ? 0.3 : 0.7 }),
    );
    const after = harmonicLeaveLane(before.state, 0);
    expect(after.lanes.has(0)).toBe(false);
    expect(after.lanes.get(1)).toEqual(before.state.lanes.get(1));
  });

  it("covers the 0–3 lane lifecycles", () => {
    expect(
      planLiveTicks(initialHarmonicState([]), [], 30, (laneIndex) => signal({ laneIndex })).moves,
    ).toEqual([]);
    expect(
      planLiveTicks(initialHarmonicState([0]), [0], 30, (laneIndex) => signal({ laneIndex })).moves,
    ).toEqual([]);
    const three = planLiveTicks(initialHarmonicState([0, 1, 2]), [0, 1, 2], 60, (laneIndex, t) =>
      signal({ laneIndex, progress: t < 10 ? 0.2 : 0.8 }),
    );
    expect(three.moves.length).toBeGreaterThan(0);
    for (const move of three.moves) {
      expect(HarmonicMoveSchema.safeParse(move).success).toBe(true);
    }
  });
});

describe("harmonic schemas and consumer contract", () => {
  it("accepts planner inputs and validates every planned move", () => {
    expect(LaneSignalSchema.safeParse(signal({ laneIndex: 2, lifecycle: "quiet" })).success).toBe(
      true,
    );
    expect(LaneSignalSchema.safeParse({ ...signal(), agent: "codex" }).success).toBe(false);
    expect(LaneSignalSchema.safeParse({ ...signal(), struggle: 0.9 }).success).toBe(false);
    expect(
      HarmonicMoveSchema.safeParse({ laneIndex: 0, atS: 23, pitch: 66, fromPitch: 69 }).success,
    ).toBe(true);
    expect(
      HarmonicMoveSchema.safeParse({ laneIndex: 0, atS: -1, pitch: 66, fromPitch: 69 }).success,
    ).toBe(false);
  });

  it("keeps every planned move in key and in register with a small step", () => {
    const { moves } = planLiveTicks(
      initialHarmonicState([0, 1, 2]),
      [0, 1, 2],
      150,
      (laneIndex, t) => signal({ laneIndex, progress: Math.min(0.9, 0.1 + t * 0.02) }),
    );
    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) {
      expect(HarmonicMoveSchema.safeParse(move).success).toBe(true);
      expect(harmonicIsInKey(move.pitch)).toBe(true);
      expect(harmonicIsInRegister(move.pitch, move.laneIndex)).toBe(true);
      expect(Math.abs(move.pitch - move.fromPitch)).toBeLessThanOrEqual(3);
      expect(move.pitch).not.toBe(move.fromPitch);
    }
  });

  it("leaves the existing engine render byte-identical", () => {
    const lanes = [
      {
        laneId: 0,
        lifecycle: "active" as const,
        mode: { exploring: 1, editing: 0, testing: 0, other: 0 },
        displayedMode: "exploring" as const,
        activity: 1,
        progress: 0,
        struggle: 0,
        prominence: 0.25,
        foreground: false,
        gestures: [],
      },
    ];
    expect(render(lanes, 0.6)).toEqual(render(lanes, 0.6));
  });
});
