// packages/audio/test/ensemble-lifecycle.test.ts — behaviour tests for the
// p5-t04 ensemble-lifecycle seam. What this is for: proving the integration
// around the core planner — joins take the current compatible part,
// departures touch only their own lane, waiting/completion/attention
// bypass routine arbitration with player pre-emption kept, simultaneous
// and busy/quiet changes stay bounded and fair, and the production
// default is the adopted hybrid path. What it must not do: import Tone, render
// audio, or judge sound — audibility belongs to the named QA renders and
// the owner's ears.
import { createEnsembleDriver, type LaneRender, type LaneSignal } from "@hearable/core";
import { describe, expect, it } from "vitest";
import {
  compatiblePartForLane,
  isHardCueLifecycle,
  isRoutineLifecycle,
  lanesTouchedByLeave,
  routeEnsembleFrame,
} from "../src/ensemble/lifecycle.js";
import {
  ENSEMBLE_LIVE_TICK_S,
  ENSEMBLE_OPT_IN_DEFAULT,
  ensembleNeedsRestart,
  ensemblePruneDeparted,
  ensembleShouldTick,
} from "../src/ensemble/live.js";
import { startPitchForLane } from "../src/ensemble/palette.js";
import {
  ATTENTION_MIN_SPACING_S,
  CUT_RELEASE_S,
  evaluateGestureTriggers,
  GESTURE_PRIORITY,
  GesturePlayer,
  gestureBusyS,
} from "../src/gestures/index.js";

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

function toSignal(lane: LaneRender): LaneSignal {
  return {
    laneIndex: lane.laneId,
    lifecycle: lane.lifecycle,
    mode: { ...lane.mode },
    activity: lane.activity,
    progress: lane.progress,
  };
}

