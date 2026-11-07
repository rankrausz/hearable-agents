// packages/audio/src/scenes/clearing/voices.ts — per-register voice
// recipes for the Clearing scene. What this is for: declaring, as plain
// data, which oscillator stack each lane register gets (pad, mallet,
// flute) and the drone pair, with the harmonic-content invariant from
// docs/SOUND_DESIGN.md fatigue rule 3 attached: every pitched voice carries
// at least two partials or a detuned copy, never a pure sine. Lane C's
// legacy FM bell recipe stays exported for reference; construction reads
// FLUTE_VOICE (p3-t13). What it must not do: import Tone or create
// nodes — apply.ts reads these recipes and builds the graph, so tests can
// prove the invariant without audio.

import {
  BELL_FM,
  DRONE_CUTOFF_HZ,
  DRONE_DETUNE_CENTS,
  DRONE_MIDI,
  FLUTE_RECIPE,
  GLASS_RECIPE,
} from "./tuning.js";

/** FM pair for a carrier: modulator ratio and depth. */
export type VoiceFm = {
  /** Modulator-to-carrier frequency ratio. */
  readonly harmonicity: number;
  /** Modulation depth; low values stay glassy, high values turn brassy. */
  readonly modulationIndex: number;
};

/** One oscillator in a voice recipe. */
export type VoiceOscillator = {
  /** Tone oscillator type; partial-count types ("...4", "...8" etc.) excluded. */
  readonly type: "sawtooth" | "sine" | "triangle";
  /** MIDI note the oscillator starts on. */
  readonly midi: number;
  /** Static detune offset in cents. */
  readonly detuneCents: number;
  /** When present, build this voice as FM with this modulator. */
  readonly fm?: VoiceFm;
};

/** Display name matching docs/SOUND_DESIGN.md §Scene Clearing. */
export type VoiceName = "drone" | "pad" | "mallet" | "bell" | "flute" | "glass";

/** A pitched voice: its oscillators plus how they are filtered. */
export type VoiceRecipe = {
  /** Display name matching docs/SOUND_DESIGN.md §Scene Clearing. */
  readonly name: VoiceName;
  /** Every pitched voice has ≥ 2 partials or a detuned copy. */
  readonly oscillators: readonly VoiceOscillator[];
  /** Low-pass cutoff in Hz applied to the stacked voice. */
  readonly lowpassHz: number;
};

/**
 * D2+D3 detuned drone, low-passed at ~400 Hz: the floor of the mix. Sine
 * pair below, triangle pair above (owner listen 2026-09-30: four saws under
 * a sustained chord read as bagpipes; the drone should be felt more than
 * heard).
 */
export const DRONE_VOICE: VoiceRecipe = {
  name: "drone",
  oscillators: [
    { type: "sine", midi: DRONE_MIDI.low, detuneCents: -DRONE_DETUNE_CENTS },
    { type: "sine", midi: DRONE_MIDI.low, detuneCents: DRONE_DETUNE_CENTS },
    { type: "triangle", midi: DRONE_MIDI.high, detuneCents: -DRONE_DETUNE_CENTS },
    { type: "triangle", midi: DRONE_MIDI.high, detuneCents: DRONE_DETUNE_CENTS },
  ],
  lowpassHz: DRONE_CUTOFF_HZ,
};

/** Lane A (low): soft pad, a filtered saw pair with opposite detune. */
export const PAD_VOICE: VoiceRecipe = {
  name: "pad",
  oscillators: [
    { type: "sawtooth", midi: 40, detuneCents: -6 },
    { type: "sawtooth", midi: 40, detuneCents: 6 },
  ],
  lowpassHz: 900,
};

/**
 * Lane B (mid): plucked/mallet, a short sine+triangle pair with fast decay.
 * The triangle carries the upper partials the sine alone would lack.
 * The p3-t13 pulse-layer voice reads this recipe an octave down
 * (builder.ts), so the pulse swells the same timbre, not a new one.
 */
