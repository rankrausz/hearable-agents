// packages/core/src/scene/field.ts — the pure harmonic field: Clearing's
// continuously evolving chord, planned on the macro epoch schedule. What
// this is for: one harmonic organism made of a few sustained voices
// (ADR 0025, ADR 0027, owner Collier direction 2026-09-16, owner listens
// 2026-09-30 and 2026-10-29: "richer … some G, B, moving the bass note
// sometimes, some sus4, some maj7 and many many more"). Each epoch has a
// tonal centre that journeys through related keys and an energy level
// that sets how many voices sound. Inside the epoch a chord progression
// walks a Collier-flavoured graph — maj9 and 6/9 tonics, lydian IV, the
// "amen" minor iv, 9sus4 dominants that never cadence hard, sus4 chords
// that resolve by a semitone into their third, borrowed bVI/bVII/bIII,
// pedal chords over the tonic and inversions that walk the bass — one
// chord every 15–40 s. Voices reach each chord one at a time: a common
// tone holds, the rest move to the nearest new chord tone (a semitone is
// the smoothest step there is), so harmony morphs rather than switches.
// Sparse "bloom" notes on chord tones ride the same clock. What it must
// not do: I/O, Date.now(), Math.random(), node:* or workspace imports, or
// read any lane or agent field.

import type { Rng } from "../rng.js";
import { MACRO_FIRST_AT_SECONDS, macroEpochDraw, macroEpochLength } from "./macro.js";

/** What a slot contributes to the field's vertical shape. */
export type FieldRole = "ground" | "colour" | "extension" | "shimmer";

/** One voice slot: its role, register window (MIDI, inclusive) and base level. */
export type FieldSlot = {
  readonly role: FieldRole;
  readonly low: number;
  readonly high: number;
  /** Base level 0..1 before the per-epoch emphasis draw. */
  readonly weight: number;
};

/**
 * The six voice slots, low to high. The ground carries the chord's bass
 * (root, an inversion's third, or a pedal), the colour slots the guide
 * tones, the extension and shimmer slots the ninths, elevenths and
 * thirteenths. Windows overlap the lane seats on purpose — a soloist
 * sits inside the chord and is told apart by timbre, level and motion.
 * Extension 0.45 and shimmer 0.28 since 2026-10-29 (the top of the chord
 * was the part that made the owner reach for the volume).
 */
export const FIELD_SLOTS: readonly FieldSlot[] = [
  { role: "ground", low: 43, high: 57, weight: 0.9 },
  { role: "colour", low: 57, high: 66, weight: 0.8 },
  { role: "colour", low: 62, high: 71, weight: 0.8 },
  { role: "colour", low: 66, high: 76, weight: 0.7 },
  { role: "extension", low: 71, high: 81, weight: 0.45 },
  { role: "shimmer", low: 76, high: 86, weight: 0.28 },
];

/** Slot index order in which voices join as energy rises (and leave as it falls). */
export const FIELD_ACTIVATION_ORDER: readonly number[] = [0, 2, 1, 3, 4, 5];

/** Energy range: 1 is a sparse three-voice chord, 5 the full six. */
export const FIELD_ENERGY_MIN = 1;
export const FIELD_ENERGY_MAX = 5;

/**
 * Sounding voice count per energy level (index energy − 1). Five at most
 * (owner listen 2026-10-29: "many notes close together"): a clear chord
 * beats a full one; the shimmer slot is left for the lanes.
 */
export const FIELD_VOICES_AT_ENERGY: readonly number[] = [3, 4, 4, 5, 5];

/** Energy the field starts at (epoch 0). */
export const FIELD_ENERGY_START = 2;

/** Per-epoch emphasis range multiplying a slot's base level (dynamics as harmony). */
export const FIELD_EMPHASIS_MIN = 0.6;
export const FIELD_EMPHASIS_MAX = 1.0;

/**
 * Chord qualities: the tones above the chord root in voicing priority
 * order (the root itself is always a chord tone and comes first). With
 * three voices a maj7 is root, third and seventh; more voices add the
 * fifth and the colours. Guide tones lead, so even a sparse chord says
 * what it is.
 */
