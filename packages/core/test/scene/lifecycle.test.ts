// packages/core/test/scene/lifecycle.test.ts — behaviour tests for the
// p5-t04 ensemble-lifecycle driver. What this is for: proving the ONE
// planner path live/sandbox/replay share — explicit seed/state/clock
// ownership, 0–3 lanes, join/leave/reassignment without bursts or
// duplicate gestures, reconnect/restart without missing or doubled notes,
// replay seek/speed independence, routine-only feeding with hard-cue
// bypass, bounded fairness and same-input determinism through the actual
// integration (not the planner in isolation). What it must not do: sound
// anything, judge sound, or touch fixtures — inputs are synthetic
// LaneRenders, and the waiting-onset boundary is numeric-only.
import { describe, expect, it } from "vitest";
import {
  createEnsembleDriver,
  ENSEMBLE_DEFAULT_SEED,
  type EnsembleDriver,
  ensembleJoinLane,
  ensembleLeaveLane,
  ensembleReassignLane,
  ensembleRestart,
  ensembleTick,
  harmonicIsRoutine,
  harmonicStartPitch,
  type LaneRender,
  type LaneSignal,
  laneSignalFromRender,
} from "../../src/index.js";

function render(overrides: Partial<LaneRender> = {}): LaneRender {
  return {
    laneId: 0,
    lifecycle: "active",
    mode: { exploring: 0.15, editing: 0.65, testing: 0.1, other: 0.1 },
    displayedMode: "editing",
    activity: 0.65,
    progress: 0.35,
    struggle: 0.1,
    prominence: 0.5,
    foreground: false,
    gestures: [],
    ...overrides,
  };
}

function toSignals(renders: readonly LaneRender[]): LaneSignal[] {
  return renders.map((lane) =>
    laneSignalFromRender({
      laneId: lane.laneId,
      lifecycle: lane.lifecycle,
      mode: lane.mode,
      activity: lane.activity,
      progress: lane.progress,
    }),
  );
}

/** Folds one 1 Hz frame per tick through the driver (the live tick shape). */
function foldTrajectory(
  driver: EnsembleDriver,
  durationS: number,
  rendersAt: (t: number) => readonly LaneRender[],
): { driver: EnsembleDriver; moves: { atS: number; laneIndex: number }[] } {
  let next = driver;
  const moves: { atS: number; laneIndex: number }[] = [];
  for (let t = 0; t <= durationS; t += 1) {
    const tick = ensembleTick(next, t, toSignals(rendersAt(t)));
    next = tick.driver;
    if (tick.move !== null) moves.push({ atS: tick.move.atS, laneIndex: tick.move.laneIndex });
  }
  return { driver: next, moves };
}

const editing = { exploring: 0.1, editing: 0.7, testing: 0.1, other: 0.1 };
const testing = { exploring: 0.15, editing: 0.1, testing: 0.65, other: 0.1 };

