// packages/audio/src/gestures/triggers.ts - pure gesture-trigger evaluation.
// What this is for: turning two consecutive synthetic `LaneRender`s and the
// engine clock into the gesture triggers to hand the player, exactly per
// docs/STATE_ENGINE.md Gestures: a trigger fires once per emission,
// deduplicated per lane with a 3 s refractory period. It is a pure function
// of (previous render, next render, now) so p3-t05 can drive it
// deterministically; it holds no state and never imports the engine or
// attention model - it reads only the plain-data `LaneRender.gestures`
// fields p3-t01 defined. What it must not do: keep state, read lifecycle
// or signals, or decide anything audible - scheduling rules that need
// history (at-most-one, question pre-emption, attention spacing) live
// in player.ts.

import type { LaneRender } from "@hearable/core";

import { GESTURE_PRIORITY, type GestureTrigger, gestureBusyS } from "./types.js";

/** Per-lane gesture refractory per docs/STATE_ENGINE.md Gestures: 3 s. */

export const REFRACTORY_S = 3;

/** Stable dedup key for one gesture emission (gesture at its time). */

function gestureKey(gesture: LaneRender["gestures"][number]): string {
  return `${gesture.gesture}@${gesture.at}`;
}

/**

 *  Evaluates one trigger step. For each lane, gestures newly present in

 *  `next` (absent from `previous`) are fresh emissions; those whose `at`

 *  is due (at  now, sound not yet finished) are candidates. At most

 *  one gesture per lane per evaluation fires:the highest-priority due

 *  candidate (`question` pre-empts everything), earliest first on ties.


 *  Refractory:unless the winner is `question`, it is suppressed when a

 *  prior gesture on the same lane fired within the last REFRACTORY_S (the

 *  trigger list the render carries preserves that history; a renderer that

 *  forgets history leaves refractory to the emitter, per STATE_ENGINE).


 *  Future triggers (at > now>and stale ones (sound already finished)

 *  never fire;the player is re-evaluated on each tick so nothing is

 *  missed when driving deterministically.


 */

export function evaluateGestureTriggers(
  previous: readonly LaneRender[],

  next: readonly LaneRender[],

  now: number,
): readonly GestureTrigger[] {
  const out: GestureTrigger[] = [];

  for (let laneIndex = 0; laneIndex < next.length; laneIndex++) {
    const current = next[laneIndex];

    if (current === undefined) continue;

    const previousKeys = new Set((previous[laneIndex]?.gestures ?? []).map(gestureKey));

    const fresh = (current.gestures ?? []).filter((g) => !previousKeys.has(gestureKey(g)));

    const due = fresh.filter((g) => g.at <= now && g.at + gestureBusyS(g.gesture) > now);

    if (due.length === 0) continue;

    const winner = [...due].sort(
      (a, b) => GESTURE_PRIORITY[b.gesture] - GESTURE_PRIORITY[a.gesture] || a.at - b.at,
    )[0];

    if (winner === undefined) continue;

    if (winner.gesture !== "question") {
      const priorRecent = (current.gestures ?? []).some(
        (g) => g.at < winner.at && g.at >= winner.at - REFRACTORY_S,
      );

      if (priorRecent) continue;
    }

    out.push({ laneIndex: current.laneId, gesture: winner.gesture, at: winner.at });
  }

  return out;
}