export const FIELD_QUALITIES = {
  maj7: [4, 11, 7, 2],
  maj9: [4, 11, 2, 7, 9],
  "6/9": [4, 9, 2, 7],
  "maj7#11": [4, 11, 6, 7, 2],
  add9: [2, 4, 7, 11],
  sus2: [2, 7, 9, 11],
  sus4: [5, 7, 2, 10],
  "9sus4": [5, 10, 2, 7, 9],
  min7: [3, 10, 7, 2],
  min9: [3, 10, 2, 7, 5],
  min11: [3, 10, 5, 2, 7],
  "min6/9": [3, 9, 2, 7],
  dom9: [4, 10, 2, 7, 9],
} as const satisfies Record<string, readonly number[]>;

export type FieldQuality = keyof typeof FIELD_QUALITIES;

/** One chord of the progression graph, relative to the tonal centre. */
export type FieldChordSpec = {
  /** Chord root, semitones above the centre. */
  readonly root: number;
  readonly quality: FieldQuality;
  /** Bass, semitones above the centre: the root, an inversion or a pedal. */
  readonly bass: number;
};

/**
 * The chord vocabulary in a key, by name. Roman numerals are relative to
 * the tonal centre; a slash is a bass other than the root.
 */
export const FIELD_CHORDS = {
  Imaj9: { root: 0, quality: "maj9", bass: 0 },
  "I6/9": { root: 0, quality: "6/9", bass: 0 },
  Isus4: { root: 0, quality: "sus4", bass: 0 },
  Isus2: { root: 0, quality: "sus2", bass: 0 },
  "Imaj7/3": { root: 0, quality: "maj7", bass: 4 },
  "Iadd9/5": { root: 0, quality: "add9", bass: 7 },
  ii9: { root: 2, quality: "min9", bass: 2 },
  "ii11/I": { root: 2, quality: "min11", bass: 0 },
  iii7: { root: 4, quality: "min7", bass: 4 },
  "IVmaj7#11": { root: 5, quality: "maj7#11", bass: 5 },
  "IVmaj9/I": { root: 5, quality: "maj9", bass: 0 },
  "iv6/9": { root: 5, quality: "min6/9", bass: 5 },
  V9sus4: { root: 7, quality: "9sus4", bass: 7 },
  "V9sus4/IV": { root: 7, quality: "9sus4", bass: 5 },
  vi9: { root: 9, quality: "min9", bass: 9 },
  vi11: { root: 9, quality: "min11", bass: 9 },
  bIIImaj7: { root: 3, quality: "maj7", bass: 3 },
  bVImaj7: { root: 8, quality: "maj7", bass: 8 },
  "bVII6/9": { root: 10, quality: "6/9", bass: 10 },
  bVII9: { root: 10, quality: "dom9", bass: 10 },
} as const satisfies Record<string, FieldChordSpec>;

export type FieldChordName = keyof typeof FIELD_CHORDS;

/**
 * Where each chord may go next, with weights: plagal motion (IV → I, the
 * "amen" iv → I), sus4 chords that resolve into their third, 9sus4
 * dominants that land softly or deceptively, borrowed chords from the
 * parallel minor (bVI, bVII, bIII), pedals over the tonic and an
 * inversion that walks the bass up by step. No hard V7 → I cadence: the
 * colour stays open, the motion is in the voices.
 */
export const FIELD_PROGRESSIONS: Readonly<
  Record<FieldChordName, readonly (readonly [FieldChordName, number])[]>
