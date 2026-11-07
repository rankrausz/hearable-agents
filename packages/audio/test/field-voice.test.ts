// packages/audio/test/field-voice.test.ts — Node proofs for the harmonic
// field's audio path (ADR 0025): the plan turns a core chord into slot
// levels and handovers, a handover crossfades the two banks over the
// fieldCrossfade class and never bends a pitch, a retune only ever touches
// a silent bank, the detune follows the interval class, and the seat gain
// scales with the core field gain.

import { render, renderWithMacro } from "@hearable/core";
import { describe, expect, it } from "vitest";
import {
  CROSSFADE_MID_GAIN,
  crossfadeFieldVoice,
  fieldDetuneCents,
  rampFieldSlot,
} from "../src/apply.js";
import { midiToFrequency, planGraph } from "../src/graph/index.js";
import { RAMP_TIMES } from "../src/ramps.js";
import { HARMONIC_FIELD } from "../src/scenes/clearing/index.js";

type Ramp = { to: number; dur: number; start: number };
type SetValue = { value: number; t: number };

function fakeParam() {
  const ramps: Ramp[] = [];
  const setValues: SetValue[] = [];
  return {
    ramps,
    setValues,
    linearRampTo: (to: number, dur: number, start: number) => {
      ramps.push({ to, dur, start });
    },
    exponentialRampTo: (to: number, dur: number, start: number) => {
      ramps.push({ to, dur, start });
    },
    targetRampTo: (to: number, dur: number, start: number) => {
      ramps.push({ to, dur, start });
    },
    setValueAtTime: (value: number, t: number) => {
      setValues.push({ value, t });
    },
  };
}

function fakeVoice() {
  return { frequency: fakeParam(), detune: fakeParam() };
}

function fakeSlot() {
  const banks = [0, 1].map(() => {
    const voices = [fakeVoice(), fakeVoice(), fakeVoice()];
    const gains = [{ gain: fakeParam() }, { gain: fakeParam() }, { gain: fakeParam() }];
    return { voices, gains, midi: [50, 50, 62] };
  });
  return {
    banks,
    breathLfo: {},
    breathDepth: {},
    gain: { gain: fakeParam() },
    panner: {},
  };
}

function lane(laneId = 0) {
  return {
    laneId,
    lifecycle: "active" as const,
    mode: { exploring: 0.5, editing: 0.3, testing: 0.2, other: 0 },
    displayedMode: "exploring" as const,
    activity: 0.6,
    progress: 0.2,
    struggle: 0.1,
    prominence: 0.5,
    foreground: false,
    gestures: [],
  };
}

