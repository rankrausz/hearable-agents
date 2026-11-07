// packages/core/src/attention/attention.ts — the pure attention transition
// function. What this is for: turning live lane signals (`AttentionInput[]`,
// which a full `LaneState` satisfies), Calm and the previous
// `AttentionState` into per-lane prominence, one foreground lane and
// debounced gesture triggers, exactly per docs/STATE_ENGINE.md §Attention
// model. The daemon owns hold timers and the previous state; this module
// stays a pure transition function with no memory of its own. What it must
// not do: I/O, Date.now(), Math.random(), node:* or workspace imports,
// branch on an agent's name, confidence or capability, or enforce the
// loudness budget — budget and gain live in `core/scene/render.ts`.

import { STRUGGLE_ATTENTION_THRESHOLD, STRUGGLE_REARM_THRESHOLD } from "../engine/tuning.js";
import type { AttentionInput, AttentionLaneMemory, AttentionState, GestureName } from "./state.js";
import {
  ATTENTION_BASE_ACTIVE,
  ATTENTION_BASE_IDLE,
  ATTENTION_BASE_QUIET,
  ATTENTION_BASE_STALE,
  ATTENTION_BASE_TURN_COMPLETE_PEAK,
  ATTENTION_BASE_WAITING,
  ATTENTION_FOREGROUND_HOLD_MS,
  ATTENTION_FOREGROUND_THRESHOLD,
  ATTENTION_REFRACTORY_MS,
  ATTENTION_ROUTINE_CALM_SLOPE,
  ATTENTION_STRUGGLE_CALM_SLOPE,
  ATTENTION_STRUGGLE_WEIGHT,
  ATTENTION_TIE_EPSILON,
  ATTENTION_TRANSITION_BUMP,
  ATTENTION_TRANSITION_TAU_MS,
  ATTENTION_TURN_COMPLETE_DECAY_MS,
} from "./tuning.js";

/**
 * One lane's attention output: its prominence plus the plain-data gesture
 * triggers the scene mapping carries through to the audio evaluator.
 */