> = {
  Imaj9: [
    ["IVmaj7#11", 0.18],
    ["vi9", 0.14],
    ["IVmaj9/I", 0.12],
    ["Imaj7/3", 0.1],
    ["ii9", 0.08],
    ["bVII6/9", 0.08],
    ["Isus4", 0.08],
    ["iii7", 0.06],
    ["bVImaj7", 0.06],
    ["V9sus4/IV", 0.05],
    ["bIIImaj7", 0.05],
  ],
  "I6/9": [
    ["IVmaj7#11", 0.2],
    ["vi11", 0.15],
    ["ii11/I", 0.15],
    ["Imaj7/3", 0.1],
    ["bVII9", 0.1],
    ["Isus2", 0.1],
    ["bVImaj7", 0.1],
    ["iii7", 0.1],
  ],
  Isus4: [
    ["Imaj9", 0.6],
    ["I6/9", 0.4],
  ],
  Isus2: [
    ["Imaj9", 0.4],
    ["IVmaj9/I", 0.3],
    ["vi9", 0.3],
  ],
  "Imaj7/3": [
    ["IVmaj7#11", 0.55],
    ["ii9", 0.25],
    ["iv6/9", 0.2],
  ],
  "Iadd9/5": [
    ["V9sus4", 0.5],
    ["IVmaj9/I", 0.25],
    ["Isus4", 0.25],
  ],
  ii9: [
    ["V9sus4", 0.4],
    ["Imaj7/3", 0.2],
    ["IVmaj7#11", 0.2],
    ["ii11/I", 0.2],
  ],
  "ii11/I": [
    ["Imaj9", 0.5],
    ["I6/9", 0.3],
    ["IVmaj9/I", 0.2],
  ],
  iii7: [
    ["vi9", 0.5],
    ["IVmaj7#11", 0.5],
  ],
  "IVmaj7#11": [
    ["Imaj9", 0.25],
    ["iv6/9", 0.25],
    ["V9sus4", 0.12],
    ["Iadd9/5", 0.1],
    ["vi11", 0.1],
    ["ii9", 0.08],
    ["I6/9", 0.1],
  ],
  "IVmaj9/I": [
    ["Imaj9", 0.5],
    ["iv6/9", 0.3],
    ["Isus2", 0.2],
  ],
  "iv6/9": [
    ["Imaj9", 0.5],
    ["I6/9", 0.3],
    ["bVImaj7", 0.2],
  ],
  V9sus4: [
    ["Imaj9", 0.35],
    ["vi9", 0.2],
    ["I6/9", 0.15],
    ["bVImaj7", 0.15],
    ["Isus4", 0.15],
  ],
  "V9sus4/IV": [
    ["Imaj7/3", 0.5],
    ["IVmaj7#11", 0.5],
  ],
  vi9: [
    ["IVmaj7#11", 0.3],
    ["ii9", 0.25],
    ["V9sus4", 0.2],
    ["iii7", 0.1],
    ["bVImaj7", 0.15],
  ],
  vi11: [
    ["IVmaj9/I", 0.4],
    ["ii11/I", 0.3],
    ["V9sus4/IV", 0.3],
  ],
  bIIImaj7: [
    ["IVmaj7#11", 0.5],
    ["bVImaj7", 0.3],
    ["iv6/9", 0.2],
  ],
  bVImaj7: [
    ["bVII6/9", 0.45],
    ["iv6/9", 0.25],
    ["Imaj9", 0.3],
  ],
  "bVII6/9": [
    ["Imaj9", 0.55],
    ["IVmaj7#11", 0.25],
    ["I6/9", 0.2],
  ],
  bVII9: [
    ["Imaj9", 0.5],
    ["I6/9", 0.3],
    ["IVmaj9/I", 0.2],
  ],
};

/** How long one chord holds, seconds; busier energies move faster. */
export const FIELD_CHORD_MIN_S = 25;
export const FIELD_CHORD_MAX_S = 50;
export const FIELD_CHORD_ENERGY_SLOPE_S = 3;

/**
 * Voice events (owner listen 2026-10-29: clear, not messy): while a chord
 * is arriving one voice moves every 3–5 s, so the new harmony is there
 * within a few breaths; once it has arrived the chord holds, with a
 * rare recolour every 12–22 s.
 */
export const FIELD_EVENT_GAP_MIN_S = 3;
export const FIELD_EVENT_GAP_MAX_S = 5;
export const FIELD_HOLD_GAP_MIN_S = 12;
export const FIELD_HOLD_GAP_MAX_S = 22;

/**
 * Minimum distance between two sounding voices, in semitones, by the
 * lower note's register: an open fifth down in the bass, a major third
 * through the tenor, a minor third above middle C. No seconds, no
 * clusters: the chord's colour comes from which tones sound, its clarity
 * from how far apart they stand.
 */
export function fieldMinSpacing(lowerMidi: number): number {
  if (lowerMidi < 52) return 7;
  if (lowerMidi < 60) return 4;
  return 3;
}

/** Widest step a voice takes to reach a new chord tone, in semitones. */
export const FIELD_STEP_MAX = 4;

/** Share of events on an arrived chord that simply rest instead of recolouring. */
export const FIELD_REST_SHARE = 0.6;

/** Bloom notes: sparse, 30–75 s apart, on a sounding root or guide tone in C5–C6. */
export const FIELD_PING_GAP_MIN_S = 30;
export const FIELD_PING_GAP_MAX_S = 75;
export const FIELD_PING_LOW = 72;
export const FIELD_PING_HIGH = 84;
/** How far ahead of the clock blooms are announced, in seconds. */
export const FIELD_PING_LOOKAHEAD_S = 3;
export const FIELD_PING_LEVEL_MIN = 0.5;
export const FIELD_PING_LEVEL_MAX = 1.0;