describe("harmonic field plan", () => {
  it("plans one slot per core field voice, levels on the fieldVoice ramp", () => {
    const params = render([lane()], 0.6);
    const plan = planGraph(params);
    expect(plan.fieldVoices).toHaveLength(params.macro.fieldVoices.length);
    plan.fieldVoices.forEach((voice, slot) => {
      const source = params.macro.fieldVoices[slot];
      expect(voice.gain.ramp).toBe("fieldVoice");
      expect(voice.gain.target).toBe(source?.level ?? 0);
      expect(voice.midi).toBe(source?.midi ?? null);
      expect(voice.moves).toBe(0);
      expect(voice.handover).toBe(false);
      // First apply: every sounding slot retunes its bank before it fades in.
      expect(voice.retune).toBe(source?.midi !== null);
    });
    expect(plan.macroFieldGain.ramp).toBe("density");
    expect(plan.macroFieldGain.target).toBe(params.macro.fieldGain);
  });

  it("marks a pitch change on a sounding slot as a handover and counts it", () => {
    const first = planGraph(render([lane()], 0.6));
    const sounding = first.fieldVoices.findIndex((voice) => voice.midi !== null);
    expect(sounding).toBeGreaterThanOrEqual(0);
    const advanced = {
      ...first,
      fieldVoices: first.fieldVoices.map((voice) => ({
        ...voice,
        gain: { ...voice.gain, current: voice.gain.target },
        handover: false,
        retune: false,
      })),
    };
    const params = render([lane()], 0.6);
    const moved = {
      ...params,
      macro: {
        ...params.macro,
        fieldVoices: params.macro.fieldVoices.map((voice, slot) =>
          slot === sounding && voice.midi !== null ? { ...voice, midi: voice.midi + 2 } : voice,
        ),
      },
    };
    const second = planGraph(moved, advanced);
    const voice = second.fieldVoices[sounding];
    expect(voice?.handover).toBe(true);
    expect(voice?.retune).toBe(false);
    expect(voice?.moves).toBe(1);
    // Unchanged slots neither hand over nor retune.
    second.fieldVoices.forEach((other, slot) => {
      if (slot === sounding) return;
      expect(other.handover).toBe(false);
      expect(other.retune).toBe(false);
    });
  });

  it("retunes instead of crossfading when the slot is silent, and keeps the last pitch through silence", () => {
    const params = render([lane()], 0.6);
    const silentSlot = params.macro.fieldVoices.findIndex((voice) => voice.midi === null);
    expect(silentSlot).toBeGreaterThanOrEqual(0);
    const first = planGraph(params);
    const advanced = {
      ...first,
      fieldVoices: first.fieldVoices.map((voice) => ({
        ...voice,
        gain: { ...voice.gain, current: voice.gain.target },
        handover: false,
        retune: false,
      })),
    };
    const entering = {
      ...params,
      macro: {
        ...params.macro,
        fieldVoices: params.macro.fieldVoices.map((voice, slot) =>
          slot === silentSlot ? { midi: 74, level: 0.5 } : voice,
        ),
      },
    };
    const second = planGraph(entering, advanced);
    const voice = second.fieldVoices[silentSlot];
    expect(voice?.retune).toBe(true);
    expect(voice?.handover).toBe(false);
    expect(voice?.moves).toBe(0);
    expect(voice?.gain.current).toBe(0);
    expect(voice?.gain.target).toBe(0.5);
    // Leaving again keeps the pitch on the descriptor.
    const leaving = planGraph(params, {
      ...second,
      fieldVoices: second.fieldVoices.map((v) => ({
        ...v,
        gain: { ...v.gain, current: v.gain.target },
      })),
    });
    expect(leaving.fieldVoices[silentSlot]?.midi).toBe(74);
    expect(leaving.fieldVoices[silentSlot]?.gain.target).toBe(0);
  });
});

describe("blooms", () => {
  it("schedules each announced bloom once across consecutive applies", () => {
    const params = render([lane()], 0.6);
    const announced = {
      ...params,
      macro: {
        ...params.macro,
        pings: [
          { id: 7, inS: 1.2, midi: 74, level: 0.8 },
          { id: 8, inS: 2.7, midi: 76, level: 0.6 },
        ],
      },
    };
    const first = planGraph(announced);
    expect(first.fieldPings.map((p) => p.id)).toEqual([7, 8]);
    expect(first.fieldPingsThroughId).toBe(8);
    const again = planGraph(
      {
        ...announced,
        macro: {
          ...announced.macro,
          pings: [
            { id: 8, inS: 2.2, midi: 76, level: 0.6 },
            { id: 9, inS: 2.9, midi: 71, level: 0.7 },
          ],
        },
      },
      first,
    );
    expect(again.fieldPings.map((p) => p.id)).toEqual([9]);
    expect(again.fieldPingsThroughId).toBe(9);
    const none = planGraph(params, again);
    expect(none.fieldPings).toEqual([]);
    expect(none.fieldPingsThroughId).toBe(9);
  });
});

