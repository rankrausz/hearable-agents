// packages/audio/src/gestures/notes.ts - in-register gesture note pitches.
// What this is for: turning the gesture shapes (arrive's tonic->fifth,
// question's suspended fourth, resolve's descending line) into concrete
// MIDI notes inside the lane's register, heard from the scene's current
// tonal centre (owner direction 2026-10-29), so *which lane* stays part of
// the gesture and the gesture stays in the key the scene is in. What it must not do:
// sound anything, keep state, or leave the lane's register - every helper
// returns a pitch inside the register's documented bounds.

import type { LaneRegisterName } from "../scenes/clearing/index.js";

import { LANE_REGISTERS } from "../scenes/clearing/index.js";

/** The D in a lane's register:the lowest D octave at or above the register root. */

export function dInRegister(register: LaneRegisterName): number {
  // D octaves: D1 = 26, D2 = 38, D3 = 50, D4 = 62, D5 = 74

  const root = LANE_REGISTERS[register].root;

  for (let midi = 26; midi <= 96; midi += 12) {
    if (midi >= root) return midi;
  }

  return root;
}

/**

 *  A pitch a whole/third/fourth above the register's D: `arrive`'s A (a

 *  5th), `resolve`'s F# (a 3rd)and `question`'s suspended G (a

 *  4th - deliberately outside the pentatonic, the unresolved 4th the

 *  sound design doc describes). Every result stays inside the register.

 */

export function noteAboveD(register: LaneRegisterName, semitones: number): number {
  return dInRegister(register) + semitones;
}

/**
 * How far a gesture shape moves for a tonal centre (semitones above D):
 * the transposition nearest zero that keeps the whole tonic-to-fifth span
 * inside the register, so the contour survives the key change. A seat too
 * narrow for that key takes the nearest transposition, and noteAboveTonic
 * folds the note that would leave the register by an octave.
 */
export function tonicShiftInRegister(register: LaneRegisterName, tonic: number): number {
  const { root, top } = LANE_REGISTERS[register];
  const d = dInRegister(register);
  const pc = ((tonic % 12) + 12) % 12;
  const options = [pc, pc - 12, pc + 12, pc - 24].sort((a, b) => Math.abs(a) - Math.abs(b));
  return (
    options.find((shift) => d + shift >= root && d + shift + 7 <= top) ?? (pc <= 6 ? pc : pc - 12)
  );
}

/** A pitch `semitones` above the tonal centre in a lane's register, always inside it. */
export function noteAboveTonic(register: LaneRegisterName, semitones: number, tonic = 0): number {
  const { root, top } = LANE_REGISTERS[register];
  let midi = dInRegister(register) + tonicShiftInRegister(register, tonic) + semitones;
  while (midi > top) midi -= 12;
  while (midi < root) midi += 12;
  return midi;
}