/**
 * The tonal journey (owner direction 2026-10-29): every epoch has a tonal
 * centre, and at an epoch boundary the centre may move to a related key —
 * down or up a fifth, to a relative or chromatic mediant, or by a whole
 * tone. A new centre opens on its own tonic chord, reached voice by voice
 * like any other chord. Moves as semitones above the current centre, and
 * their weights.
 */
export const FIELD_KEY_MOVES: readonly number[] = [5, 7, 9, 3, 4, 8, 2, 10];
export const FIELD_KEY_MOVE_WEIGHTS: readonly number[] = [
  0.2, 0.18, 0.14, 0.12, 0.1, 0.1, 0.08, 0.08,
];
/** Probability an epoch after the first moves the tonal centre. */
export const FIELD_KEY_CHANGE = 0.4;
/** A centre away from home returns to D with this extra probability per epoch. */
export const FIELD_KEY_HOME_PULL = 0.15;

/** D pitch class in MIDI. */
const D_MIDI_CLASS = 2;

/** Semitones above D for a MIDI note. */
export function fieldPitchClass(midi: number): number {
  return (((midi - D_MIDI_CLASS) % 12) + 12) % 12;
}

/** The chord's tones as pitch classes above D, root first then by priority. */
export function fieldChordTones(chord: FieldChordName, tonic: number): readonly number[] {
  const spec: FieldChordSpec = FIELD_CHORDS[chord];
  const root = (tonic + spec.root) % 12;
  return [root, ...FIELD_QUALITIES[spec.quality].map((interval) => (root + interval) % 12)];
}

/** The chord's bass as a pitch class above D. */
export function fieldChordBass(chord: FieldChordName, tonic: number): number {
  return (tonic + FIELD_CHORDS[chord].bass) % 12;
}

/** One voice slot's planned state. */
export type FieldVoice = {
  /** MIDI pitch, or null while the slot is silent. */
  readonly midi: number | null;
  /** Target level 0..1 (0 while silent). */
  readonly level: number;
};

/** One bloom note announced ahead of the clock. */
export type FieldPing = {
  /** Monotonic id, so audio schedules each bloom once across applies. */
  readonly id: number;
  /** Seconds from the queried clock until the bloom starts (0..lookahead). */
  readonly inS: number;
  readonly midi: number;
  /** Level 0..1. */
  readonly level: number;
};

/** The field at one instant. */
export type FieldState = {
  /** Which macro epoch the instant falls in. */
  readonly epochIndex: number;
  /** Energy level of that epoch, 1..5. */
  readonly energy: number;
  /** Tonal centre of that epoch, semitones above D. */
  readonly tonic: number;
  /** The chord being reached for, by name (relative to the centre). */
  readonly chord: FieldChordName;
  /** That chord's root, semitones above D. */
  readonly root: number;
  /** That chord's bass, semitones above D. */
  readonly bass: number;
  /** Whether that chord's third is minor (reported to gestures as the world). */
  readonly minor: boolean;
  /** Per-slot voice states, index-aligned with FIELD_SLOTS. */
  readonly voices: readonly FieldVoice[];
  /** Blooms starting within the lookahead window. */
  readonly pings: readonly FieldPing[];
};

/** A voice snapshot that takes effect at `atS` (absolute seconds). */
type FieldEvent = {
  readonly atS: number;
  readonly chord: FieldChordName;
  readonly voices: readonly FieldVoice[];
};

type PlannedPing = {
  readonly id: number;
  readonly atS: number;
  readonly midi: number;
  readonly level: number;
};

/** Epoch plan: the event timeline and the blooms of one epoch. */
type EpochPlan = {
  readonly energy: number;
  readonly tonic: number;
  readonly startS: number;
  /** The chord sounding (being reached for) before the epoch's first event. */
  readonly openingChord: FieldChordName;
  readonly events: readonly FieldEvent[];
  readonly pings: readonly PlannedPing[];
  readonly finalVoices: readonly FieldVoice[];
  readonly finalChord: FieldChordName;
  readonly lastPingAtS: number;
};

