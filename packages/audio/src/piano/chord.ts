// Plans softly rolled piano voicings from the current chord; never schedules audio or invents state.
import { FIELD_CHORDS, type FieldChordName, fieldChordTones } from "@hearable/core";

export type CueHarmony = { readonly chord: string; readonly tonic: number; readonly bass: number };
export type PianoCue = "arrive" | "question" | "resolve" | "attention" | "overflow";
export const PIANO_CUE_END_S = {
  arrive: 4.2,
  question: 4.8,
  resolve: 6,
  attention: 3.4,
  overflow: 2.75,
} as const;
export const DEFAULT_CUE_HARMONY: CueHarmony = { chord: "Imaj9", tonic: 0, bass: 0 };

/** Four or five distinct chord tones, open-spaced in the piano's warm middle register. */
export function pianoChord(
  cue: PianoCue,
  laneIndex: number,
  harmony = DEFAULT_CUE_HARMONY,
): readonly number[] {
  const chord = Object.hasOwn(FIELD_CHORDS, harmony.chord)
    ? (harmony.chord as FieldChordName)
    : "Imaj9";
  const tones = [...new Set(fieldChordTones(chord, harmony.tonic))];
  const bass = (((harmony.bass + 2) % 12) + 12) % 12;
  // The common piano replaces lane timbres; pan and slightly different registers retain identity.
  const floor = [48, 45, 55, 59][laneIndex] ?? 50;
  const first = floor + ((bass - (floor % 12) + 12) % 12);
  const count = cue === "attention" || cue === "overflow" ? 4 : 5;
  const selected = [first];
  // Root/guide tones first, then the chord's own extensions (including borrowed and suspended colours).
  for (const tone of tones) {
    const pc = (tone + 2) % 12;
    if (pc === bass) continue;
    let note = first + ((pc - (first % 12) + 12) % 12);
    while (note < first + 3 || selected.includes(note)) note += 12;
    if (note <= 84) selected.push(note);
    if (selected.length === count) break;
  }
  // A sus triad stays a sus chord: fill the open voicing with an octave, never an invented third.
  for (const note of [...selected]) {
    if (selected.length >= count) break;
    if (note + 12 <= 84 && !selected.includes(note + 12)) selected.push(note + 12);
  }
  selected.sort((a, b) => a - b);
  return cue === "resolve" ? selected.reverse() : selected;
}

/** Unequal spacing and touch preserve a gentle hand-rolled attack without random timing. */
export function pianoRoll(cue: PianoCue, laneIndex: number, harmony = DEFAULT_CUE_HARMONY) {
  const pitches = pianoChord(cue, laneIndex, harmony);
  const spacing =
    cue === "question" ? 0.13 : cue === "attention" ? 0.075 : cue === "overflow" ? 0.09 : 0.1;
  const touch = [0.84, 0.72, 0.79, 0.69, 0.76];
  return pitches.map((midi, index) => ({
    midi,
    startS: index * spacing + (index % 2) * 0.012,
    touch: touch[index] ?? 0.75,
  }));
}
