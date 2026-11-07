// packages/audio/test/nature.test.ts — behaviour tests for the pure
// nature-bed schedule: seeded offsets, tick parity, and voice gains.
// What this is for: proving, without a browser, that the two loop voices
// start half a loop apart deterministically, the crossfade alternates per
// tick, and the pair never lifts above the planned seat. What it must not
// do: import Tone or touch the network — the schedule is pure data.

import { describe, expect, it } from "vitest";

import { natureCrossfadeParity, natureOffsets, natureVoiceGains } from "../src/graph/index.js";
import { NATURE_BED } from "../src/scenes/clearing/index.js";

describe("nature-bed schedule", () => {
  it("staggers the loop voices by half the loop, deterministically", () => {
    const first = natureOffsets(NATURE_BED.seed);
    expect(natureOffsets(NATURE_BED.seed)).toEqual(first);
    for (const offset of [first.voiceA, first.voiceB]) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(NATURE_BED.loopDurationS);
    }
    const gap = Math.abs(first.voiceA - first.voiceB);
    expect(gap).toBeCloseTo(NATURE_BED.loopDurationS / 2, 6);
  });

  it("varies the offsets with the seed", () => {
    expect(natureOffsets(1)).not.toEqual(natureOffsets(2));
  });

  it("alternates the crossfade parity per tick", () => {
    expect(natureCrossfadeParity(0)).toBe(0);
    expect(natureCrossfadeParity(1)).toBe(1);
    expect(natureCrossfadeParity(2)).toBe(0);
  });

  it("holds the voice pair at equal power, never above the seat", () => {
    for (const parity of [0, 1] as const) {
      const [gainA, gainB] = natureVoiceGains(parity);
      expect((gainA ?? 0) ** 2 + (gainB ?? 0) ** 2).toBeCloseTo(1, 12);
      expect(gainA).toBeLessThanOrEqual(1);
      expect(gainB).toBeLessThanOrEqual(1);
    }
    // The two parities lead opposite voices, so the loop phase never sits.
    expect(natureVoiceGains(0)[0]).not.toBe(natureVoiceGains(1)[0]);
  });
});