const SALT_ENERGY = 211;
const SALT_EVENT_GAP = 233;
const SALT_EVENT_SLOT = 239;
const SALT_EVENT_PICK = 241;
const SALT_EMPHASIS = 251;
const SALT_PING_GAP = 257;
const SALT_PING_PICK = 263;
const SALT_PING_LEVEL = 269;
const SALT_KEY = 277;
const SALT_KEY_PICK = 281;
const SALT_CHORD_LEN = 293;
const SALT_CHORD_PICK = 307;

/** The energy walk: charge up one level at a time, release from the peak. */
export function fieldEnergyStep(previous: number, draw: number): number {
  if (previous >= FIELD_ENERGY_MAX) return draw < 0.5 ? 1 : 2;
  if (draw < 0.5) return previous + 1;
  if (draw < 0.8) return previous;
  return Math.max(FIELD_ENERGY_MIN, previous - 1);
}

/**
 * Picks the next tonal centre (semitones above D): hold, return home, or
 * move by one of FIELD_KEY_MOVES by weight.
 */
export function fieldKeyStep(previous: number, changeDraw: number, pickDraw: number): number {
  if (previous !== 0 && changeDraw < FIELD_KEY_HOME_PULL) return 0;
  if (changeDraw >= FIELD_KEY_HOME_PULL + FIELD_KEY_CHANGE) return previous;
  const total = FIELD_KEY_MOVE_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  let cursor = pickDraw * total;
  for (const [index, move] of FIELD_KEY_MOVES.entries()) {
    cursor -= FIELD_KEY_MOVE_WEIGHTS[index] ?? 0;
    if (cursor <= 0) return (previous + move) % 12;
  }
  return (previous + (FIELD_KEY_MOVES[0] ?? 0)) % 12;
}

/** The next chord in the progression graph, by weight. */
export function fieldNextChord(previous: FieldChordName, draw: number): FieldChordName {
  const options = FIELD_PROGRESSIONS[previous];
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = draw * total;
  for (const [name, weight] of options) {
    cursor -= weight;
    if (cursor <= 0) return name;
  }
  return options[options.length - 1]?.[0] ?? "Imaj9";
}

/** The level a slot sounds at once it has a pitch. */
function levelFor(slot: number, emphasis: readonly number[]): number {
  return (FIELD_SLOTS[slot]?.weight ?? 0.5) * (emphasis[slot] ?? 1);
}

/** Pitch classes held by every sounding voice except `slot`. */
function heldClasses(voices: readonly FieldVoice[], slot: number): Set<number> {
  const held = new Set<number>();
  voices.forEach((voice, index) => {
    if (index !== slot && voice.midi !== null) held.add(fieldPitchClass(voice.midi));
  });
  return held;
}

/** MIDI pitches in a slot's window with one of `classes`, free of other voices. */
function pitchesFor(
  slot: number,
  voices: readonly FieldVoice[],
  classes: readonly number[],
): number[] {
  const spec = FIELD_SLOTS[slot];
  if (spec === undefined) return [];
  const others = voices
    .filter((voice, i) => i !== slot && voice.midi !== null)
    .map((voice) => voice.midi as number);
  const out: number[] = [];
  for (let midi = spec.low; midi <= spec.high; midi += 1) {
    if (!classes.includes(fieldPitchClass(midi))) continue;
    // The bass always lands; the voices above keep their distance from it.
    const clear =
      slot === 0
        ? !others.includes(midi)
        : others.every((other) => Math.abs(other - midi) >= fieldMinSpacing(Math.min(other, midi)));
    if (clear) out.push(midi);
  }
  return out;
}

/** The candidate nearest `from`, ties broken by the draw. */
function nearest(from: number, candidates: readonly number[], draw: number): number | null {
  if (candidates.length === 0) return null;
  const best = Math.min(...candidates.map((midi) => Math.abs(midi - from)));
  const ties = candidates.filter((midi) => Math.abs(midi - from) === best);
  return ties[Math.min(ties.length - 1, Math.floor(draw * ties.length))] ?? null;
}

/**
 * Applies one voice event toward `chord`: the bass moves to the chord's
 * bass first; then a voice whose pitch left the chord moves to the nearest
 * chord tone (a semitone or a whole tone where it can, at most
 * FIELD_STEP_MAX); then the sounding count moves toward the energy's
 * target, entering the highest-priority missing tone; then, when the
 * chord is fully there, one upper voice recolours to a missing chord tone
 * nearby, so the chord keeps breathing. The voice that moved last waits
 * its turn. Pure.
 */