export const MALLET_VOICE: VoiceRecipe = {
  name: "mallet",
  oscillators: [
    { type: "sine", midi: 69, detuneCents: 0 },
    { type: "triangle", midi: 69, detuneCents: 4 },
  ],
  // 3200 → 2400 Hz (owner listen 2026-09-30): rounder mallet.
  lowpassHz: 2400,
};

/**
 * Lane C (high): soft flute (p3-t13 replaces the glass FM bell) — a
 * breathy sine/triangle pair with a hair of opposite detune plus filtered noise breath per
 * note (FLUTE_RECIPE: breath share 0.12, legato attack 0.35 s, low-pass
 * 2800 Hz). Two partial shapes with detune spread, so the harmonic-content
 * invariant holds without FM sidebands.
 */
export const FLUTE_VOICE: VoiceRecipe = {
  name: "flute",
  oscillators: [
    // ±5 → ±0.6 c (owner listen 2026-10-29: "vibrating mid-high pitches"):
    // at A5 a 10 c spread beat at about 5 Hz, a tremolo; 1.2 c beats at
    // about 0.6 Hz, a slow shimmer. The sine/triangle pair keeps the
    // harmonic-content rule.
    { type: "sine", midi: 81, detuneCents: -0.6 },
    { type: "triangle", midi: 81, detuneCents: 0.6 },
  ],
  lowpassHz: FLUTE_RECIPE.lowpassHz,
};

/**
 * Upper seat (p7b-t03, the fourth seat): soft struck glass at D5 — a sine
 * fundamental plus a sine octave partial, low-passed under the flute. The
 * octave partial gives the only even-harmonic spectrum among the seats
 * (pad saws aside, which sit two octaves lower), so it separates from the
 * flute it shares a register with by timbre when the image is mono. No
 * FM and no breath: dark by construction (GLASS_RECIPE). The partial is
 * part of the timbre, not a note, so it may sit above the seat's A5 top;
 * gestures voice both oscillators at the gesture pitch (a detuned pair)
 * with the short struck attack.
 */
export const GLASS_VOICE: VoiceRecipe = {
  name: "glass",
  oscillators: [
    { type: "sine", midi: GLASS_RECIPE.constructionMidi, detuneCents: 0 },
    {
      type: "sine",
      midi: GLASS_RECIPE.constructionMidi + GLASS_RECIPE.partialSemitones,
      detuneCents: GLASS_RECIPE.partialDetuneCents,
    },
  ],
  lowpassHz: GLASS_RECIPE.lowpassHz,
};

/**
 * Lane C (high) legacy glass/bell, retired by p3-t13 in favour of
 * FLUTE_VOICE. Kept exported for reference: gesture/builder code reads
 * FLUTE_VOICE instead. The recipe declares the FM pair as data: a
 * carrier plus its modulator (harmonicity ratio, low index), so
 * construction builds one FMOscillator with the modulator connected,
 * never two independent sines.
 */
export const BELL_VOICE: VoiceRecipe = {
  name: "bell",
  oscillators: [
    { type: "sine", midi: 88, detuneCents: -5 },
    { type: "sine", midi: 88, detuneCents: 5, fm: BELL_FM },
  ],
  lowpassHz: 6000,
};

/**
 * Returns true when a recipe satisfies fatigue rule 3: at least two
 * oscillators, and either more than one partial shape, an FM pair (a
 * modulator always adds sidebands), or a detuned copy (any nonzero detune
 * spread).
 */
export function hasHarmonicContent(recipe: VoiceRecipe): boolean {
  if (recipe.oscillators.length < 2) return false;
  if (recipe.oscillators.some((osc) => osc.fm !== undefined)) return true;
  const types = new Set(recipe.oscillators.map((osc) => osc.type));
  if (types.size > 1) return true;
  const detunes = recipe.oscillators.map((osc) => osc.detuneCents);
  return Math.max(...detunes) - Math.min(...detunes) > 0;
}
