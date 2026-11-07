// packages/audio/src/gestures/types.ts - the framework-free shape of the
// four Clearing gestures. What this is for: declaring, as plain data,
// which gestures exist, how long each occupies its lane (spec length and
// busy tail), their pre-emption priority, the per-lane voice/bus/sub/
// swell events a gesture expands into, and every level constant the sound
// design doc pins (-6 dB attention, -10 dB at calm 1, +2 dB
// resolve swell, D1 knock). What it must not do: import Tone, read
// events or SceneParams, or compute anything - builders in player.ts
// emit these events and the offline renderer (render.ts) proves them.

import type { VoiceRecipe } from "../scenes/clearing/index.js";

/** The four gestures, named exactly per docs/SOUND_DESIGN.md Gestures. */
export type GestureName = "arrive" | "question" | "resolve" | "attention";

/** A gesture trigger: which lane, which gesture, at what engine-clock time. */
export type GestureTrigger = {
  /** Lane index into the SceneParams lanes (0/1/2 -> low/mid/high register. */
  readonly laneIndex: number;
  readonly gesture: GestureName;
  /** Engine-clock time the trigger was requested (LaneGesture.at). */
  readonly at: number;
};

/** Original logical cue windows, retained so recorded decay cannot suppress later events. */
export const GESTURE_LENGTH_S: Record<GestureName, number> = {
  arrive: 1.2,
  question: 1.8,
  resolve: 2.0,
  attention: 0.4,
};

/** Original logical tails. Acoustic piano decay has its own window in PIANO_CUE_END_S. */
export const GESTURE_TAIL_S: Record<GestureName, number> = {
  arrive: 0.3,
  question: 0.8,
  resolve: 4.0,
  attention: 0.1,
};

/** Original refractory/busy duration, independent of the new acoustic piano tail. */
export function gestureBusyS(gesture: GestureName): number {
  return GESTURE_LENGTH_S[gesture] + GESTURE_TAIL_S[gesture];
}

/**
 *  Pre-emption priority per gesture. `question` pre-empts everything;
 *  among simultaneously-due fresh triggers the highest priority fires first.
 */
export const GESTURE_PRIORITY: Record<GestureName, number> = {
  attention: 0,
  arrive: 1,
  resolve: 2,
  question: 3,
};

/** Peak linear gain of a gesture note (arrive/question/resolve notes). */
export const NOTE_GAIN = 0.22;

/** Attention level relative to NOTE_GAIN at calm 0, in dB. */
export const ATTENTION_REL_DB = -6;

/** Additional attention cut per unit calm, in dB: at calm 1 the knock is -10 dB. */
export const ATTENTION_CALM_CUT_DB = 4;

/** Attention level in dB relative to NOTE_GAIN (the spec's "-6 dB, -10 dB at calm  1"). */
export function attentionDb(calm: number): number {
  return ATTENTION_REL_DB - ATTENTION_CALM_CUT_DB * calm;
}

/** Noise-burst share of the knock:the sub thump carries most of the level. */
export const ATTENTION_NOISE_SHARE = 0.3;

/** The knock's sub-thump pitch: D1. */
export const ATTENTION_SUB_MIDI = 26;

/** Detune of the sub thump's second copy (fatigue rule 3: never a lone sine. */
export const ATTENTION_SUB_DETUNE_CENTS = 3;

/** Low-pass of the knock's noise burst. */
export const ATTENTION_KNOCK_LOWPASS_HZ = 500;

/** Resolve drone swell amount, in dB. */
export const RESOLVE_SWELL_DB = 2;

/** Seconds the gesture bus takes to open (0->1) at a gesture start. */
export const GESTURE_BUS_ATTACK_S = 0.02;

/**
 * Question bus attack (p3-t14 revp3t14, question-only): the question
 * gesture's bus opens in 5 ms — the same floor as every sample start
 * and the question's own first-note attack, so no click. The 20 ms
 * bus swell was bottlenecking the crisp first-D attack (effective
 * attack ≈ 20 ms+), masking the flux onset the 10–12 s gate asserts.
 * All other gestures keep the 20 ms swell.
 */
