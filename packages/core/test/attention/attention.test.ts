// packages/core/test/attention/attention.test.ts — behaviour tests for the
// docs/STATE_ENGINE.md §Attention model: the prominence formula (waiting
// base never scaled by Calm; routine presence and struggle sensitivity
// scaled), at-most-one foreground with the 0.5 candidacy threshold, the
// 15 s hold, waiting pre-emption, most-recent-transition tiebreak, and the
// gesture table (arrive / question / resolve / attention with the 0.6-up /
// 0.4-re-arm hysteresis and the 3 s per-lane refractory) as plain-data
// LaneRender fields. No I/O; synthetic AttentionInput lanes only.

import { describe, expect, it } from "vitest";

import {
  ATTENTION_BASE_ACTIVE,
  ATTENTION_BASE_QUIET,
  ATTENTION_BASE_STALE,
  type AttentionInput,
  attentionProminenceFor,
  computeAttention,
  initialAttentionState,
} from "../../src/index.js";

const T0 = 1_760_000_000_000;

function lane(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return {
    laneId: 0,
    lifecycle: "active",
    mode: { exploring: 1, editing: 0, testing: 0, other: 0 },
    displayedMode: "exploring",
    activity: 1,
    progress: 0,
    struggle: 0,
    lastEventAt: T0,
    ...overrides,
  };
}

function approx(actual: number, expected: number, epsilon = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(epsilon);
}

describe("prominence", () => {
  it("never scales the waiting base with Calm", () => {
    const waiting = lane({ lifecycle: "waiting", struggle: 0 });
    const atCalm0 = attentionProminenceFor(waiting, undefined, 0, T0);
    const atCalm1 = attentionProminenceFor(waiting, undefined, 1, T0);
    approx(atCalm0, atCalm1);
    // 0.9 base + 0.3 fresh-join bump, clamped to 1.
    approx(atCalm0, 1);
  });

  it("scales routine presence and struggle sensitivity with Calm", () => {
    const active = lane({ lifecycle: "active", struggle: 0 });
    const atCalm0 = attentionProminenceFor(active, undefined, 0, T0);
    const atCalm1 = attentionProminenceFor(active, undefined, 1, T0);
    approx(atCalm0, ATTENTION_BASE_ACTIVE + 0.3);
    approx(atCalm1, ATTENTION_BASE_ACTIVE * 0.4 + 0.3);
    const struggling = lane({ lifecycle: "idle", struggle: 0.5 });
    const struggleCalm0 = attentionProminenceFor(struggling, undefined, 0, T0);
    const struggleCalm1 = attentionProminenceFor(struggling, undefined, 1, T0);
    approx(struggleCalm0, 0.6 * 0.5 + 0.3);
    approx(struggleCalm1, 0.6 * 0.5 * 0.5 + 0.3);
    expect(struggleCalm1).toBeLessThan(struggleCalm0);
  });

  it("adds the 0.30 transition bump decaying over 8 s", () => {
    const active = lane({ lifecycle: "active", struggle: 0 });
    const fresh = attentionProminenceFor(active, undefined, 0, T0);
    const settled = attentionProminenceFor(
      active,
      {
        lifecycle: "active",
        displayedMode: "exploring",
        lastTransitionAt: T0 - 60_000,
        lastStruggle: 0,
      },
      0,
      T0,
    );
    approx(fresh - settled, 0.3 * (1 - Math.exp(-60_000 / 8_000)));
    expect(settled).toBeLessThan(fresh);
  });

  it("fades turn_complete 0.50 to 0 over 6 s", () => {
    const done = lane({ lifecycle: "turn_complete", struggle: 0 });
    approx(attentionProminenceFor(done, undefined, 0, T0), 0.5 + 0.3);
    const faded = attentionProminenceFor(
      done,
      {
        lifecycle: "turn_complete",
        displayedMode: "exploring",
        lastTransitionAt: T0 - 6_000,
        lastStruggle: 0,
      },
      0,
      T0,
    );
    approx(faded, 0.3 * Math.exp(-6_000 / 8_000));
  });

  it("clamps prominence to [0, 1]", () => {
    const loud = lane({ lifecycle: "waiting", struggle: 1 });
    approx(attentionProminenceFor(loud, undefined, 0, T0), 1);
  });

  it("keeps the quiet and stale bases distinct from active", () => {
    approx(
      attentionProminenceFor(lane({ lifecycle: "quiet", struggle: 0 }), undefined, 0, T0),
      ATTENTION_BASE_QUIET + 0.3,
    );
    approx(
      attentionProminenceFor(lane({ lifecycle: "stale", struggle: 0 }), undefined, 0, T0),
      ATTENTION_BASE_STALE + 0.3,
    );
  });
});

