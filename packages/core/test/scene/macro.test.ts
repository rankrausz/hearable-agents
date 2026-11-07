// packages/core/test/scene/macro.test.ts — behaviour tests for the
// macro-evolution schedule: the world runs on injected clock+RNG over
// 1–4 minute epochs, is identical with and without agent traffic, and is
// modulated — never re-triggered — by meso presence and Calm. The chord
// itself is covered in field.test.ts (ADR 0025).

import { describe, expect, it } from "vitest";

import {
  createRng,
  type LaneRender,
  MACRO_EPOCH_SECONDS_MAX,
  MACRO_EPOCH_SECONDS_MIN,
  macroAt,
  macroAtSeed,
  macroFieldCutoffHz,
  macroPulseHz,
  macroSwellCutoffHz,
  modulateMacro,
  nextBoundaryAfter,
  render,
  renderWithMacro,
  SceneParamsSchema,
} from "../../src/index.js";

function lane(overrides: Partial<LaneRender> = {}): LaneRender {
  return {
    laneId: 0,
    lifecycle: "active",
    mode: { exploring: 1, editing: 0, testing: 0, other: 0 },
    displayedMode: "exploring",
    activity: 0.8,
    progress: 0.2,
    struggle: 0.1,
    prominence: 0.5,
    foreground: false,
    gestures: [],
    ...overrides,
  };
}

describe("macro schedule", () => {
  it("re-voices every 1–4 minutes on the seeded clock", () => {
    expect(MACRO_EPOCH_SECONDS_MIN).toBe(60);
    expect(MACRO_EPOCH_SECONDS_MAX).toBe(240);
    const first = macroAtSeed(161, 0);
    expect(first.atSeconds).toBe(0);
    // The first epoch lasts 1–4 minutes: the checkpoint at t=0 still
    // sounds just before its end, and a later one after a full epoch.
    const firstLength = nextBoundaryAfter(161, 0);
    expect(firstLength).toBeGreaterThanOrEqual(60);
    expect(firstLength).toBeLessThanOrEqual(240);
    expect(macroAtSeed(161, firstLength - 1).atSeconds).toBe(0);
    expect(macroAtSeed(161, firstLength).atSeconds).toBe(firstLength);
  });

  it("is deterministic for one seed and distinct across seeds", () => {
    expect(macroAtSeed(161, 500)).toEqual(macroAtSeed(161, 500));
    expect(macroAtSeed(161, 500)).not.toEqual(macroAtSeed(162, 500));
  });

  it("reads the injected RNG, never a shared stream", () => {
    const first = macroAt(500, createRng(161));
    const second = macroAt(500, createRng(161));
    expect(first).toEqual(second);
    // Asking about another epoch first cannot steer this one: forks
    // never advance the parent.
    const rng = createRng(161);
    macroAt(10_000, rng);
    expect(macroAt(500, rng)).toEqual(first);
  });
});

describe("macro checkpoint shape", () => {
  it("keeps swell, density, brightness and bloom inside their declared ranges", () => {
    const rng = createRng(7);
    for (let t = 0; t < 3600; t += 17) {
      const state = macroAt(t, rng);
      expect(state.textureSwell).toBeGreaterThanOrEqual(0.25);
      expect(state.textureSwell).toBeLessThanOrEqual(0.8);
      expect(state.densityShare).toBeGreaterThanOrEqual(0.4);
      expect(state.densityShare).toBeLessThanOrEqual(0.9);
      expect(state.brightnessDb).toBeGreaterThanOrEqual(-2);
      expect(state.brightnessDb).toBeLessThanOrEqual(1.5);
      expect(state.bedBloomDb).toBeGreaterThanOrEqual(-1.5);
      expect(state.bedBloomDb).toBeLessThanOrEqual(1.5);
    }
  });
});

describe("macro independence from agent traffic", () => {
  it("sounds the identical full macro output under idle, busy and waiting lanes", () => {
    // revp3t12: the independence property covers the COMPLETE
    // audio-driving output — every field apply.ts reads — not just
    // mode/pivot/addedTone. Density/brightness/bloom move only with the
    // explicit presence/calm arguments (meso modulation), never with
    // lane contents. The one exception is the empty room (no lane at all
    // working), which only scales levels; it is covered in render.test.ts.
    const seed = 161;
    const at = 500;
    const expected = renderWithMacro([lane({ lifecycle: "quiet", activity: 0 })], 0.6, {
      nowSeconds: at,
      seed,
      presence: 0.7,
      calm: 0.6,
      applyWorld: true,
    }).macro;
    const traffic: LaneRender[][] = [
      [lane({ lifecycle: "active", activity: 0.2 }), lane({ laneId: 1, lifecycle: "idle" })],
      [
        lane({ lifecycle: "active", activity: 1, struggle: 1 }),
        lane({ laneId: 1, lifecycle: "waiting", activity: 1 }),
        lane({ laneId: 2, lifecycle: "turn_complete", activity: 1 }),
      ],
    ];
    for (const lanes of traffic) {
      const scene = renderWithMacro(
        lanes,
        0.6,
        { nowSeconds: at, seed, presence: 0.7, calm: 0.6, applyWorld: true },
        lanes.map(() => 0),
      );
      expect(scene.macro).toEqual(expected);
      expect(SceneParamsSchema.safeParse(scene).success).toBe(true);
    }
  });

  it("keeps checkpoint timing fixed while agent presence varies", () => {
    const first = renderWithMacro([lane()], 0.6, {
      nowSeconds: 500,
      seed: 161,
      presence: 0,
      calm: 0.6,
      applyWorld: true,
    });
    const second = renderWithMacro([lane({ activity: 1, struggle: 1 })], 0.6, {
      nowSeconds: 500,
      seed: 161,
      presence: 1,
      calm: 0.6,
      applyWorld: true,
    });
    // Identity fields hold; scaled levels move with the explicit
    // modulation arguments only.
    expect(second.macro.energy).toBe(first.macro.energy);
    expect(second.macro.fieldVoices).toEqual(first.macro.fieldVoices);
    expect(second.macro.pulseHz).toBe(first.macro.pulseHz);
    expect(second.macro.swellCutoffHz).toBe(first.macro.swellCutoffHz);
    expect(second.macro.fieldCutoffHz).toBe(first.macro.fieldCutoffHz);
  });

  it("steps the world through seeded boundaries on the clock alone", () => {
    const seed = 161;
    const first = nextBoundaryAfter(seed, 0);
    const second = nextBoundaryAfter(seed, first);
    expect(second).toBeGreaterThan(first);
    expect(macroAtSeed(seed, first).atSeconds).toBe(first);
    expect(macroAtSeed(seed, second).atSeconds).toBe(second);
  });
});