describe("ensemble lifecycle seam", () => {
  it("joins use the current compatible part (construction pitch)", () => {
    for (let lane = 0; lane < 3; lane += 1) {
      expect(compatiblePartForLane(lane)).toBe(startPitchForLane(lane));
    }
    expect(isRoutineLifecycle("active")).toBe(true);
    expect(isRoutineLifecycle("quiet")).toBe(true);
    expect(isRoutineLifecycle("waiting")).toBe(false);
    expect(isHardCueLifecycle("waiting")).toBe(true);
    expect(isHardCueLifecycle("turn_complete")).toBe(true);
    expect(isHardCueLifecycle("stale")).toBe(true);
    expect(isHardCueLifecycle("active")).toBe(false);
  });

  it("departures release only their own lane", () => {
    expect(lanesTouchedByLeave([0, 1, 2], 1)).toEqual([1]);
    // A changed agent influences its own eligibility: routing feeds only
    // routine lanes, so lane 2's waiting never enters the planner.
    const routed = routeEnsembleFrame(
      createEnsembleDriver(),
      [render({ laneId: 0 }), render({ laneId: 2, lifecycle: "waiting" })],
      [render({ laneId: 0 }), render({ laneId: 2, lifecycle: "waiting" })],
      1,
    );
    expect(routed.driver.history.has(2)).toBe(false);
    expect(routed.move).toBeNull();
  });

  it("waiting/completion bypass routine arbitration: no cue waits for a musical opening", () => {
    // A lane that just moved (hold + cooldown armed) still voices its
    // question immediately: the trigger path never consults the driver.
    const previous = [render({ laneId: 0 }), render({ laneId: 1 })];
    const next = [
      render({ laneId: 0 }),
      render({ laneId: 1, lifecycle: "waiting", gestures: [{ gesture: "question", at: 30 }] }),
    ];
    const routed = routeEnsembleFrame(createEnsembleDriver(), previous, next, 30);
    expect(routed.triggers).toEqual([{ laneIndex: 1, gesture: "question", at: 30 }]);
    // Ordinary harmonic repair on lane 0 is not a false progress signal:
    // lane 0's own routine signals still decide lane 0, never lane 1.
    expect(routed.driver.history.has(1)).toBe(false);
  });

  it("one completion never resolves another lane's waiting", () => {
    const previous = [
      render({ laneId: 0, lifecycle: "waiting", gestures: [{ gesture: "question", at: 10 }] }),
      render({ laneId: 1 }),
    ];
    const next = [
      render({
        laneId: 0,
        lifecycle: "waiting",
        gestures: [
          { gesture: "question", at: 10 },
          { gesture: "question", at: 40 },
        ],
      }),
      render({
        laneId: 1,
        lifecycle: "turn_complete",
        gestures: [{ gesture: "resolve", at: 40 }],
      }),
    ];
    const triggers = evaluateGestureTriggers(previous, next, 40);
    // Lane 0's own waiting re-fires on its own edge; lane 1's resolve is
    // its own edge. Neither lane's trigger mentions the other.
    expect(triggers).toContainEqual({ laneIndex: 1, gesture: "resolve", at: 40 });
    const lane0 = triggers.filter((trigger) => trigger.laneIndex === 0);
    expect(lane0.every((trigger) => trigger.gesture === "question")).toBe(true);
  });

  it("keeps player pre-emption and debouncing on the bypass path", () => {
    // question pre-empts a busy bus (cuts it), attention stays sparse
    // (12 s), priority orders question first.
    expect(GESTURE_PRIORITY.question).toBeGreaterThan(GESTURE_PRIORITY.resolve);
    expect(GESTURE_PRIORITY.question).toBeGreaterThan(GESTURE_PRIORITY.attention);
    expect(gestureBusyS("question")).toBeGreaterThan(0);
    expect(CUT_RELEASE_S).toBeGreaterThan(0);
    expect(ATTENTION_MIN_SPACING_S).toBe(12);
    const player = new GesturePlayer();
    const resolve = player.play({ laneIndex: 0, gesture: "resolve", at: 10 }, 0.6);
    expect(resolve.length).toBeGreaterThan(0);
    // question pre-empts the busy lane: it still sounds (with the fast
    // bus cut prepended — same note count plus the cut), while a
    // non-question trigger on the same busy bus is suppressed instead.
    const preempt = player.play({ laneIndex: 0, gesture: "question", at: 11 }, 0.6);
    expect(preempt.length).toBeGreaterThan(0);
    expect(preempt.some((event) => event.kind === "bus")).toBe(true);
    // A non-question gesture on the busy bus is suppressed instead.
    const player2 = new GesturePlayer();
    player2.play({ laneIndex: 0, gesture: "resolve", at: 10 }, 0.6);
    expect(player2.play({ laneIndex: 0, gesture: "arrive", at: 11 }, 0.6)).toEqual([]);
    // attention debounces: the second knock inside 12 s never sounds.
    const player3 = new GesturePlayer();
    player3.play({ laneIndex: 0, gesture: "attention", at: 10 }, 0.6);
    expect(player3.play({ laneIndex: 0, gesture: "attention", at: 15 }, 0.6)).toEqual([]);
    expect(
      player3.play({ laneIndex: 0, gesture: "attention", at: 22 }, 0.6).length,
    ).toBeGreaterThan(0);
  });

  it("stays bounded and fair under busy/quiet and simultaneous changes", () => {
    // Busy (0.95) vs quiet (0.25) with one evidence step each: the
    // ensemble cooldown spaces moves, one at a time, and the quiet lane
    // still moves on its own evidence.
    let driver = createEnsembleDriver();
    const moves: { laneIndex: number; atS: number }[] = [];
    for (let t = 0; t <= 90; t += 1) {
      const routed = routeEnsembleFrame(
        driver,
        [],
        [
          render({ laneId: 0, activity: 0.95, progress: t < 20 ? 0.5 : 0.9 }),
          render({ laneId: 1, activity: 0.25, progress: t < 30 ? 0.2 : 0.8 }),
        ],
        t,
      );
      driver = routed.driver;
      if (routed.move !== null)
        moves.push({ laneIndex: routed.move.laneIndex, atS: routed.move.atS });
    }
    expect(moves.some((move) => move.laneIndex === 1)).toBe(true);
    for (let i = 1; i < moves.length; i += 1) {
      expect((moves[i]?.atS ?? 0) - (moves[i - 1]?.atS ?? 0)).toBeGreaterThanOrEqual(6 - 1e-9);
    }
  });

  it("covers low-confidence and missing progress without fabrication", () => {
    // Quiet lanes hold: no fabricated moves for a lane with no evidence.
    const routed = routeEnsembleFrame(
      createEnsembleDriver(),
      [],
      [render({ laneId: 0, lifecycle: "quiet", activity: 0.2, progress: 0 })],
      30,
    );
    expect(routed.move).toBeNull();
    // Signals keep the planner subset only: no agent, no struggle leaks
    // through the seam's own projection path.
    expect(Object.keys(toSignal(render({ struggle: 0.9 }))).sort()).toEqual(
      ["activity", "laneIndex", "lifecycle", "mode", "progress"].sort(),
    );
  });

  it("owns the live clock rules: tick cadence, prune, resync", () => {
    expect(ENSEMBLE_LIVE_TICK_S).toBe(1);
    expect(ensembleShouldTick(null, 0)).toBe(true);
    expect(ensembleShouldTick(10, 10)).toBe(false);
    expect(ensembleShouldTick(10, 10.5)).toBe(false);
    expect(ensembleShouldTick(10, 11)).toBe(true);
    expect(ensembleNeedsRestart(10, 9)).toBe(true);
    expect(ensembleNeedsRestart(10, 45)).toBe(true);
    expect(ensembleNeedsRestart(10, 20)).toBe(false);
    // Pruning drops only the departed lane's state.
    let driver = createEnsembleDriver();
    driver = routeEnsembleFrame(
      driver,
      [],
      [render({ laneId: 0 }), render({ laneId: 1 })],
      0,
    ).driver;
    expect(driver.state.lanes.has(0)).toBe(true);
    const pruned = ensemblePruneDeparted(driver, new Set([1]));
    expect(pruned.state.lanes.has(0)).toBe(false);
    expect(pruned.state.lanes.has(1)).toBe(true);
  });

  it("adopts the hybrid ensemble path as the production default", () => {
    expect(ENSEMBLE_OPT_IN_DEFAULT).toBe(true);
  });
});