describe("foreground", () => {
  it("selects at most one lane above the 0.5 threshold", () => {
    const { renders } = computeAttention(
      [lane({ laneId: 0 }), lane({ laneId: 1 })],
      0,
      initialAttentionState(),
      T0,
    );
    expect(renders.filter((render) => render.foreground)).toHaveLength(1);
    const { renders: quiet } = computeAttention(
      [lane({ laneId: 0, lifecycle: "idle", struggle: 0 })],
      1,
      initialAttentionState(),
      T0,
    );
    expect(quiet.filter((render) => render.foreground)).toHaveLength(0);
  });

  it("breaks prominence ties by most recent transition", () => {
    // Two waiting lanes tie on base 0.9 + matched bumps; the later
    // transition wins the foreground.
    const first = computeAttention(
      [
        lane({ laneId: 0, lifecycle: "waiting", waitingReason: "question", struggle: 0 }),
        lane({ laneId: 1, lifecycle: "idle", struggle: 0 }),
      ],
      0,
      initialAttentionState(),
      T0,
    );
    expect(first.state.foregroundLaneId).toBe(0);
    const later = computeAttention(
      [
        lane({ laneId: 0, lifecycle: "waiting", waitingReason: "question", struggle: 0 }),
        lane({ laneId: 1, lifecycle: "waiting", waitingReason: "permission", struggle: 0 }),
      ],
      0,
      {
        ...first.state,
        foregroundLaneId: null,
        foregroundSince: 0,
        lanes: {
          0: {
            lifecycle: "waiting",
            displayedMode: "exploring",
            lastTransitionAt: T0,
            lastStruggle: 0,
          },
          1: {
            lifecycle: "waiting",
            displayedMode: "exploring",
            lastTransitionAt: T0 + 10_000,
            lastStruggle: 0,
          },
        },
      },
      T0 + 20_000,
    );
    expect(later.state.foregroundLaneId).toBe(1);
  });

  it("holds foreground 15 s against a more prominent challenger", () => {
    const first = computeAttention([lane({ laneId: 0 })], 0, initialAttentionState(), T0);
    expect(first.state.foregroundLaneId).toBe(0);
    const challenged = computeAttention(
      [lane({ laneId: 0, struggle: 0 }), lane({ laneId: 1, struggle: 0.4 })],
      0,
      first.state,
      T0 + 5_000,
    );
    expect(challenged.state.foregroundLaneId).toBe(0);
    const released = computeAttention(
      [lane({ laneId: 0, struggle: 0 }), lane({ laneId: 1, struggle: 0.4 })],
      0,
      first.state,
      T0 + 16_000,
    );
    expect(released.state.foregroundLaneId).toBe(1);
  });

  it("lets waiting pre-empt inside the hold", () => {
    const first = computeAttention([lane({ laneId: 0 })], 0, initialAttentionState(), T0);
    expect(first.state.foregroundLaneId).toBe(0);
    const preempted = computeAttention(
      [lane({ laneId: 0 }), lane({ laneId: 1, lifecycle: "waiting", struggle: 0 })],
      0,
      first.state,
      T0 + 5_000,
    );
    expect(preempted.state.foregroundLaneId).toBe(1);
  });
});

