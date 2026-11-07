// Proves overflow watcher semantics and sampled piano scheduling; must not infer agent state.
import { describe, expect, it, vi } from "vitest";

vi.mock("tone", () => ({}));

import { scheduleOverflowCue } from "../src/apply.js";
import {
  INITIAL_OVERFLOW_WATCH,
  OVERFLOW_CUE_ENABLED,
  overflowCuePlan,
  watchOverflow,
} from "../src/overflow.js";
import { OVERFLOW_CUE } from "../src/scenes/clearing/index.js";

function drive(frames: readonly (readonly [number, readonly string[]])[]): number[] {
  let watch = INITIAL_OVERFLOW_WATCH;
  const cues: number[] = [];
  for (const [nowS, queued] of frames) {
    const next = watchOverflow(watch, queued, nowS);
    watch = next.watch;
    if (next.cue) cues.push(nowS);
  }
  return cues;
}

describe("announced overflow", () => {
  it("defaults on, behind the one switch that makes it UI-only", () => {
    expect(OVERFLOW_CUE_ENABLED).toBe(true);
  });

  it("cues once when a session is newly queued", () => {
    expect(
      drive([
        [0, []],
        [1, ["s5"]],
        [2, ["s5"]],
        [3, ["s5"]],
      ]),
    ).toEqual([1]);
  });

  it("never cues for what was already queued when the watch starts", () => {
    // A reconnect or fresh page load is told by the UI, not a burst.
    expect(
      drive([
        [0, ["s5", "s6"]],
        [1, ["s5", "s6"]],
      ]),
    ).toEqual([]);
  });

  it("folds sessions queued close together into one cue", () => {
    const soon = OVERFLOW_CUE.minSpacingS - 1;
    expect(
      drive([
        [0, []],
        [1, ["s5"]],
        [1 + soon, ["s5", "s6"]],
      ]),
    ).toEqual([1]);
    const later = OVERFLOW_CUE.minSpacingS;
    expect(
      drive([
        [0, []],
        [1, ["s5"]],
        [1 + later, ["s5", "s6"]],
      ]),
    ).toEqual([1, 1 + later]);
  });

  it("stays quiet when the queue drains and treats a later re-queue as new", () => {
    const gap = OVERFLOW_CUE.minSpacingS;
    expect(
      drive([
        [0, []],
        [1, ["s5"]],
        [2, []],
        [2 + gap, ["s5"]],
      ]),
    ).toEqual([1, 2 + gap]);
    expect(
      drive([
        [0, []],
        [1, ["s5"]],
        [2, []],
      ]),
    ).toEqual([1]);
  });

  it("plans a quieter four-note piano roll with an overlapping natural tail", () => {
    const plan = overflowCuePlan();
    expect(plan.voices).toHaveLength(4);
    expect(plan.peakGain).toBeLessThan(0.34 / 3);
    expect(plan.holdUntilS + plan.releaseS).toBeLessThan(5);
    for (let i = 1; i < plan.voices.length; i++)
      expect(plan.voices[i]?.startS ?? 0).toBeGreaterThan(plan.voices[i - 1]?.startS ?? 0);
  });
});
describe("overflow cue scheduling", () => {
  it("plays the recorded piano on the owned room sampler at absolute offsets", () => {
    const play = vi.fn();
    const graph = { piano: { overflow: { triggerAttackRelease: play } } };
    const plan = overflowCuePlan();
    scheduleOverflowCue(graph as never, plan, 10);
    expect(play).toHaveBeenCalledTimes(4);
    for (const [i, voice] of plan.voices.entries()) {
      expect(play.mock.calls[i]).toEqual([
        440 * 2 ** ((voice.midi - 69) / 12),
        plan.holdUntilS - voice.startS,
        10 + voice.startS,
        plan.peakGain * voice.touch,
      ]);
    }
  });
});
