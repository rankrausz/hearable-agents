// packages/audio/test/voices.test.ts — behaviour tests for the Clearing
// musical framework: D pentatonic quantization, lane registers/timbres/pans
// and the no-pure-sines invariant (fatigue rule 3) on every voice recipe.

import { describe, expect, it } from "vitest";
import { midiToFrequency, panForRegister, recipeForLane } from "../src/graph/index.js";
import {
  BELL_VOICE,
  CLEARING_KEY,
  DRONE_CUTOFF_HZ,
  DRONE_VOICE,
  FLUTE_VOICE,
  GLASS_VOICE,
  hasHarmonicContent,
  LANE_PANS,
  LANE_TIMBRES,
  MALLET_VOICE,
  noteInRegister,
  PAD_VOICE,
  PENTATONIC_OFFSETS,
  quantizeToPentatonic,
  SUSTAINED_TONE_CEILING_HZ,
} from "../src/scenes/clearing/index.js";

describe("scene framework", () => {
  it("stays in D pentatonic", () => {
    expect(CLEARING_KEY).toBe("D");
    expect([...PENTATONIC_OFFSETS]).toEqual([0, 2, 4, 7, 9]);
  });

  it("quantizes every chromatic step into the set", () => {
    for (let midi = 30; midi < 100; midi += 1) {
      const quantized = quantizeToPentatonic(midi);
      const pitchClass = (((quantized - 2) % 12) + 12) % 12;
      expect(PENTATONIC_OFFSETS).toContain(pitchClass);
      expect(Math.abs(quantized - midi)).toBeLessThanOrEqual(4);
    }
  });

  it("keeps lane notes inside their register", () => {
    expect(noteInRegister(20, "low", false)).toBeGreaterThanOrEqual(33);
    expect(noteInRegister(110, "high", false)).toBeLessThanOrEqual(88);
    const upper = noteInRegister(69, "mid", true);
    const lower = noteInRegister(69, "mid", false);
    expect(upper).toBeGreaterThanOrEqual(lower);
  });

  it("assigns registers, timbres and pans per the framework table", () => {
    expect(recipeForLane(0)).toBe(PAD_VOICE);
    expect(recipeForLane(1)).toBe(MALLET_VOICE);
    expect(recipeForLane(2)).toBe(FLUTE_VOICE);
    expect(recipeForLane(3)).toBe(GLASS_VOICE);
    expect(LANE_TIMBRES).toEqual({ low: "pad", mid: "mallet", high: "flute", upper: "glass" });
    expect([panForRegister(0), panForRegister(1), panForRegister(2)]).toEqual([
      LANE_PANS.low,
      LANE_PANS.mid,
      LANE_PANS.high,
    ]);
    expect(LANE_PANS.low).toBe(-0.6);
    expect(LANE_PANS.mid).toBe(0);
    expect(LANE_PANS.high).toBe(0.6);
    expect(panForRegister(3)).toBe(LANE_PANS.upper);
    expect(LANE_PANS.upper).toBe(0);
  });

  it("rests the drone on D2+D3 low-passed at ~400 Hz", () => {
    expect(DRONE_CUTOFF_HZ).toBe(400);
    expect(DRONE_VOICE.lowpassHz).toBe(400);
    const midis = DRONE_VOICE.oscillators.map((osc) => osc.midi);
    expect(midis).toContain(38);
    expect(midis).toContain(50);
  });

  it("builds the lane C flute soft: breathy pair under the ceiling, no FM glass", () => {
    expect(FLUTE_VOICE.name).toBe("flute");
    expect(FLUTE_VOICE.lowpassHz).toBeLessThanOrEqual(2800);
    expect(FLUTE_VOICE.oscillators.every((osc) => osc.fm === undefined)).toBe(true);
    expect(hasHarmonicContent(FLUTE_VOICE)).toBe(true);
    // The retired FM bell stays exported for reference only.
    expect(BELL_VOICE.lowpassHz).toBe(6000);
  });

  it("builds the upper seat as dark struck glass, not a second flute or bell", () => {
    expect(GLASS_VOICE.name).toBe("glass");
    expect(GLASS_VOICE.lowpassHz).toBeLessThan(FLUTE_VOICE.lowpassHz);
    expect(GLASS_VOICE.oscillators.every((osc) => osc.fm === undefined)).toBe(true);
    expect(hasHarmonicContent(GLASS_VOICE)).toBe(true);
    const [fundamental, partial] = GLASS_VOICE.oscillators;
    // In key, inside the seat, and not the flute's A5.
    expect(fundamental?.midi).toBe(74);
    expect(fundamental?.midi).not.toBe(FLUTE_VOICE.oscillators[0]?.midi);
    expect(quantizeToPentatonic(fundamental?.midi ?? 0)).toBe(fundamental?.midi);
    // The octave partial: the even-harmonic spectrum that tells glass from
    // flute when the image is summed to mono.
    expect((partial?.midi ?? 0) - (fundamental?.midi ?? 0)).toBe(12);
  });

  it("tunes every voice below the sustained-tone ceiling", () => {
    for (const recipe of [DRONE_VOICE, PAD_VOICE, MALLET_VOICE, FLUTE_VOICE, GLASS_VOICE]) {
      for (const osc of recipe.oscillators) {
        expect(midiToFrequency(osc.midi)).toBeLessThan(SUSTAINED_TONE_CEILING_HZ);
      }
    }
  });
});

describe("harmonic content", () => {
  it("gives every pitched voice two partials or a detuned copy", () => {
    for (const recipe of [
      DRONE_VOICE,
      PAD_VOICE,
      MALLET_VOICE,
      FLUTE_VOICE,
      GLASS_VOICE,
      BELL_VOICE,
    ]) {
      expect(hasHarmonicContent(recipe)).toBe(true);
    }
  });

  it("rejects a lone pure sine", () => {
    expect(
      hasHarmonicContent({
        name: "pad",
        oscillators: [{ type: "sine", midi: 69, detuneCents: 0 }],
        lowpassHz: 1200,
      }),
    ).toBe(false);
  });
});
