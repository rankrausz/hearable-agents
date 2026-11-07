// packages/audio/test/tonal-journey.test.ts — Node proofs for the moving
// tonal centre in audio (owner direction 2026-10-29): the plan hands the
// drone between its banks only when the centre moves, the handover retunes
// only the silent bank and never bends a pitch, the floor stays under its
// low-pass, and every gesture note lands inside its seat in every key with
// the home key unchanged.

import type { SceneParams } from "@hearable/core";
import { renderWithMacro } from "@hearable/core";
import { describe, expect, it } from "vitest";
import { CROSSFADE_MID_GAIN, crossfadeDrone, droneShiftSemitones } from "../src/apply.js";
import { noteAboveD, noteAboveTonic, tonicShiftInRegister } from "../src/gestures/notes.js";
import { midiToFrequency, planGraph } from "../src/graph/index.js";
import { RAMP_TIMES } from "../src/ramps.js";
import { DRONE_VOICE, LANE_REGISTERS } from "../src/scenes/clearing/index.js";

type Ramp = { to: number; dur: number; start: number };

function fakeParam() {
  const ramps: Ramp[] = [];
  const setValues: { value: number; t: number }[] = [];
  return {
    ramps,
    setValues,
    linearRampTo: (to: number, dur: number, start: number) => {
      ramps.push({ to, dur, start });
    },
    setValueAtTime: (value: number, t: number) => {
      setValues.push({ value, t });
    },
  };
}

function fakeBank() {
  return {
    voices: DRONE_VOICE.oscillators.map(() => ({ frequency: fakeParam() })),
    gains: DRONE_VOICE.oscillators.map(() => ({ gain: fakeParam() })),
    midi: DRONE_VOICE.oscillators.map((osc) => osc.midi),
  };
}

function withBass(bass: number): SceneParams {
  const scene = renderWithMacro([], 0, { nowSeconds: 0, seed: 161, presence: 0, calm: 0 });
  return { ...scene, macro: { ...scene.macro, bass } };
}

describe("drone follows the chord bass", () => {
  it("hands the drone over only when the chord bass moves, counting the moves", () => {
    const first = planGraph(withBass(0));
    expect(first.drone).toEqual({ pitchClass: 0, moves: 0, handover: false });
    const held = planGraph(withBass(0), first);
    expect(held.drone.handover).toBe(false);
    const moved = planGraph(withBass(5), { ...held, drone: { ...held.drone, handover: false } });
    expect(moved.drone).toEqual({ pitchClass: 5, moves: 1, handover: true });
    const back = planGraph(withBass(0), { ...moved, drone: { ...moved.drone, handover: false } });
    expect(back.drone).toEqual({ pitchClass: 0, moves: 2, handover: true });
  });

  it("keeps the floor between A1 and G#2 for every centre", () => {
    for (let tonic = 0; tonic < 12; tonic += 1) {
      const shift = droneShiftSemitones(tonic);
      expect(shift).toBeGreaterThanOrEqual(-5);
      expect(shift).toBeLessThanOrEqual(6);
      expect((((shift - tonic) % 12) + 12) % 12).toBe(0);
    }
  });

  it("retunes only the silent bank and crossfades over the drone class", () => {
    const banks = [fakeBank(), fakeBank()];
    crossfadeDrone({ bed: { banks } } as never, 7, 30, 0);
    const [outgoing, incoming] = banks;
    for (const voice of outgoing?.voices ?? []) expect(voice.frequency.setValues).toEqual([]);
    incoming?.voices.forEach((voice, index) => {
      const osc = DRONE_VOICE.oscillators[index];
      expect(voice.frequency.setValues).toEqual([
        {
          value: midiToFrequency((osc?.midi ?? 0) - 5) * 2 ** ((osc?.detuneCents ?? 0) / 1200),
          t: 30,
        },
      ]);
    });
    const half = RAMP_TIMES.droneCrossfade.seconds / 2;
    for (const gain of outgoing?.gains ?? []) {
      expect(gain.gain.ramps).toEqual([
        { to: CROSSFADE_MID_GAIN, dur: half, start: 30 },
        { to: 0, dur: half, start: 30 + half },
      ]);
    }
    for (const gain of incoming?.gains ?? []) {
      expect(gain.gain.ramps).toEqual([
        { to: CROSSFADE_MID_GAIN, dur: half, start: 30 },
        { to: 1, dur: half, start: 30 + half },
      ]);
    }
  });
});

describe("gestures follow the tonal centre", () => {
  const registers = Object.keys(LANE_REGISTERS) as (keyof typeof LANE_REGISTERS)[];

  it("leaves every gesture note of the home key exactly where it was", () => {
    for (const register of registers) {
      expect(tonicShiftInRegister(register, 0)).toBe(0);
      for (const semitones of [0, 3, 4, 5, 7]) {
        expect(noteAboveTonic(register, semitones, 0)).toBe(noteAboveD(register, semitones));
      }
    }
  });

  it("puts every gesture note inside its seat, on the right pitch class, in every key", () => {
    for (const register of registers) {
      const { root, top } = LANE_REGISTERS[register];
      for (let tonic = 0; tonic < 12; tonic += 1) {
        for (const semitones of [0, 3, 4, 5, 7]) {
          const midi = noteAboveTonic(register, semitones, tonic);
          expect(midi).toBeGreaterThanOrEqual(root);
          expect(midi).toBeLessThanOrEqual(top);
          expect((((midi - 2 - tonic - semitones) % 12) + 12) % 12).toBe(0);
        }
      }
    }
  });

  it("keeps the rising tonic-to-fifth contour wherever the seat is wide enough", () => {
    for (const register of ["low", "high"] as const) {
      for (let tonic = 0; tonic < 12; tonic += 1) {
        const tonicNote = noteAboveTonic(register, 0, tonic);
        expect(noteAboveTonic(register, 7, tonic) - tonicNote).toBe(7);
        expect(noteAboveTonic(register, 5, tonic) - tonicNote).toBe(5);
      }
    }
  });
});
