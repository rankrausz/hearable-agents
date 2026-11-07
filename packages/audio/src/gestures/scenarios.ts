// packages/audio/src/gestures/scenarios.ts - named deterministic scenario
// inputs for p3-t05's QA harness. What this is for: turning each gesture into
// a concrete drive sequence (consecutive synthetic LaneRenders, a clock, and
// a calm value) that p3-t05 can name as a scenario, step through the pure
// trigger evaluator and the GesturePlayer, and render offline - the same
// inputs always yield the same event plan. What it must not do: import Tone,
// keep state, or read engine signals - it only builds plain render data the
// trigger evaluator consumes.

import type { LaneGesture, LaneRender } from "@hearable/core";

import { GesturePlayer } from "./player.js";

import { evaluateGestureTriggers } from "./triggers.js";

import type { GestureName, GestureVoiceEvent } from "./types.js";

/** One named gesture scenario: the render/clock/calm drive sequence. */

export type GestureScenario = {
  readonly name: GestureName;

  readonly laneIndex: number;

  readonly calm: number;

  /** Consecutive lane-render snapshots the evaluator steps through. */

  readonly renders: readonly (readonly LaneRender[])[];

  /** Clock value at each render snapshot. */

  readonly nows: readonly number[];
};

/** A plain synthetic lane render with the given pending gesture triggers. */

export function baseLaneRender(
  laneId: number,

  gestures: readonly LaneGesture[] = [],
): LaneRender {
  return {
    laneId,

    lifecycle: "active",

    mode: { exploring: 0.5, editing: 0.3, testing: 0.2, other: 0 },

    displayedMode: "exploring",

    activity: 0.8,

    progress: 0.2,

    struggle: 0.1,

    prominence: 0.5,

    foreground: false,

    gestures,
  };
}

/** Trigger time per gesture, in seconds from scene start. */

const TRIGGER_AT: Record<GestureName, number> = {
  arrive: 1,

  question: 5,

  resolve: 10,

  attention: 2,
};

/** Builds the named scenario for a gesture on a lane at a calm. */

export function scenarioFor(
  gesture: GestureName,

  laneIndex = 0,

  calm = 0.6,
): GestureScenario {
  const at = TRIGGER_AT[gesture];

  return {
    name: gesture,

    laneIndex,

    calm,

    renders: [
      [baseLaneRender(laneIndex)],

      [baseLaneRender(laneIndex, [{ gesture, at }])],
    ],

    nows: [0, at],
  };
}

/** The four named scenarios, one per gesture, for p3-t05 to drive. */

export const GESTURE_SCENARIOS: readonly GestureScenario[] = [
  scenarioFor("arrive"),

  scenarioFor("question"),

  scenarioFor("resolve"),

  scenarioFor("attention"),
];

/** Steps a scenario through the evaluator and player, returning the events. */

export function driveScenario(scenario: GestureScenario): readonly GestureVoiceEvent[] {
  const player = new GesturePlayer();

  const events: GestureVoiceEvent[] = [];

  for (let i = 1; i < scenario.renders.length; i++) {
    const triggers = evaluateGestureTriggers(
      scenario.renders[i - 1] ?? [],

      scenario.renders[i] ?? [],

      scenario.nows[i] ?? 0,
    );

    for (const trigger of triggers) events.push(...player.play(trigger, scenario.calm));
  }

  return events;
}