export function fieldApplyEvent(
  voices: readonly FieldVoice[],
  chord: FieldChordName,
  tonic: number,
  energy: number,
  emphasis: readonly number[],
  slotDraw: number,
  pickDraw: number,
  lastChangedSlot: number | null = null,
): readonly FieldVoice[] {
  const tones = fieldChordTones(chord, tonic);
  const bass = fieldChordBass(chord, tonic);
  const target = FIELD_VOICES_AT_ENERGY[energy - 1] ?? 3;
  const next = voices.map((voice) => ({ ...voice }));
  const set = (slot: number, midi: number | null): readonly FieldVoice[] => {
    next[slot] =
      midi === null ? { midi: null, level: 0 } : { midi, level: levelFor(slot, emphasis) };
    return next;
  };
  // The bass walks first: to the chord's bass, by the nearest motion.
  const ground = next[0]?.midi ?? null;
  if (ground === null || fieldPitchClass(ground) !== bass) {
    const options = pitchesFor(0, next, [bass]);
    const midi =
      ground === null
        ? (options[Math.floor(pickDraw * options.length)] ?? null)
        : nearest(ground, options, pickDraw);
    if (midi !== null) return set(0, midi);
  }
  const upper = FIELD_ACTIVATION_ORDER.filter((slot) => slot !== 0);
  const sounding = upper.filter((slot) => next[slot]?.midi != null);
  const rested = (pool: readonly number[]): readonly number[] => {
    const others = pool.filter((slot) => slot !== lastChangedSlot);
    return others.length > 0 ? others : pool;
  };
  // A voice off the new chord moves to the nearest chord tone it can reach.
  const stranded = rested(
    sounding.filter((slot) => !tones.includes(fieldPitchClass(next[slot]?.midi ?? 0))),
  );
  for (const slot of stranded) {
    const from = next[slot]?.midi ?? 0;
    const held = heldClasses(next, slot);
    const fresh = pitchesFor(
      slot,
      next,
      tones.filter((pc) => !held.has(pc)),
    ).filter((midi) => Math.abs(midi - from) <= FIELD_STEP_MAX);
    const any = pitchesFor(slot, next, tones).filter(
      (midi) => Math.abs(midi - from) <= FIELD_STEP_MAX,
    );
    const midi = nearest(from, fresh.length > 0 ? fresh : any, pickDraw);
    return set(slot, midi);
  }
  // Voice count toward the energy's target (the ground counts as one).
  const count = sounding.length + (next[0]?.midi != null ? 1 : 0);
  if (count < target) {
    const held = heldClasses(next, -1);
    const missing = tones.filter((pc) => !held.has(pc));
    const slot = upper.find((index) => next[index]?.midi == null);
    if (slot !== undefined) {
      for (const pc of missing.length > 0 ? missing : tones) {
        const options = pitchesFor(slot, next, [pc]);
        if (options.length > 0) {
          return set(slot, options[Math.floor(pickDraw * options.length)] ?? options[0] ?? null);
        }
      }
    }
  }
  if (count > target) {
    const leaving = sounding[sounding.length - 1];
    if (leaving !== undefined) return set(leaving, null);
  }
  // The chord is there: often it simply rests; otherwise one voice
  // recolours to the most important missing tone it can reach, so the
  // guide tones (third, seventh) come back before the colours.
  if (slotDraw < FIELD_REST_SHARE) return next;
  const held = heldClasses(next, -1);
  const missing = tones.filter((pc) => !held.has(pc));
  const movers = rested(sounding);
  const start = Math.floor(pickDraw * movers.length);
  for (const pc of missing) {
    for (let k = 0; k < movers.length; k += 1) {
      const slot = movers[(start + k) % movers.length];
      if (slot === undefined) continue;
      const from = next[slot]?.midi ?? 0;
      // A guide tone is never traded away for a colour.
      const own = fieldPitchClass(from);
      if (tones.indexOf(own) >= 0 && tones.indexOf(own) < tones.indexOf(pc)) continue;
      const options = pitchesFor(slot, next, [pc]).filter(
        (midi) => Math.abs(midi - from) <= FIELD_STEP_MAX,
      );
      const midi = nearest(from, options, pickDraw);
      if (midi !== null) return set(slot, midi);
    }
  }
  return next;
}