describe("gestures", () => {
  it("emits arrive once when a lane joins from idle", () => {
    const first = computeAttention(
      [lane({ laneId: 0, lifecycle: "idle", struggle: 0 })],
      0.6,
      initialAttentionState(),
      T0,
    );
    expect(first.renders[0]?.gestures).toEqual([]);
    const joined = computeAttention(
      [lane({ laneId: 0, lifecycle: "active" })],
      0.6,
      first.state,
      T0 + 1_000,
    );
    expect(joined.renders[0]?.gestures).toEqual([{ gesture: "arrive", at: T0 + 1_000 }]);
    const repeated = computeAttention(
      [lane({ laneId: 0, lifecycle: "active" })],
      0.6,
      joined.state,
      T0 + 2_000,
    );
    expect(repeated.renders[0]?.gestures).toEqual([{ gesture: "arrive", at: T0 + 1_000 }]);
  });

  it("emits question on entering waiting and resolve on turn_complete", () => {
    const active = computeAttention([lane({ laneId: 0 })], 0.6, initialAttentionState(), T0);
    expect(active.renders[0]?.gestures).toEqual([{ gesture: "arrive", at: T0 }]);
    const waiting = computeAttention(
      [lane({ laneId: 0, lifecycle: "waiting", waitingReason: "question" })],
      0.6,
      active.state,
      T0 + 1_000,
    );
    const gestures = waiting.renders[0]?.gestures ?? [];
    expect(gestures).toContainEqual({ gesture: "question", at: T0 + 1_000 });
    const resolved = computeAttention(
      [lane({ laneId: 0, lifecycle: "turn_complete" })],
      0.6,
      {
        ...initialAttentionState(),
        lanes: {
          0: {
            lifecycle: "active",
            displayedMode: "exploring",
            lastTransitionAt: T0,
            lastStruggle: 0,
          },
        },
      },
      T0 + 1_000,
    );
    expect(resolved.renders[0]?.gestures).toContainEqual({
      gesture: "resolve",
      at: T0 + 1_000,
    });
  });

  it("fires question identically for observed and inferred waiting", () => {
    // The attention input carries no confidence field at all: two lanes that
    // differ only in how the engine labelled the transition (observed prompt
    // event vs inferred ?-message) produce the identical gesture shape.
    const fromObserved = computeAttention(
      [lane({ laneId: 0, lifecycle: "waiting", waitingReason: "question" })],
      0.6,
      initialAttentionState(),
      T0,
    );
    const fromInferred = computeAttention(
      [lane({ laneId: 0, lifecycle: "waiting", waitingReason: "question" })],
      0.6,
      initialAttentionState(),
      T0,
    );
    expect(fromInferred.renders).toEqual(fromObserved.renders);
    expect(fromInferred.renders[0]?.gestures).toEqual([{ gesture: "question", at: T0 }]);
  });

  it("fires attention once per 0.6 crossing with a 0.4 re-arm", () => {
    const below = computeAttention(
      [lane({ laneId: 0, lifecycle: "idle", struggle: 0.59 })],
      0.6,
      initialAttentionState(),
      T0,
    );
    expect(
      (below.renders[0]?.gestures ?? []).filter((gesture) => gesture.gesture === "attention"),
    ).toEqual([]);
    const crossed = computeAttention(
      [lane({ laneId: 0, lifecycle: "idle", struggle: 0.61 })],
      0.6,
      below.state,
      T0 + 4_000,
    );
    expect(
      (crossed.renders[0]?.gestures ?? []).filter((gesture) => gesture.gesture === "attention"),
    ).toEqual([{ gesture: "attention", at: T0 + 4_000 }]);
    const held = computeAttention(
      [lane({ laneId: 0, lifecycle: "idle", struggle: 0.7 })],
      0.6,
      crossed.state,
      T0 + 8_000,
    );
    expect(
      (held.renders[0]?.gestures ?? []).filter((gesture) => gesture.gesture === "attention"),
    ).toHaveLength(1);
    const rearmed = computeAttention(
      [lane({ laneId: 0, lifecycle: "idle", struggle: 0.39 })],
      0.6,
      held.state,
      T0 + 12_000,
    );
    const crossedAgain = computeAttention(
      [lane({ laneId: 0, lifecycle: "idle", struggle: 0.61 })],
      0.6,
      rearmed.state,
      T0 + 16_000,
    );
    expect(
      (crossedAgain.renders[0]?.gestures ?? []).filter(
        (gesture) => gesture.gesture === "attention",
      ),
    ).toHaveLength(2);
  });

  it("fires attention when a lane enters stale", () => {
    const stale = computeAttention(
      [lane({ laneId: 0, lifecycle: "stale" })],
      0.6,
      {
        ...initialAttentionState(),
        lanes: {
          0: {
            lifecycle: "quiet",
            displayedMode: "exploring",
            lastTransitionAt: T0,
            lastStruggle: 0,
          },
        },
      },
      T0 + 1_000,
    );
    expect(stale.renders[0]?.gestures).toContainEqual({
      gesture: "attention",
      at: T0 + 1_000,
    });
  });

  it("dedupes gestures per lane with a 3 s refractory", () => {
    const active = computeAttention([lane({ laneId: 0 })], 0.6, initialAttentionState(), T0);
    // arrive at T0 stamps the refractory; a resolve 1 s later is dropped,
    // while a resolve past 3 s lands.
    const suppressed = computeAttention(
      [lane({ laneId: 0, lifecycle: "turn_complete" })],
      0.6,
      active.state,
      T0 + 1_000,
    );
    expect(suppressed.renders[0]?.gestures).toEqual([{ gesture: "arrive", at: T0 }]);
    const landed = computeAttention(
      [lane({ laneId: 0, lifecycle: "turn_complete" })],
      0.6,
      {
        ...active.state,
        lanes: {
          0: {
            lifecycle: "active",
            displayedMode: "exploring",
            lastTransitionAt: T0,
            lastStruggle: 0,
          },
        },
      },
      T0 + 4_000,
    );
    expect(landed.renders[0]?.gestures).toContainEqual({
      gesture: "resolve",
      at: T0 + 4_000,
    });
  });

  it("exempts question from the refractory so the handover re-sounds", () => {
    const active = computeAttention([lane({ laneId: 0 })], 0.6, initialAttentionState(), T0);
    const waiting = computeAttention(
      [lane({ laneId: 0, lifecycle: "waiting", waitingReason: "permission" })],
      0.6,
      active.state,
      T0 + 1_000,
    );
    expect(waiting.renders[0]?.gestures).toContainEqual({
      gesture: "question",
      at: T0 + 1_000,
    });
  });

  it("emits no gesture for mode-only changes", () => {
    const first = computeAttention([lane({ laneId: 0 })], 0.6, initialAttentionState(), T0);
    const switched = computeAttention(
      [lane({ laneId: 0, displayedMode: "editing" })],
      0.6,
      first.state,
      T0 + 1_000,
    );
    expect(switched.renders[0]?.gestures).toEqual([{ gesture: "arrive", at: T0 }]);
  });

  it("emits no second arrive for turn.start during turn_complete", () => {
    const resolved = computeAttention(
      [lane({ laneId: 0, lifecycle: "turn_complete" })],
      0.6,
      initialAttentionState(),
      T0,
    );
    expect(resolved.renders[0]?.gestures).toEqual([{ gesture: "resolve", at: T0 }]);
    const restarted = computeAttention(
      [lane({ laneId: 0, lifecycle: "active" })],
      0.6,
      resolved.state,
      T0 + 1_000,
    );
    expect(restarted.renders[0]?.gestures).toEqual([{ gesture: "resolve", at: T0 }]);
  });
});