export const QUESTION_BUS_ATTACK_S = 0.005;

/** Seconds a pre-empted gesture's bus takes to close (question cuts it). */
export const CUT_RELEASE_S = 0.05;

/** One rendered note in the lane's timbre, at the lane's pan. */
export type GestureNoteEvent = {
  kind: "note";
  /** Piano cues use recordings; absent only for sustained-voice diagnostics. */
  instrument?: "piano";
  laneIndex: number;
  /** Quantized, in the lane's register. */
  midi: number;
  /** Seconds from the gesture's sound start (offsets; absolute only when added to the trigger's now). */
  startS: number;
  /** Linear 0->1 attack, seconds. */
  attackS: number;
  /** Seconds from the gesture's sound start the sustain hold ends (release starts here). */
  holdUntilS: number;
  /** Linear 1->0 release, seconds. */
  releaseS: number;
  /** Peak linear gain of the whole note (split across recipe oscillators. */
  gain: number;
  /** Lane pan (-0.6/0/+0.6), identity is intrinsic. */
  pan: number;
  /** The lane's voice recipe (pad/mallet/FM bell). */
  timbre: VoiceRecipe;
};

/** A filtered noise burst (the attention knock's "filtered noise burst"). */
export type GestureNoiseEvent = {
  kind: "noise";
  laneIndex: number;
  /** Seconds from the gesture's sound start. */
  startS: number;
  attackS: number;
  /** Seconds from the gesture's sound start. */
  holdUntilS: number;
  releaseS: number;
  gain: number;
  pan: number;
  lowpassHz: number;
};

/** A low sub thump (the attention knock's "sub thump at D1"). */
export type GestureSubEvent = {
  kind: "sub";
  laneIndex: number;
  midi: number;
  /** Seconds from the gesture's sound start. */
  startS: number;
  attackS: number;
  /** Seconds from the gesture's sound start. */
  holdUntilS: number;
  releaseS: number;
  gain: number;
  pan: number;
};

/**
 *  A ramp of a lane's gesture-bus gain. Every gesture opens the bus
 *  (0->1 over GESTURE_BUS_ATTACK_S) and closes it over its tail;
 *  `question` pre-emption inserts a CUT_RELEASE_S close before its own
 *  open. Exponential moves interpolate in gain space toward the shared
 *  floor, so the offline render matches what apply.ts schedules live.

 */
export type GestureBusMoveEvent = {
  kind: "bus";
  laneIndex: number;
  startS: number;
  endS: number;
  from: number;
  to: number;
  curve: "linear" | "exponential";
};

/** A +2 dB drone swell (the resolve gesture's "drone briefly swelling"). */
export type GestureSwellEvent = {
  kind: "swell";
  /** Seconds from the gesture's sound start. */
  startS: number;
  attackS: number;
  /** Seconds from the gesture's sound start. */
  holdUntilS: number;
  releaseS: number;
  /** Swell amount in dB (RESOLVE_SWELL_DB). */
  gainDb: number;
};

/**
 * A breath articulation (the flute timbre's per-note noise breath,
 * p3-t13): filtered noise through the voice low-pass, the same envelope
 * path as a note. Only the high lane emits these.
 */
export type GestureBreathEvent = {
  kind: "breath";
  laneIndex: number;
  /** Seconds from the gesture's sound start. */
  startS: number;
  attackS: number;
  /** Seconds from the gesture's sound start. */
  holdUntilS: number;
  releaseS: number;
  gain: number;
  pan: number;
  lowpassHz: number;
};

/** Every event a gesture expands into, as plain data the offline renderer proves. */
export type GestureVoiceEvent =
  | GestureNoteEvent
  | GestureNoiseEvent
  | GestureSubEvent
  | GestureBusMoveEvent
  | GestureSwellEvent
  | GestureBreathEvent;
