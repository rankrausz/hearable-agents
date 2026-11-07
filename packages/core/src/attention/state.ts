// packages/core/src/attention/state.ts — the attention model's memory and
// input shapes. What this is for: the `AttentionState` the daemon holds
// between ticks (per-lane lifecycle/displayed-mode/transition memory for the
// prominence bump and gesture edges, the previous struggle level behind the
// 0.6/0.4 hysteresis edge, the foreground holder and its acquisition time,
// per-lane gesture history with refractory clocks, and the
// struggle-hysteresis arm), plus the structural signal input a `LaneState`
// satisfies. What it must not do: I/O, time, randomness, node:* or workspace
// imports, or carry any agent identity, confidence or capability — there is
// no such field here, so the model stays agent-blind by construction and the
// `question` emission path cannot branch on observed vs inferred waiting.
//
// Clocks are engine-clock milliseconds everywhere here (gesture `at`,
// transition and hold timers): the daemon passes engine milliseconds
// directly, matching `LaneState.lastEventAt` units.

import type { DisplayedMode, Lifecycle, ModeWeights, WaitingReason } from "../engine/state.js";
import type { LaneGesture } from "../scene/schema.js";

/** The four gestures, named exactly per docs/STATE_ENGINE.md §Gestures. */
export type GestureName = LaneGesture["gesture"];

/**
 * The signal subset one lane contributes to the attention transition. A full
 * `LaneState` is assignable to this shape; the model reads nothing else, so
 * identical signals always produce identical renders regardless of session,
 * agent, confidence or capabilities.
 */
export type AttentionInput = {
  readonly laneId: number;
  readonly lifecycle: Lifecycle;
  readonly waitingReason?: WaitingReason;
  readonly mode: ModeWeights;
  readonly displayedMode: DisplayedMode;
  readonly activity: number;
  readonly progress: number;
  readonly struggle: number;
  readonly lastEventAt: number;
  readonly turnStartedAt?: number;
};

/** Per-lane memory: what the lane looked like at the previous tick. */
export type AttentionLaneMemory = {
  readonly lifecycle: Lifecycle;
  readonly displayedMode: DisplayedMode;
  /** Engine-clock milliseconds of the last lifecycle or displayed-mode change. */
  readonly lastTransitionAt: number;
  /** Struggle at the previous tick, orienting the 0.6/0.4 hysteresis edge. */
  readonly lastStruggle: number;
};

/**
 * The daemon-owned attention memory, threaded through `computeAttention`.
 * The module itself holds no state: the same signals, clock and Calm always
 * yield deep-equal renders from the same previous state.
 */
export type AttentionState = {
  /** Per-lane lifecycle/displayed-mode/transition memory, keyed by laneId. */
  readonly lanes: { readonly [laneId: number]: AttentionLaneMemory | undefined };
  /** The lane holding foreground, or null when no candidate qualifies. */
  readonly foregroundLaneId: number | null;
  /** Engine-clock milliseconds the holder acquired foreground. */
  readonly foregroundSince: number;
  /** Engine-clock milliseconds of the last emitted gesture per lane. */
  readonly lastGestureAt: { readonly [laneId: number]: number | undefined };
  /** Cumulative emitted gestures per lane, carried onto `LaneRender`. */
  readonly gestures: {
    readonly [laneId: number]: readonly LaneGesture[] | undefined;
  };
  /** Struggle-hysteresis arm per lane: true means the next 0.6 crossing fires. */
  readonly struggleArmed: { readonly [laneId: number]: boolean | undefined };
};

/** Empty attention memory: no lanes seen, no foreground, every arm set. */
export function initialAttentionState(): AttentionState {
  return {
    lanes: {},
    foregroundLaneId: null,
    foregroundSince: 0,
    lastGestureAt: {},
    gestures: {},
    struggleArmed: {},
  };
}