/** Whether the voices have reached the chord: the bass on its bass, every upper voice a chord tone. */
export function fieldArrived(
  voices: readonly FieldVoice[],
  chord: FieldChordName,
  tonic: number,
): boolean {
  const tones = fieldChordTones(chord, tonic);
  const ground = voices[0]?.midi;
  if (ground == null || fieldPitchClass(ground) !== fieldChordBass(chord, tonic)) return false;
  return voices
    .slice(1)
    .every((voice) => voice.midi === null || tones.includes(fieldPitchClass(voice.midi)));
}

/** Places a pitch class into the bloom register. */
function pingMidi(pc: number): number {
  for (let midi = FIELD_PING_LOW; midi <= FIELD_PING_HIGH; midi += 1) {
    if (fieldPitchClass(midi) === pc) return midi;
  }
  return FIELD_PING_LOW;
}

/** Plans one epoch's chord progression, voice events and blooms. */
function planEpoch(
  rng: Rng,
  index: number,
  startS: number,
  lengthS: number,
  previous: EpochPlan | undefined,
): EpochPlan {
  const draw = (salt: number, k = 0): number => macroEpochDraw(rng, index, salt + k * 7);
  const energy =
    previous === undefined
      ? FIELD_ENERGY_START
      : fieldEnergyStep(previous.energy, draw(SALT_ENERGY));
  const tonic =
    previous === undefined ? 0 : fieldKeyStep(previous.tonic, draw(SALT_KEY), draw(SALT_KEY_PICK));
  // A new centre opens on its own tonic; otherwise the progression
  // carries on from where the last epoch left it.
  const openingChord: FieldChordName =
    previous === undefined || tonic !== previous.tonic ? "Imaj9" : previous.finalChord;
  const emphasis = FIELD_SLOTS.map(
    (_, slot) =>
      FIELD_EMPHASIS_MIN + (FIELD_EMPHASIS_MAX - FIELD_EMPHASIS_MIN) * draw(SALT_EMPHASIS, slot),
  );
  let voices: readonly FieldVoice[] =
    previous?.finalVoices ?? FIELD_SLOTS.map(() => ({ midi: null, level: 0 }));
  const openingVoices = voices;
  let chord = openingChord;
  let lastChanged: number | null = null;
  const step = (slotDraw: number, pickDraw: number): void => {
    const next = fieldApplyEvent(
      voices,
      chord,
      tonic,
      energy,
      emphasis,
      slotDraw,
      pickDraw,
      lastChanged,
    );
    const changed = next.findIndex((voice, slot) => voice.midi !== voices[slot]?.midi);
    if (changed >= 0) lastChanged = changed;
    voices = next;
  };
  const events: FieldEvent[] = [];
  const endS = startS + lengthS;
  const chordSpan = (k: number): number => {
    const max = Math.max(
      FIELD_CHORD_MIN_S + 5,
      FIELD_CHORD_MAX_S - FIELD_CHORD_ENERGY_SLOPE_S * energy,
    );
    return FIELD_CHORD_MIN_S + draw(SALT_CHORD_LEN, k) * (max - FIELD_CHORD_MIN_S);
  };
  let t = startS;
  let k = 0;
  // Epoch 0 settles its opening chord at once: a scene never starts empty.
  if (previous === undefined) {
    for (let i = 0; i < 6; i += 1) step(draw(SALT_EVENT_SLOT, i), draw(SALT_EVENT_PICK, i));
    events.push({ atS: startS, chord, voices });
    k = 6;
    t = startS + FIELD_EVENT_GAP_MIN_S;
  } else {
    t = startS + FIELD_EVENT_GAP_MIN_S * draw(SALT_EVENT_GAP, 0);
  }
  let chordIndex = 0;
  let nextChordAt = startS + chordSpan(chordIndex);
  while (t < endS - 1) {
    if (t >= nextChordAt) {
      chordIndex += 1;
      chord = fieldNextChord(chord, draw(SALT_CHORD_PICK, chordIndex));
      nextChordAt = t + chordSpan(chordIndex);
    }
    step(draw(SALT_EVENT_SLOT, k), draw(SALT_EVENT_PICK, k));
    events.push({ atS: t, chord, voices });
    const [gapMin, gapMax] = fieldArrived(voices, chord, tonic)
      ? [FIELD_HOLD_GAP_MIN_S, FIELD_HOLD_GAP_MAX_S]
      : [FIELD_EVENT_GAP_MIN_S, FIELD_EVENT_GAP_MAX_S];
    const gap = gapMin + draw(SALT_EVENT_GAP, k + 1) * (gapMax - gapMin);
    // A held chord still turns over on time.
    t =
      t < nextChordAt && t + gap > nextChordAt
        ? Math.max(nextChordAt, t + FIELD_EVENT_GAP_MIN_S)
        : t + gap;
    k += 1;
  }
  // Blooms: sparse notes on a stable chord tone sounding at the time.
  const pings: PlannedPing[] = [];
  const lastPingAtS = previous?.lastPingAtS ?? Number.NEGATIVE_INFINITY;
  let p = Math.max(
    startS + FIELD_PING_GAP_MIN_S * draw(SALT_PING_GAP, 0),
    lastPingAtS +
      FIELD_PING_GAP_MIN_S +
      draw(SALT_PING_GAP, 0) * (FIELD_PING_GAP_MAX_S - FIELD_PING_GAP_MIN_S),
  );
  let j = 1;
  while (p < endS) {
    const at = [...events].reverse().find((event) => event.atS <= p);
    // Blooms sing a stable tone — the root or a guide tone — that is sounding.
    const stable = fieldChordTones(at?.chord ?? openingChord, tonic).slice(0, 3);
    const sounding = (at?.voices ?? openingVoices)
      .filter((voice, slot) => slot !== 0 && voice.midi !== null)
      .map((voice) => fieldPitchClass(voice.midi as number))
      .filter((pc) => stable.includes(pc));
    const pool = sounding.length > 0 ? sounding : stable;
    const pc =
      pool[Math.min(pool.length - 1, Math.floor(draw(SALT_PING_PICK, j) * pool.length))] ?? tonic;
    pings.push({
      id: index * 1000 + j,
      atS: p,
      midi: pingMidi(pc),
      level:
        FIELD_PING_LEVEL_MIN +
        (FIELD_PING_LEVEL_MAX - FIELD_PING_LEVEL_MIN) * draw(SALT_PING_LEVEL, j),
    });
    p +=
      FIELD_PING_GAP_MIN_S + draw(SALT_PING_GAP, j) * (FIELD_PING_GAP_MAX_S - FIELD_PING_GAP_MIN_S);
    j += 1;
  }
  return {
    energy,
    tonic,
    startS,
    openingChord,
    events,
    pings,
    finalVoices: voices,
    finalChord: chord,
    lastPingAtS: pings[pings.length - 1]?.atS ?? lastPingAtS,
  };
}