describe("harmonic field handover", () => {
  it("crossfades the banks over the fieldCrossfade class and retunes only the incoming bank", () => {
    const slot = fakeSlot();
    crossfadeFieldVoice(slot as never, 66, 40, 0);
    const half = RAMP_TIMES.fieldCrossfade.seconds / 2;
    const [pairA, pairB, partial] = slot.banks[1]?.voices ?? [];
    const cents = fieldDetuneCents(66); // F#4: a colour tone, cut by the beat ceiling
    expect(pairA?.frequency.setValues).toEqual([
      { value: midiToFrequency(66) * 2 ** (-cents / 1200), t: 40 },
    ]);
    expect(pairB?.frequency.setValues).toEqual([
      { value: midiToFrequency(66) * 2 ** (cents / 1200), t: 40 },
    ]);
    // The octave partial keeps its offset from the bank root, spread halfway.
    expect(partial?.frequency.setValues).toEqual([
      { value: midiToFrequency(78) * 2 ** (cents / 2 / 1200), t: 40 },
    ]);
    // The detune param belongs to the drift LFO: never written by a retune.
    for (const voice of slot.banks[1]?.voices ?? []) expect(voice.detune.setValues).toEqual([]);
    for (const voice of slot.banks[0]?.voices ?? []) {
      expect(voice.frequency.setValues).toEqual([]);
    }
    for (const gain of slot.banks[0]?.gains ?? []) {
      expect(gain.gain.ramps).toEqual([
        { to: CROSSFADE_MID_GAIN, dur: half, start: 40 },
        { to: 0, dur: half, start: 40 + half },
      ]);
    }
    for (const gain of slot.banks[1]?.gains ?? []) {
      expect(gain.gain.ramps).toEqual([
        { to: CROSSFADE_MID_GAIN, dur: half, start: 40 },
        { to: 1, dur: half, start: 40 + half },
      ]);
    }
  });

  it("tunes each voice clean: no spread, so nothing beats", () => {
    for (const midi of [50, 57, 64, 71, 73, 80, 86]) {
      expect(fieldDetuneCents(midi)).toBe(0);
    }
    const slot = fakeSlot();
    crossfadeFieldVoice(slot as never, 73, 10, 0);
    const [voice] = slot.banks[1]?.voices ?? [];
    expect(voice?.frequency.setValues[0]?.value).toBeCloseTo(midiToFrequency(73), 6);
  });

  it("applies a slot plan: handover, silent retune, or level only", () => {
    const gainMove = {
      path: "macro.field.voice0.gain",
      ramp: "fieldVoice" as const,
      current: 0,
      target: 0.7,
    };
    const handover = fakeSlot();
    rampFieldSlot(
      handover as never,
      { midi: 62, gain: gainMove, moves: 1, handover: true, retune: false },
      5,
    );
    expect(handover.banks[1]?.voices[0]?.frequency.setValues[0]?.value).toBeCloseTo(
      midiToFrequency(62) * 2 ** (-HARMONIC_FIELD.detuneCents.stable / 1200),
      6,
    );
    expect(handover.gain.gain.ramps).toEqual([
      { to: 0.7, dur: RAMP_TIMES.fieldVoice.seconds, start: 5 },
    ]);

    const retune = fakeSlot();
    rampFieldSlot(
      retune as never,
      { midi: 62, gain: gainMove, moves: 0, handover: false, retune: true },
      5,
    );
    expect(retune.banks[0]?.voices[0]?.frequency.setValues).toHaveLength(1);
    expect(retune.banks[0]?.voices[0]?.frequency.setValues[0]?.t).toBe(5);
    expect(retune.banks[0]?.gains[0]?.gain.ramps).toEqual([]);
    expect(retune.banks[1]?.voices[0]?.frequency.setValues).toEqual([]);

    const hold = fakeSlot();
    rampFieldSlot(
      hold as never,
      { midi: 62, gain: gainMove, moves: 0, handover: false, retune: false },
      5,
    );
    for (const bank of hold.banks) {
      for (const voice of bank.voices) expect(voice.frequency.setValues).toEqual([]);
    }
    expect(hold.gain.gain.ramps).toHaveLength(1);
  });
});

describe("harmonic field seat", () => {
  it("thins the seat with Calm and near-silence through the planned field gain", () => {
    const loud = planGraph(render([lane()], 0)).macroFieldGain.target;
    const calm = planGraph(render([lane()], 0.6)).macroFieldGain.target;
    const hush = planGraph(render([{ ...lane(), struggle: 0.05 }], 0.9)).macroFieldGain.target;
    expect(calm).toBeLessThan(loud);
    expect(hush).toBeLessThan(calm * 0.2);
  });

  it("keeps the chord identical whatever the lanes do, at a fixed clock", () => {
    const quiet = renderWithMacro([lane()], 0.6, {
      nowSeconds: 700,
      seed: 161,
      presence: 0.2,
      calm: 0.6,
      applyWorld: true,
    });
    const busy = renderWithMacro([lane(0), { ...lane(1), activity: 1, struggle: 1 }], 0.6, {
      nowSeconds: 700,
      seed: 161,
      presence: 1,
      calm: 0.6,
      applyWorld: true,
    });
    expect(planGraph(busy).fieldVoices.map((v) => v.midi)).toEqual(
      planGraph(quiet).fieldVoices.map((v) => v.midi),
    );
  });
});