describe("checkpoint audio-driving fields", () => {
  it("maps density to a slow pulse and brightness to cutoffs", () => {
    const macro = macroAtSeed(161, 500);
    const pulse = macroPulseHz(macro);
    expect(pulse).toBeGreaterThanOrEqual(0.05);
    expect(pulse).toBeLessThanOrEqual(0.45);
    const swell = macroSwellCutoffHz(macro);
    expect(swell).toBeGreaterThanOrEqual(800);
    expect(swell).toBeLessThanOrEqual(3000);
    const field = macroFieldCutoffHz(macro);
    expect(field).toBeGreaterThanOrEqual(1100);
    expect(field).toBeLessThanOrEqual(1700);
    // Monotone in the checkpoint: brighter checkpoints sound brighter.
    const dim = modulateMacro({ ...macro, brightnessDb: -2 }, { presence: 1, calm: 0 });
    const bright = modulateMacro({ ...macro, brightnessDb: 1.5 }, { presence: 1, calm: 0 });
    expect(bright.swellCutoffHz).toBeGreaterThan(dim.swellCutoffHz);
    expect(bright.fieldCutoffHz).toBeGreaterThan(dim.fieldCutoffHz);
  });

  it("keeps rate and cutoffs fixed while meso scales levels, the field included", () => {
    const macro = macroAtSeed(161, 500);
    const loud = modulateMacro(macro, { presence: 1, calm: 0 });
    const quiet = modulateMacro(macro, { presence: 0, calm: 1 });
    expect(loud.pulseHz).toBe(quiet.pulseHz);
    expect(loud.swellCutoffHz).toBe(quiet.swellCutoffHz);
    expect(loud.fieldCutoffHz).toBe(quiet.fieldCutoffHz);
    expect(loud.textureSwell).toBeGreaterThan(quiet.textureSwell);
    expect(loud.densityScale).toBeGreaterThan(quiet.densityScale);
    expect(loud.fieldGain).toBe(1);
    expect(quiet.fieldGain).toBeCloseTo(0.5 * 0.7, 6);
    // A solo agent keeps most of the chord: the presence floor is high.
    const solo = modulateMacro(macro, { presence: 0, calm: 0 });
    expect(solo.fieldGain).toBeCloseTo(0.7, 6);
    // Near-silence drops the field 20 dB, never removes it.
    const hush = modulateMacro(macro, { presence: 1, calm: 0.9, nearSilence: true });
    expect(hush.fieldGain).toBeCloseTo((1 - 0.45) * 0.1, 6);
  });
});

describe("meso modulation without re-triggering", () => {
  it("scales the world with presence and calm, never its contents", () => {
    const macro = macroAtSeed(161, 500);
    const loud = modulateMacro(macro, { presence: 1, calm: 0 });
    const quiet = modulateMacro(macro, { presence: 0, calm: 1 });
    expect(loud.atSeconds).toBe(macro.atSeconds);
    expect(quiet.atSeconds).toBe(macro.atSeconds);
    expect(loud.textureSwell).toBeGreaterThan(quiet.textureSwell);
    expect(loud.densityScale).toBeGreaterThan(quiet.densityScale);
  });

  it("leaves lane register, timbre and pan fields untouched", () => {
    const plain = render([lane({ laneId: 1 })], 0.6);
    const world = renderWithMacro([lane({ laneId: 1 })], 0.6, {
      nowSeconds: 500,
      seed: 161,
      presence: 0.7,
      calm: 0.6,
      applyWorld: true,
    });
    expect(world.lanes.map((voice) => voice.laneId)).toEqual(
      plain.lanes.map((voice) => voice.laneId),
    );
    expect(world.lanes[0]?.grain.noteSet).toBe(plain.lanes[0]?.grain.noteSet);
    expect(world.lanes[0]?.grain.upperRegister).toBe(plain.lanes[0]?.grain.upperRegister);
    expect(world.lanes[0]?.proximity.width).toBe(plain.lanes[0]?.proximity.width);
  });

  it("keeps the default render byte-identical for pre-macro callers", () => {
    const scene = render([lane()], 0.6);
    expect(scene.densityScale).toBe(1 - 0.5 * 0.6);
    expect(scene.bed.gainDbfs).toBe(-33);
  });
});