/**
 * The field sounding at `nowSeconds`: folds the epoch plans from the first
 * epoch (each epoch continues the previous one's voices and progression,
 * so the harmony is a chain, never a lookup), then reads the last event at
 * or before the clock and the blooms inside the lookahead window. Pure
 * function of (clock, seed): agent traffic has no way in.
 */
export function fieldAt(nowSeconds: number, rng: Rng): FieldState {
  const at = Math.max(0, nowSeconds);
  let cursor = MACRO_FIRST_AT_SECONDS;
  let index = 0;
  let previous: EpochPlan | undefined;
  for (;;) {
    const length = macroEpochLength(rng, index);
    const plan = planEpoch(rng, index, cursor, length, previous);
    if (at < cursor + length || index > 100_000) {
      const current = [...plan.events].reverse().find((event) => event.atS <= at);
      const voices =
        current?.voices ??
        previous?.finalVoices ??
        FIELD_SLOTS.map(() => ({ midi: null, level: 0 }));
      const chord = current?.chord ?? plan.openingChord;
      const spec: FieldChordSpec = FIELD_CHORDS[chord];
      const pings = plan.pings
        .filter((ping) => ping.atS >= at && ping.atS < at + FIELD_PING_LOOKAHEAD_S)
        .map((ping) => ({ id: ping.id, inS: ping.atS - at, midi: ping.midi, level: ping.level }));
      return {
        epochIndex: index,
        energy: plan.energy,
        tonic: plan.tonic,
        chord,
        root: (plan.tonic + spec.root) % 12,
        bass: fieldChordBass(chord, plan.tonic),
        minor: (FIELD_QUALITIES[spec.quality] as readonly number[]).includes(3),
        voices,
        pings,
      };
    }
    cursor += length;
    index += 1;
    previous = plan;
  }
}

/** Every distinct pitch class (semitones above D) sounding in a field state. */
export function fieldPitchClasses(state: FieldState): readonly number[] {
  const classes = new Set<number>();
  for (const voice of state.voices) {
    if (voice.midi !== null) classes.add(fieldPitchClass(voice.midi));
  }
  return [...classes].sort((a, b) => a - b);
}
