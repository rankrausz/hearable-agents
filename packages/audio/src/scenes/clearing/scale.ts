// packages/audio/src/scenes/clearing/scale.ts — D pentatonic quantization.
// What this is for: mapping any MIDI note to the nearest member of the
// scene's pentatonic set (and naming lane registers), so every pitched
// element stays in key no matter which lane or progress state selects it.
// What it must not do: sound anything, keep state, or range-check registers
// — callers clamp to their register before quantizing.

import { LANE_REGISTERS, type LaneRegisterName, PENTATONIC_OFFSETS } from "./tuning.js";

/** Anchor pitch class of the scene key (D) as a MIDI pitch class. */
const KEY_PITCH_CLASS = 2;

/**
 * Quantizes a MIDI note to the nearest D pentatonic member. Ties resolve
 * downward so the choice is deterministic. The set spans all octaves, so
 * the result stays within ±4 semitones of the input.
 */
export function quantizeToPentatonic(midi: number): number {
  const pitchClass = (((Math.round(midi) - KEY_PITCH_CLASS) % 12) + 12) % 12;
  let best: (typeof PENTATONIC_OFFSETS)[number] = PENTATONIC_OFFSETS[0] ?? 0;
  let bestDistance = 12;
  for (const offset of PENTATONIC_OFFSETS) {
    const distance = Math.abs(offset - pitchClass);
    if (distance < bestDistance) {
      best = offset;
      bestDistance = distance;
    }
  }
  return Math.round(midi) - pitchClass + best;
}

/** MIDI bounds of a lane register. */
export function registerRange(register: LaneRegisterName): { root: number; top: number } {
  const range = LANE_REGISTERS[register];
  return { root: range.root, top: range.top };
}

/**
 * Clamps a MIDI note into a lane register and quantizes it to the
 * pentatonic set. Upper-half selection (progress > 0.6) picks from the top
 * half of the clamped span before quantizing.
 */
export function noteInRegister(
  midi: number,
  register: LaneRegisterName,
  upperHalf: boolean,
): number {
  const { root, top } = registerRange(register);
  const clamped = Math.min(top, Math.max(root, Math.round(midi)));
  const picked = upperHalf ? root + (top - root) / 2 + (clamped - root) / 2 : clamped;
  return quantizeToPentatonic(picked);
}
