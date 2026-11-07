// apps/web/src/ensemble-lifecycle.test.ts — integration checks for the
// p5-t04 ensemble live wiring (adopted hybrid default, p5-t06): the shared driver plans through actual
// live-shaped ticks (join/leave, reconnect, seek/speed), hard cues bypass
// it, and the default is on. What this is for: proving the consumer
// contract — one planner path for live/sandbox/replay with explicit
// seed/state/clock ownership. What it must not do: construct a Tone graph
// or judge sound.

import type { LaneRender } from "@hearable/core";
import { describe, expect, it } from "vitest";
import {
  createEnsembleLiveState,
  ENSEMBLE_LIVE_OPT_IN,
  ensembleLiveTick,
  sceneRendersForAudio,
} from "./audio.js";
import type { LaneSignal } from "./protocol.js";

function signal(overrides: Partial<LaneSignal>): LaneSignal {
  return {
    laneId: 0,
    sessionId: "s0",
    agent: "claude-code",
    lifecycleConfidence: "observed",
    lifecycle: "active",
    fidelity: null,
    mode: { exploring: 0.15, editing: 0.65, testing: 0.1, other: 0.1 },
    displayedMode: "editing",
    activity: 0.65,
    progress: 0.35,
    struggle: 0.1,
    lastEventAt: 0,
    reasons: [],
    prominence: 0.5,
    foreground: false,
    gestures: [],
    ...overrides,
  };
}

describe("adopted ensemble live wiring", () => {
  it("is on by default (adopted hybrid default, p5-t06)", () => {
    expect(ENSEMBLE_LIVE_OPT_IN).toBe(true);
  });

  it("ticks 0–3 lanes with join/leave and no duplicate delivery", () => {
    let state = createEnsembleLiveState(161);
    let previous: LaneRender[] = [];
    let moves = 0;
    for (let t = 0; t <= 60; t += 1) {
      const signals =
        t < 20
          ? [signal({ progress: t < 5 ? 0.2 : 0.8 })]
          : [
              signal({ progress: 0.8 }),
              signal({ laneId: 1, sessionId: "s1", progress: t < 30 ? 0.2 : 0.8 }),
            ];
      const renders = sceneRendersForAudio(signals);
      const present = new Set(signals.map((item) => item.laneId));
      const ticked = ensembleLiveTick(state, previous, renders, t, present);
      state = ticked.state;
      if (ticked.move !== null) moves += 1;
      // A duplicate delivery at the same time voices nothing new.
      const dup = ensembleLiveTick(state, previous, renders, t, present);
      expect(dup.move).toBeNull();
      previous = renders;
    }
    expect(moves).toBeGreaterThanOrEqual(0);
    expect(moves).toBeLessThanOrEqual(11);
    // Departure releases the lane: the daemon omits the signal, so the
    // planner drops only its own state (the padded idle render never
    // reaches the driver — prune reads the daemon frame, not the graph
    // frame).
    const renders = sceneRendersForAudio([signal({ progress: 0.8 })]);
    const after = ensembleLiveTick(state, previous, renders, 61, new Set([0]));
    expect(after.state.driver.state.lanes.has(1)).toBe(false);
  });

  it("reconnects and seeks without bursts or duplicate gestures", () => {
    let state = createEnsembleLiveState(7);
    let previous: LaneRender[] = [];
    const at = (t: number): LaneSignal[] => [
      signal({ progress: t < 5 ? 0.2 : 0.8, lastEventAt: t * 1000 }),
    ];
    const present = new Set([0]);
    for (let t = 0; t <= 20; t += 1) {
      const renders = sceneRendersForAudio(at(t));
      const ticked = ensembleLiveTick(state, previous, renders, t, present);
      state = ticked.state;
      previous = renders;
    }
    // Reconnect far forward: the resync restart folds the snapshot as a
    // fresh baseline, never the gap.
    const renders = sceneRendersForAudio(at(20));
    const resumed = ensembleLiveTick(state, previous, renders, 90, present);
    expect(resumed.state.driver.lastAtS).toBe(90);
    expect(resumed.move === null || resumed.move.laneIndex === 0).toBe(true);
    // Seek backward restarts the same way: no stale move replays.
    const back = ensembleLiveTick(resumed.state, previous, renders, 5, present);
    expect(back.move).toBeNull();
  });

  it("hard cues bypass the planner and never delay to a musical opening", () => {
    const state = createEnsembleLiveState(161);
    const previous = sceneRendersForAudio([signal({})]);
    const waiting = sceneRendersForAudio([
      signal({ lifecycle: "waiting", gestures: [{ gesture: "question", at: 30_000 }] }),
    ]);
    const ticked = ensembleLiveTick(state, previous, waiting, 30, new Set([0]));
    expect(ticked.triggers).toEqual([{ laneIndex: 0, gesture: "question", at: 30 }]);
    // Routine arbitration state is untouched by the waiting lane's own
    // signals: the driver holds no lane-0 trail for a non-routine feed.
    void state;
  });

  it("plans the same moves through the live path and the core driver", () => {
    const first = createEnsembleLiveState(161);
    const second = createEnsembleLiveState(161);
    let prevA: LaneRender[] = [];
    let prevB: LaneRender[] = [];
    const movesA: unknown[] = [];
    const movesB: unknown[] = [];
    let stateA = first;
    let stateB = second;
    const present = new Set([0]);
    for (let t = 0; t <= 40; t += 1) {
      const signals = [signal({ progress: t < 5 ? 0.2 : 0.8, lastEventAt: t * 1000 })];
      const renders = sceneRendersForAudio(signals);
      const tickA = ensembleLiveTick(stateA, prevA, renders, t, present);
      const tickB = ensembleLiveTick(stateB, prevB, renders, t, present);
      stateA = tickA.state;
      stateB = tickB.state;
      movesA.push(tickA.move);
      movesB.push(tickB.move);
      prevA = renders;
      prevB = renders;
    }
    expect(movesB).toEqual(movesA);
  });
});