export type AttentionLaneRender = {
  readonly laneId: number;
  readonly prominence: number;
  readonly foreground: boolean;
  readonly gestures: readonly { readonly gesture: GestureName; readonly at: number }[];
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Turn-complete peak fading linearly to 0 over 6 s after entering the state. */
export function attentionTurnCompleteBase(msSinceTransition: number): number {
  if (msSinceTransition <= 0) return ATTENTION_BASE_TURN_COMPLETE_PEAK;
  if (msSinceTransition >= ATTENTION_TURN_COMPLETE_DECAY_MS) return 0;
  return (
    ATTENTION_BASE_TURN_COMPLETE_PEAK * (1 - msSinceTransition / ATTENTION_TURN_COMPLETE_DECAY_MS)
  );
}

/**
 * Prominence for one lane at `now` with `calm`, exactly per the spec
 * formula: the waiting base never scaled by Calm; active/quiet bases scaled
 * as routine presence; the turn_complete peak fading on its own clock;
 * struggle sensitivity scaled by Calm; the fresh-transition bump riding on
 * top of every lifecycle or displayed-mode change. Clamps the output to [0,
 * 1]. The input carries no agent, confidence or capability field, so the
 * computation cannot branch on any of them.
 */
export function attentionProminenceFor(
  lane: AttentionInput,
  memory: AttentionLaneMemory | undefined,
  calm: number,
  now: number,
): number {
  const clampedCalm = clamp01(calm);
  const lastTransitionAt = memory?.lastTransitionAt ?? now;
  const msSinceTransition = Math.max(0, now - lastTransitionAt);
  let base: number;
  switch (lane.lifecycle) {
    case "waiting":
      base = ATTENTION_BASE_WAITING;
      break;
    case "stale":
      base = ATTENTION_BASE_STALE;
      break;
    case "active":
      base = ATTENTION_BASE_ACTIVE * (1 - ATTENTION_ROUTINE_CALM_SLOPE * clampedCalm);
      break;
    case "quiet":
      base = ATTENTION_BASE_QUIET * (1 - ATTENTION_ROUTINE_CALM_SLOPE * clampedCalm);
      break;
    case "turn_complete":
      base = attentionTurnCompleteBase(msSinceTransition);
      break;
    case "idle":
      base = ATTENTION_BASE_IDLE;
      break;
  }
  const struggleTerm =
    ATTENTION_STRUGGLE_WEIGHT *
    clamp01(lane.struggle) *
    (1 - ATTENTION_STRUGGLE_CALM_SLOPE * clampedCalm);
  const bump =
    ATTENTION_TRANSITION_BUMP * Math.exp(-msSinceTransition / ATTENTION_TRANSITION_TAU_MS);
  return clamp01(base + struggleTerm + bump);
}

type ForegroundCandidate = {
  readonly laneId: number;
  readonly prominence: number;
  readonly lastTransitionAt: number;
  readonly waiting: boolean;
};

/**
 * Foreground selection with the 15 s hold and waiting pre-emption. The
 * current holder keeps foreground until the hold expires, even when another
 * lane is more prominent; only a `waiting` lane pre-empts inside the hold.
 * Past the hold (or with no holder) the highest-prominence candidate at or
 * above 0.5 wins, ties going to the most recent transition.
 */
export function attentionSelectForeground(
  candidates: readonly ForegroundCandidate[],
  previous: AttentionState,
  now: number,
): number | null {
  const holder = previous.foregroundLaneId;
  const held = holder !== null && now - previous.foregroundSince < ATTENTION_FOREGROUND_HOLD_MS;
  if (held && holder !== null) {
    const preempt = [...candidates]
      .filter(
        (candidate) => candidate.waiting && candidate.prominence >= ATTENTION_FOREGROUND_THRESHOLD,
      )
      .sort(
        (left, right) =>
          right.prominence - left.prominence || right.lastTransitionAt - left.lastTransitionAt,
      )[0];
    if (preempt !== undefined && preempt.laneId !== holder) return preempt.laneId;
    return holder;
  }
  const ordered = [...candidates]
    .filter((candidate) => candidate.prominence >= ATTENTION_FOREGROUND_THRESHOLD)
    .sort(
      (left, right) =>
        right.prominence - left.prominence || right.lastTransitionAt - left.lastTransitionAt,
    );
  let winner: ForegroundCandidate | undefined;
  for (const candidate of ordered) {
    if (winner === undefined) {
      winner = candidate;
      continue;
    }
    // Sorted by descending prominence: a candidate strictly below the best
    // ends the scan; near-ties defer to the most recent transition.
    if (candidate.prominence < winner.prominence - ATTENTION_TIE_EPSILON) break;
    if (candidate.lastTransitionAt > winner.lastTransitionAt) winner = candidate;
  }
  return winner?.laneId ?? null;
}

function gestureRefractoryOk(
  previous: AttentionState,
  laneId: number,
  gesture: GestureName,
  now: number,
): boolean {
  if (gesture === "question") return true;
  const last = previous.lastGestureAt[laneId];
  if (last === undefined) return true;
  return now - last >= ATTENTION_REFRACTORY_MS;
}

function gestureAlreadyRecorded(
  gestures: {
    readonly [laneId: number]:
      | readonly { readonly gesture: GestureName; readonly at: number }[]
      | undefined;
  },
  laneId: number,
  gesture: GestureName,
  at: number,
): boolean {
  return (gestures[laneId] ?? []).some((entry) => entry.gesture === gesture && entry.at === at);
}

/**
 * The attention transition: prominence per lane, one foreground lane, and
 * the gesture table folded into each lane's render as plain data. `question`
 * fires identically for observed and inferred waiting — the input carries
 * the engine's lifecycle only, never its confidence, so the emission path
 * cannot branch on it. Pure: the same signals, clock and Calm always yield
 * deep-equal renders from the same previous state.
 */
export function computeAttention(
  lanes: readonly AttentionInput[],
  calm: number,
  previous: AttentionState,
  now: number,
): { readonly renders: readonly AttentionLaneRender[]; readonly state: AttentionState } {
  const clampedCalm = clamp01(calm);
  const ordered = [...lanes].sort((left, right) => left.laneId - right.laneId);

  const prominences = new Map<number, number>();
  for (const lane of ordered) {
    prominences.set(
      lane.laneId,
      attentionProminenceFor(lane, previous.lanes[lane.laneId], clampedCalm, now),
    );
  }
  const foregroundLaneId = attentionSelectForeground(
    ordered.map((lane) => ({
      laneId: lane.laneId,
      prominence: prominences.get(lane.laneId) ?? 0,
      lastTransitionAt: previous.lanes[lane.laneId]?.lastTransitionAt ?? now,
      waiting: lane.lifecycle === "waiting",
    })),
    previous,
    now,
  );
  const foregroundSince =
    foregroundLaneId === null
      ? previous.foregroundSince
      : foregroundLaneId === previous.foregroundLaneId
        ? previous.foregroundSince
        : now;

  // Gesture edges accumulate onto the per-lane history the renders carry:
  // `question` never arms the refractory (a second waiting edge re-fires so
  // the handover re-sounds); every other gesture stamps it.
  const nextGestures: {
    [laneId: number]: { readonly gesture: GestureName; readonly at: number }[];
  } = {};
  const nextLastGestureAt: { [laneId: number]: number | undefined } = {
    ...previous.lastGestureAt,
  };
  const nextArmed: { [laneId: number]: boolean | undefined } = { ...previous.struggleArmed };
  for (const lane of ordered) {
    nextGestures[lane.laneId] = [...(previous.gestures[lane.laneId] ?? [])];
  }
  const emit = (laneId: number, gesture: GestureName, at: number): void => {
    if (gestureAlreadyRecorded(previous.gestures, laneId, gesture, at)) return;
    if (gestureAlreadyRecorded(nextGestures, laneId, gesture, at)) return;
    if (!gestureRefractoryOk(previous, laneId, gesture, now)) return;
    const queued = nextGestures[laneId] ?? [];
    nextGestures[laneId] = [...queued, { gesture, at }];
    if (gesture !== "question") {
      nextLastGestureAt[laneId] = at;
    }
  };

  for (const lane of ordered) {
    const memory = previous.lanes[lane.laneId];
    if (memory === undefined) {
      // A lane the model has never seen joins the mix: session.start (or
      // the first turn.start) arrives, and a lane replayed straight into
      // waiting still marks `question` with the identical gesture shape —
      // audio/UI may read `lifecycleConfidence` to label it, never to
      // re-derive it.
      if (lane.lifecycle === "active" || lane.lifecycle === "quiet") {
        emit(lane.laneId, "arrive", now);
      } else if (lane.lifecycle === "waiting") {
        emit(lane.laneId, "question", now);
      } else if (lane.lifecycle === "turn_complete") {
        emit(lane.laneId, "resolve", now);
      }
    } else if (memory.lifecycle !== lane.lifecycle) {
      if (lane.lifecycle === "active" && memory.lifecycle === "idle") {
        // turn.start from idle: the lane joins.
        emit(lane.laneId, "arrive", now);
      } else if (lane.lifecycle === "active" && memory.lifecycle === "turn_complete") {
        // turn.start during turn_complete: a new turn with no arrive.
      } else if (lane.lifecycle === "waiting") {
        emit(lane.laneId, "question", now);
      } else if (lane.lifecycle === "turn_complete") {
        emit(lane.laneId, "resolve", now);
      } else if (lane.lifecycle === "stale") {
        emit(lane.laneId, "attention", now);
      }
    }
    // The struggle hysteresis (0.6 up / 0.4 re-arm, shared with the engine
    // thresholds): a disarmed lane re-arms below 0.4; an armed lane fires
    // once on the upward crossing. A brand-new lane samples its edge from
    // the current value — already above 0.6 reads as crossed, so a
    // mid-trajectory replay marks the threshold the daemon drove past.
    const armed = nextArmed[lane.laneId] ?? true;
    const before = memory?.lastStruggle ?? lane.struggle;
    if (!armed && lane.struggle < STRUGGLE_REARM_THRESHOLD) {
      nextArmed[lane.laneId] = true;
    } else if (
      armed &&
      lane.struggle >= STRUGGLE_ATTENTION_THRESHOLD &&
      before < STRUGGLE_ATTENTION_THRESHOLD
    ) {
      emit(lane.laneId, "attention", now);
      nextArmed[lane.laneId] = false;
    } else if (memory === undefined && lane.struggle >= STRUGGLE_ATTENTION_THRESHOLD) {
      nextArmed[lane.laneId] = false;
    } else {
      nextArmed[lane.laneId] = armed;
    }
  }

  const laneMemories: { [laneId: number]: AttentionLaneMemory } = {};
  for (const lane of ordered) {
    const memory = previous.lanes[lane.laneId];
    const changed =
      memory === undefined ||
      memory.lifecycle !== lane.lifecycle ||
      memory.displayedMode !== lane.displayedMode;
    laneMemories[lane.laneId] = {
      lifecycle: lane.lifecycle,
      displayedMode: lane.displayedMode,
      lastTransitionAt: changed ? now : (memory?.lastTransitionAt ?? now),
      lastStruggle: lane.struggle,
    };
  }

  const renders: AttentionLaneRender[] = ordered.map((lane) => ({
    laneId: lane.laneId,
    prominence: prominences.get(lane.laneId) ?? 0,
    foreground: lane.laneId === foregroundLaneId,
    gestures: [...(nextGestures[lane.laneId] ?? [])],
  }));

  const gestureMemory: { [laneId: number]: AttentionLaneRender["gestures"] } = {};
  for (const render of renders) {
    gestureMemory[render.laneId] = [...render.gestures];
  }
  return {
    renders,
    state: {
      lanes: laneMemories,
      foregroundLaneId,
      foregroundSince,
      lastGestureAt: nextLastGestureAt,
      gestures: gestureMemory,
      struggleArmed: nextArmed,
    },
  };
}
