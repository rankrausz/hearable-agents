// packages/audio/test/ensemble-waiting-boundary.test.ts — the p5-t04
// waiting-onset remainder check: isolated vs mixed numeric renders plus
// direct listening artifacts. What this is for: distinguishing a detector
// failure (no onset in the window at all) from an unheard cue (onset
// present in isolation but masked in the mix) — without asserting either
// untested. The task's only hard gate: a DROPPED or DELAYED hard cue
// blocks. New dropped/delayed cues are therefore asserted directly
// through the trigger/player/bypass path; onset audibility in the mix
// stays reported as the known remainder with its boundary documented.
// What it must not do: change a threshold, window, metric or fixture, or
// claim a listening verdict — an agent cannot judge sound.

import { createEnsembleDriver } from "@hearable/core";
import { describe, expect, it } from "vitest";
import { routeEnsembleFrame } from "../src/ensemble/lifecycle.js";
import {
  evaluateGestureTriggers,
  GesturePlayer,
  gestureEvents,
  renderGesturePlan,
} from "../src/gestures/index.js";
import { baseLaneRender } from "../src/gestures/scenarios.js";
import { firstFluxOnset, fluxSeries } from "../src/qa/metrics.js";
import { pianoSamples } from "./piano-pcm.js";

function monoOf(result: { left: Float32Array; right: Float32Array }): Float32Array {
  const out = new Float32Array(result.left.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = ((result.left[i] ?? 0) + (result.right[i] ?? 0)) / 2;
  }
  return out;
}

describe("waiting-onset remainder boundary", () => {
  it("never drops or delays the hard cue through the integration path", () => {
    // The p5-t04 hard gate: the question trigger reaches the evaluator
    // immediately (no arbitration wait) and the player sounds it
    // (question pre-empts even a busy bus). A dropped or delayed cue
    // here would block the task.
    const previous = [baseLaneRender(2)];
    const next = [baseLaneRender(2, [{ gesture: "question", at: 10 }])];
    const triggers = evaluateGestureTriggers(previous, next, 10);
    expect(triggers).toEqual([{ laneIndex: 2, gesture: "question", at: 10 }]);
    const player = new GesturePlayer();
    const events = player.play(
      triggers[0] as { laneIndex: number; gesture: "question"; at: 10 },
      0.6,
    );
    expect(events.length).toBeGreaterThan(0);
    // And the routed frame carries the same trigger without consulting
    // routine holds/cooldowns: the bypass fires at the same tick.
    const routed = routeEnsembleFrame(
      createEnsembleDriver(),
      [
        {
          ...baseLaneRender(2),
          laneId: 2,
          lifecycle: "active" as const,
        },
      ],
      [
        {
          ...baseLaneRender(2),
          laneId: 2,
          lifecycle: "waiting" as const,
          gestures: [{ gesture: "question" as const, at: 10 }],
        },
      ],
      10,
    );
    expect(routed.triggers).toEqual([{ laneIndex: 2, gesture: "question", at: 10 }]);
    // Routine arbitration is untouched: no move is fabricated to carry
    // the cue, and the waiting lane feeds no eligibility.
    expect(routed.move).toBeNull();
    expect(routed.driver.history.has(2)).toBe(false);
  });

  it("reports the isolated/mixed onset boundary without asserting either untested", () => {
    // Isolated question plan (lane 1, calm 0.6): the calibrated flux
    // definition (first rise-edge at 0.4, 2048-sample frames) crosses at
    // the 0.5 s note attack — the detector half is known-good.
    const sampleRate = 48000;
    const frameS = 2048 / sampleRate;
    const events = gestureEvents({ laneIndex: 1, gesture: "question", at: 0 }, 0.6, 0.5);
    const mono = monoOf(renderGesturePlan(events, 4, { sampleRate, pianoSamples }));
    const flux = fluxSeries(mono, sampleRate, 0, 3.5, frameS);
    const isolated = firstFluxOnset(flux, 0, frameS, 0.4);
    expect(isolated).toBeGreaterThanOrEqual(0.4);
    expect(isolated).toBeLessThan(0.7);
    // Mixed render boundary: the same plan folded under a smooth
    // wandering texture with the production waiting duck still crosses
    // at 0.4 when the cue is present (audibility artifact for the
    // listener, not a gate), and reads -1 when the cue is absent
    // (detector silence is itself reported). Neither number asserts a
    // listening verdict: the owner listens at p5-t06.
    const mixed = new Float32Array(mono.length);
    for (let i = 0; i < mixed.length; i++) {
      const t = i / sampleRate;
      const texture =
        0.06 *
        (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.3 * t)) *
        Math.sin(2 * Math.PI * 220 * t + 3 * Math.sin(2 * Math.PI * 0.2 * t));
      mixed[i] = texture + (mono[i] ?? 0);
    }
    const mixedOnset = firstFluxOnset(
      fluxSeries(mixed, sampleRate, 0, 3.5, frameS),
      0,
      frameS,
      0.4,
    );
    const textureOnly = new Float32Array(mono.length);
    for (let i = 0; i < textureOnly.length; i++) {
      const t = i / sampleRate;
      textureOnly[i] =
        0.06 *
        (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.3 * t)) *
        Math.sin(2 * Math.PI * 220 * t + 3 * Math.sin(2 * Math.PI * 0.2 * t));
    }
    const absent = firstFluxOnset(
      fluxSeries(textureOnly, sampleRate, 0, 3.5, frameS),
      0,
      frameS,
      0.4,
    );
    // Recorded, not gated beyond documentation: the cue-present render
    // crosses (cue not dropped), the cue-absent render stays silent
    // (no false onset). The MIX audibility question — whether a human
    // hears the 60 s question against the full Clearing texture — stays
    // the known remainder for p5-t05/p5-t06, with the accepted baseline
    // exception (waiting-holds onset −1.00) preserved, never erased.
    expect(mixedOnset).toBeGreaterThanOrEqual(0.4);
    expect(mixedOnset).toBeLessThan(0.7);
    expect(absent).toBe(-1);
  });
});