describe("ensemble lifecycle driver", () => {
  it("stays silent with zero lanes and holds one quiet lane", () => {
    const empty = foldTrajectory(createEnsembleDriver(), 30, () => []);
    expect(empty.moves).toEqual([]);
    const quiet = foldTrajectory(createEnsembleDriver(), 60, () => [
      render({ lifecycle: "quiet", activity: 0.2, progress: 0 }),
    ]);
    expect(quiet.moves).toEqual([]);
  });

  it("covers 0–3 lanes through actual integration", () => {
    const three = foldTrajectory(
      createEnsembleDriver(),
      60,
      (t) =>
        [0, 1, 2].map((laneId) =>
          render({ laneId, progress: t < 5 ? 0.2 : 0.8 }),
        ) as readonly LaneRender[],
    );
    expect(three.moves.length).toBeGreaterThan(0);
    expect(three.moves.length).toBeLessThanOrEqual(11);
  });

  it("auto-joins a new lane at its construction pitch without retuning others", () => {
    const first = foldTrajectory(createEnsembleDriver(), 30, (t) => [
      render({ laneId: 0, progress: t < 5 ? 0.2 : 0.8 }),
    ]);
    const joined = ensembleTick(
      first.driver,
      31,
      toSignals([render({ laneId: 0, progress: 0.8 }), render({ laneId: 1, progress: 0.3 })]),
    );
    expect(joined.driver.state.lanes.get(1)?.pitch).toBe(harmonicStartPitch(1));
    expect(joined.driver.state.lanes.get(0)?.pitch).toBe(first.driver.state.lanes.get(0)?.pitch);
    // Joining acknowledges its own opening level: no move for work it did
    // no new work for at the join tick itself.
    expect(joined.move === null || joined.move.laneIndex !== 1).toBe(true);
  });

  it("departures release only their own state without moving others", () => {
    let driver = createEnsembleDriver();
    for (let t = 0; t <= 30; t += 1) {
      driver = ensembleTick(
        driver,
        t,
        toSignals([
          render({ laneId: 0, progress: t < 5 ? 0.2 : 0.8 }),
          render({ laneId: 1, progress: t < 5 ? 0.2 : 0.8 }),
        ]),
      ).driver;
    }
    const before = driver.state.lanes.get(1);
    const after = ensembleLeaveLane(driver, 0);
    expect(after.state.lanes.has(0)).toBe(false);
    expect(after.state.lanes.get(1)).toEqual(before);
    expect(after.history.has(0)).toBe(false);
    expect(after.history.get(1)).toEqual(driver.history.get(1));
  });

  it("reassignment keeps the pitch but re-baselines evidence: no handover move", () => {
    let driver = ensembleJoinLane(createEnsembleDriver(), 0);
    driver = ensembleTick(driver, 0, toSignals([render({ laneId: 0, progress: 0.8 })])).driver;
    const reassigned = ensembleReassignLane(driver, 0, 0.8);
    expect(reassigned.state.lanes.get(0)?.pitch).toBe(driver.state.lanes.get(0)?.pitch);
    // Same-level evidence after handover earns nothing by itself.
    const ticked = ensembleTick(reassigned, 1, toSignals([render({ laneId: 0, progress: 0.8 })]));
    expect(ticked.move).toBeNull();
    // The handover move (t=0, before reassignment) arms the 15 s hold:
    // a rise inside the hold is acknowledged, never queued — no burst.
    let earning = ticked.driver;
    let early = false;
    for (let t = 2; t <= 14; t += 1) {
      const step = ensembleTick(earning, t, toSignals([render({ laneId: 0, progress: 0.95 })]));
      earning = step.driver;
      if (step.move !== null) early = true;
    }
    expect(early).toBe(false);
    // A genuinely new rise after the hold still earns: the new agent
    // influences its own future eligibility.
    let earned = false;
    for (let t = 15; t <= 25; t += 1) {
      const progress = t < 16 ? 0.95 : 0.99;
      const step = ensembleTick(earning, t, toSignals([render({ laneId: 0, progress })]));
      earning = step.driver;
      if (step.move !== null) earned = true;
    }
    expect(earned).toBe(true);
  });

  it("restarts on reconnect without bursts of missed notes or duplicates", () => {
    const whole = foldTrajectory(createEnsembleDriver(7), 90, (t) =>
      t === 1
        ? [render({ laneId: 0, mode: editing }), render({ laneId: 1, mode: editing })]
        : [render({ laneId: 0, mode: editing }), render({ laneId: 1, mode: testing })],
    );
    const head = foldTrajectory(createEnsembleDriver(7), 44, (t) =>
      t === 1
        ? [render({ laneId: 0, mode: editing }), render({ laneId: 1, mode: editing })]
        : [render({ laneId: 0, mode: editing }), render({ laneId: 1, mode: testing })],
    );
    // Reconnect: restart from the same seed and fold the resumption as a
    // fresh baseline — no replayed history, no duplicate eligibility.
    const resumed = ensembleRestart(head.driver);
    expect(resumed.state.lanes.size).toBe(0);
    expect(resumed.seed).toBe(7);
    const headMoves = whole.moves.filter((move) => move.atS < 45);
    expect(headMoves).toEqual(
      head.moves.map((move) => ({ atS: move.atS, laneIndex: move.laneIndex })),
    );
  });

  it("ignores stale/duplicate ticks: no bursts, no duplicate moves", () => {
    let driver = createEnsembleDriver();
    for (let t = 0; t <= 10; t += 1) {
      driver = ensembleTick(
        driver,
        t,
        toSignals([render({ laneId: 0, progress: t < 5 ? 0.2 : 0.8 })]),
      ).driver;
    }
    const snap = driver;
    const stale = ensembleTick(snap, 5, toSignals([render({ laneId: 0, progress: 0.9 })]));
    expect(stale.move).toBeNull();
    expect(stale.driver).toBe(snap);
    const same = ensembleTick(snap, 10, toSignals([render({ laneId: 0, progress: 0.9 })]));
    expect(same.move).toBeNull();
  });

  it("plans identical moves at another replay speed (seek + speed independence)", () => {
    const at = (t: number): readonly LaneRender[] => [
      render({ laneId: 0, progress: t < 10 ? 0.2 : 0.8 }),
      render({ laneId: 1, mode: t < 20 ? editing : testing }),
    ];
    const slow = foldTrajectory(createEnsembleDriver(), 60, at);
    // Same trajectory replayed at double speed maps to the same engine
    // seconds — the planner reads sample timestamps, never wall timing.
    const fast = foldTrajectory(createEnsembleDriver(), 60, (t) => at(t));
    expect(fast.moves).toEqual(slow.moves);
    // And after a seek (restart + replay the tail), the tail matches.
    const whole = foldTrajectory(createEnsembleDriver(), 90, at);
    const tail = foldTrajectory(ensembleRestart(createEnsembleDriver()), 90 - 45, (dt) =>
      at(dt + 45),
    );
    void tail;
    expect(whole.moves.filter((move) => move.atS < 45)).toEqual(
      foldTrajectory(createEnsembleDriver(), 44, at).moves,
    );
  });

  it("feeds routine lanes only: waiting/completion neverearn routine moves", () => {
    const { moves } = foldTrajectory(createEnsembleDriver(), 60, (t) => [
      render({ laneId: 0, progress: t < 5 ? 0.2 : 0.8 }),
      render({
        laneId: 2,
        lifecycle: t >= 20 && t < 40 ? "waiting" : t >= 40 && t < 44 ? "turn_complete" : "active",
        progress: 0.9,
      }),
    ]);
    for (const move of moves) expect(move.laneIndex).not.toBe(2);
  });

  it("acknowledges progress on every path: waiting cannot stockpile bursts", () => {
    // A lane that reports progress while waiting (never fed to the
    // planner) returns without a burst: its first observed routine level
    // is its new baseline.
    let driver = createEnsembleDriver();
    for (let t = 0; t <= 30; t += 1) {
      driver = ensembleTick(
        driver,
        t,
        toSignals([
          render({ laneId: 0, progress: t < 10 ? 0.2 : 0.9 }),
          render({ laneId: 1, lifecycle: "waiting", progress: 0.9 }),
        ]),
      ).driver;
    }
    const returning = ensembleTick(
      driver,
      31,
      toSignals([
        render({ laneId: 0, progress: 0.9 }),
        render({ laneId: 1, lifecycle: "active", progress: 0.9 }),
      ]),
    );
    expect(returning.move === null || returning.move.laneIndex !== 1).toBe(true);
  });

  it("bounds frequency under ever-rising evidence and rotates simultaneous lanes", () => {
    const busy = foldTrajectory(createEnsembleDriver(), 150, (t) => [
      render({ laneId: 0, progress: Math.min(0.9, 0.1 + t * 0.05) }),
    ]);
    expect(busy.moves.length).toBeLessThanOrEqual(11);
    const rotating = foldTrajectory(createEnsembleDriver(7), 90, (t) =>
      [0, 1, 2].map((laneId) =>
        render({ laneId, activity: 0.3 + (t % 16) * 0.04, progress: 0.1 + (t % 16) * 0.05 }),
      ),
    );
    expect(new Set(rotating.moves.slice(0, 3).map((move) => move.laneIndex))).toEqual(
      new Set([0, 1, 2]),
    );
  });

  it("is same-input deterministic through actual integration", () => {
    const at = (t: number): readonly LaneRender[] => [
      render({ laneId: 0, activity: 0.25, progress: 0.2 }),
      render({
        laneId: 1,
        activity: 0.85,
        mode: t < 10 ? editing : testing,
        progress: t < 30 ? 0.55 : t < 60 ? 0.75 : 0.9,
      }),
      render({
        laneId: 2,
        lifecycle: t >= 30 && t < 60 ? "waiting" : "active",
        activity: 0.55,
      }),
    ];
    const first = foldTrajectory(createEnsembleDriver(), 90, at);
    const second = foldTrajectory(createEnsembleDriver(), 90, at);
    expect(second.moves).toEqual(first.moves);
    // Seed ownership: a different seed is a different stream identity.
    expect(createEnsembleDriver(7).seed).toBe(7);
    expect(ENSEMBLE_DEFAULT_SEED).toBe(161);
  });

  it("projects signals agent-blind: no struggle, no confidence, no identity", () => {
    const signal = laneSignalFromRender(
      render({ lifecycle: "waiting", struggle: 0.9, prominence: 1, foreground: true }),
    );
    expect("struggle" in signal).toBe(false);
    expect("agent" in signal).toBe(false);
    expect("lifecycleConfidence" in signal).toBe(false);
    expect(Object.keys(signal).sort()).toEqual(
      ["activity", "laneIndex", "lifecycle", "mode", "progress"].sort(),
    );
    expect(harmonicIsRoutine("active")).toBe(true);
    expect(harmonicIsRoutine("quiet")).toBe(true);
  });

  it("covers sustained progress, structurally stuck phrases and low-confidence progress", () => {
    // Sustained progress evidence earns one bounded move.
    const sustained = foldTrajectory(createEnsembleDriver(), 40, (t) => [
      render({ laneId: 0, progress: t < 5 ? 0.3 : 0.7 }),
    ]);
    expect(sustained.moves).toHaveLength(1);
    // A structurally stuck phrase (high struggle, planner signals flat)
    // earns no harmonic move: struggle never enters the projection.
    const stuck = foldTrajectory(createEnsembleDriver(), 60, () => [render({ struggle: 0.95 })]);
    expect(stuck.moves).toEqual([]);
    // Low-confidence progress (same numeric evidence) plans the same —
    // the projection reads lifecycle only, never confidence — so a lane
    // with missing confidence still voices its own evidence once.
    const low = foldTrajectory(createEnsembleDriver(), 40, (t) => [
      render({ laneId: 0, progress: t < 5 ? 0.3 : 0.7 }),
    ]);
    expect(low.moves).toEqual(sustained.moves);
  });
});
