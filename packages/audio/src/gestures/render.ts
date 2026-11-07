// packages/audio/src/gestures/render.ts - deterministic offline renderer for
// gesture event plans. What this is for: turning `GestureVoiceEvent`s into a
// stereo buffer, so tests (and later the QA harness, p3-t05) can prove what a
// gesture sounds like without a browser: lane bus envelopes, the bed drone
// with the resolve swell, per-note voices through the lane's timbre recipe
// (one-pole low-pass, FM phase-modulation for the bell), the knock's sub
// thump and filtered noise burst, equal-power pan per lane, all envelopes
// linear ramps (>= 5 ms fades), so nothing ever steps. It uses a fixed-seed
// RNG for the noise burst, so renders are byte-stable. What it must not do:
// import Tone, keep state, or touch time - it is a pure function of the plan.

import { createRng } from "@hearable/core";

import { midiToFrequency } from "../graph/index.js";

import { EXPONENTIAL_GAIN_FLOOR } from "../ramps.js";

import { DRONE_GAIN_DB, DRONE_VOICE, type VoiceRecipe } from "../scenes/clearing/index.js";
import type { GestureSwellEvent, GestureVoiceEvent } from "./types.js";
import { ATTENTION_SUB_DETUNE_CENTS } from "./types.js";

export type PianoPcm = {
  readonly midi: number;
  readonly sampleRate: number;
  readonly samples: Float32Array;
};

/** Render options: sample rate and whether the bed drone is included. */

export type GestureRenderOptions = {
  readonly sampleRate?: number;
  /** Decoded recordings, injected by Node tests; no synthesized piano fallback. */
  readonly pianoSamples?: readonly PianoPcm[];

  /** Render the constant bed drone even without a swell event (default false). */

  readonly bed?: boolean;
};

/** The rendered stereo buffer. */

export type GestureRenderResult = {
  readonly left: Float32Array;

  readonly right: Float32Array;

  readonly sampleRate: number;

  readonly durationS: number;
};

/** Fixed seed for the knock's noise burst, so offline renders are deterministic. */

const NOISE_SEED = 0xfeedbeef;

/**

 *  Renders a gesture plan into a stereo buffer. Bus moves fold into per-

 *  lane gain curves; swell events fold into the bed curve; notes, noise

 *  and sub thumps synthesize into the lanes. Pure and deterministic.


 */

export function renderGesturePlan(
  events: readonly GestureVoiceEvent[],

  durationS: number,

  options: GestureRenderOptions = {},
): GestureRenderResult {
  const sampleRate = options.sampleRate ?? 44100;

  const n = Math.max(1, Math.ceil(durationS * sampleRate));

  const left = new Float32Array(n);

  const right = new Float32Array(n);

  const laneCount =
    events.reduce(
      (max, e) => Math.max(max, (e as { laneIndex?: number }).laneIndex ?? 0),

      0,
    ) + 1;

  const busCurves = buildLaneCurves(events, laneCount, n, sampleRate);

  const bedCurve = buildBedCurve(events, n, sampleRate, options.bed ?? false);

  if (bedCurve !== null) renderBed(bedCurve, left, right, n, sampleRate);

  for (const event of events) {
    switch (event.kind) {
      case "note":
        if (event.instrument === "piano")
          renderPiano(event, options.pianoSamples, busCurves, left, right, n, sampleRate);
        else renderNote(event, busCurves, left, right, n, sampleRate);
        break;

      case "noise":
        renderNoise(event, busCurves, left, right, n, sampleRate);
        break;

      case "breath":
        renderBreath(event, busCurves, left, right, n, sampleRate);
        break;

      case "sub":
        renderSub(event, busCurves, left, right, n, sampleRate);
        break;

      default:
        break; // bus moves and swell already folded into the curves
    }
  }

  return { left, right, sampleRate, durationS };
}

/** Equal-power pan gains for a pan in -1..1. */

function panLevels(pan: number): { left: number; right: number } {
  const angle = ((pan + 1) / 2) * (Math.PI / 2);

  return { left: Math.cos(angle), right: Math.sin(angle) };
}

/** One envelope sample: attack, hold, release, all linear. */

function envelope(
  t: number,

  startS: number,

  attackS: number,

  holdUntilS: number,

  releaseS: number,
): number {
  if (t < startS) return 0;

  const local = t - startS;

  if (local < attackS) return local / attackS;

  if (t < holdUntilS) return 1;

  const rel = t - holdUntilS;

  if (rel >= releaseS) return 0;

  return 1 - rel / releaseS;
}

/** One oscillator sample (sawtooth, triangle, sine, or phase-modulated FM). */

function oscillatorSample(
  osc: VoiceRecipe["oscillators"][number],

  freq: number,

  t: number,
): number {
  if (osc.fm !== undefined) {
    return Math.sin(
      2 * Math.PI * freq * t +
        osc.fm.modulationIndex * Math.sin(2 * Math.PI * freq * osc.fm.harmonicity * t),
    );
  }

  switch (osc.type) {
    case "sawtooth": {
      const phase = (t * freq) % 1;

      return 2 * phase - 1;
    }

    case "triangle": {
      const phase = (t * freq) % 1;

      return 2 * Math.abs(2 * phase - 1) - 1;
    }

    default:
      return Math.sin(2 * Math.PI * freq * t);
  }
}

/** One-pole low-pass coefficient for a cutoff. */

function poleAlpha(cutoffHz: number, sampleRate: number): number {
  const rc = 1 / (2 * Math.PI * cutoffHz);

  return 1 / sampleRate / (rc + 1 / sampleRate);
}

function renderNote(
  event: Extract<GestureVoiceEvent, { kind: "note" }>,

  busCurves: readonly Float32Array[],

  left: Float32Array,

  right: Float32Array,

  n: number,

  sampleRate: number,
): void {
  const bus = busCurves[event.laneIndex];

  if (bus === undefined) return;

  const pan = panLevels(event.pan);

  const nOsc = Math.max(1, event.timbre.oscillators.length);

  const iStart = Math.max(0, Math.round(event.startS * sampleRate));
  const iEnd = Math.min(n, Math.round((event.holdUntilS + event.releaseS) * sampleRate));

  const alpha = poleAlpha(event.timbre.lowpassHz, sampleRate);

  let filtered = 0;

  for (let i = iStart; i < iEnd; i++) {
    const t = i / sampleRate;

    const env = envelope(t, event.startS, event.attackS, event.holdUntilS, event.releaseS);

    if (env <= 0) continue;

    const busLevel = bus[i] ?? 0;

    if (busLevel <= 0) continue;

    let sig = 0;

    for (const osc of event.timbre.oscillators) {
      const freq = midiToFrequency(event.midi) * 2 ** (osc.detuneCents / 1200);

      sig += oscillatorSample(osc, freq, t);
    }

    filtered += alpha * (sig - filtered);

    const level = filtered * env * busLevel * (event.gain / nOsc);

    left[i] = (left[i] ?? 0) + level * pan.left;

    right[i] = (right[i] ?? 0) + level * pan.right;
  }
}

function renderNoise(
  event: Extract<GestureVoiceEvent, { kind: "noise" }>,

  busCurves: readonly Float32Array[],

  left: Float32Array,

  right: Float32Array,

  n: number,

  sampleRate: number,
): void {
  const bus = busCurves[event.laneIndex];

  if (bus === undefined) return;

  const pan = panLevels(event.pan);

  const rng = createRng(NOISE_SEED + event.laneIndex);

  const iStart = Math.max(0, Math.round(event.startS * sampleRate));
  const iEnd = Math.min(n, Math.round((event.holdUntilS + event.releaseS) * sampleRate));

  const alpha = poleAlpha(event.lowpassHz, sampleRate);

  let filtered = 0;

  for (let i = iStart; i < iEnd; i++) {
    const t = i / sampleRate;

    const env = envelope(t, event.startS, event.attackS, event.holdUntilS, event.releaseS);

    if (env <= 0) continue;

    const busLevel = bus[i] ?? 0;

    if (busLevel <= 0) continue;

    const sig = rng.next() * 2 - 1;

    filtered += alpha * (sig - filtered);

    const level = filtered * env * busLevel * event.gain;

    left[i] = (left[i] ?? 0) + level * pan.left;

    right[i] = (right[i] ?? 0) + level * pan.right;
  }
}

/**
 * Flute breath articulation (p3-t13): filtered noise through the voice
 * low-pass on the same envelope path as a note — what the live
 * scheduleGestureBreath path sounds. Same shape as the knock's noise
 * burst; the recipe (share, low-pass) owns the timbre difference.
 */
function renderBreath(
  event: Extract<GestureVoiceEvent, { kind: "breath" }>,

  busCurves: readonly Float32Array[],

  left: Float32Array,

  right: Float32Array,

  n: number,

  sampleRate: number,
): void {
  const bus = busCurves[event.laneIndex];

  if (bus === undefined) return;

  const pan = panLevels(event.pan);

  const rng = createRng(NOISE_SEED + event.laneIndex * 7919);

  const iStart = Math.max(0, Math.round(event.startS * sampleRate));
  const iEnd = Math.min(n, Math.round((event.holdUntilS + event.releaseS) * sampleRate));

  const alpha = poleAlpha(event.lowpassHz, sampleRate);

  let filtered = 0;

  for (let i = iStart; i < iEnd; i++) {
    const t = i / sampleRate;

    const env = envelope(t, event.startS, event.attackS, event.holdUntilS, event.releaseS);

    if (env <= 0) continue;

    const busLevel = bus[i] ?? 0;

    if (busLevel <= 0) continue;

    const sig = rng.next() * 2 - 1;

    filtered += alpha * (sig - filtered);

    const level = filtered * env * busLevel * event.gain;

    left[i] = (left[i] ?? 0) + level * pan.left;

    right[i] = (right[i] ?? 0) + level * pan.right;
  }
}

function renderSub(
  event: Extract<GestureVoiceEvent, { kind: "sub" }>,

  busCurves: readonly Float32Array[],

  left: Float32Array,

  right: Float32Array,

  n: number,

  sampleRate: number,
): void {
  const bus = busCurves[event.laneIndex];

  if (bus === undefined) return;

  const pan = panLevels(event.pan);

  const freq = midiToFrequency(event.midi);

  const freqA = freq * 2 ** (ATTENTION_SUB_DETUNE_CENTS / 1200);

  const freqB = freq * 2 ** (-ATTENTION_SUB_DETUNE_CENTS / 1200);

  const iStart = Math.max(0, Math.round(event.startS * sampleRate));
  const iEnd = Math.min(n, Math.round((event.holdUntilS + event.releaseS) * sampleRate));

  for (let i = iStart; i < iEnd; i++) {
    const t = i / sampleRate;

    const env = envelope(t, event.startS, event.attackS, event.holdUntilS, event.releaseS);

    if (env <= 0) continue;

    const busLevel = bus[i] ?? 0;

    if (busLevel <= 0) continue;

    const sig = Math.sin(2 * Math.PI * freqA * t) + Math.sin(2 * Math.PI * freqB * t);

    const level = 0.5 * sig * env * busLevel * event.gain;

    left[i] = (left[i] ?? 0) + level * pan.left;

    right[i] = (right[i] ?? 0) + level * pan.right;
  }
}

/** Folds every bus move into a per-lane gain curve, starting at silence. */

function buildLaneCurves(
  events: readonly GestureVoiceEvent[],

  laneCount: number,

  n: number,

  sampleRate: number,
): readonly Float32Array[] {
  const curves = Array.from({ length: laneCount }, () => new Float32Array(n));

  for (const event of events) {
    if (event.kind !== "bus") continue;

    const curve = curves[event.laneIndex];

    if (curve === undefined) continue;

    const i0 = Math.max(0, Math.round(event.startS * sampleRate));

    const i1 = Math.min(n, Math.round(event.endS * sampleRate));

    const from = event.from;
    const span = Math.max(1, i1 - i0);

    for (let i = i0; i < i1; i++) {
      const u = (i - i0) / span;

      const value =
        event.curve === "exponential" ? expInterp(from, event.to, u) : from + (event.to - from) * u;

      curve[i] = value;
    }
  }

  for (let lane = 0; lane < laneCount; lane++) {
    const curve = curves[lane];
    if (curve === undefined) continue;
    let current = 0;
    for (let i = 0; i < n; i++) {
      const v = curve[i] ?? 0;
      curve[i] = v !== 0 ? v : current;
      if (v !== 0) current = v;
    }
  }
  return curves;
}

/** Exponential interpolation in gain space toward the shared floor. */

function expInterp(from: number, to: number, u: number): number {
  const safeFrom = Math.max(from, EXPONENTIAL_GAIN_FLOOR);

  const safeTo = Math.max(to, EXPONENTIAL_GAIN_FLOOR);

  return safeFrom * (safeTo / safeFrom) ** u;
}

/** The bed curve: constant 1, with +gainDb swell bumps. */

function buildBedCurve(
  events: readonly GestureVoiceEvent[],

  n: number,

  sampleRate: number,

  bed: boolean,
): Float32Array | null {
  const swells = events.filter((e): e is GestureSwellEvent => e.kind === "swell");

  if (!bed) return null;

  const curve = new Float32Array(n).fill(1);

  for (const e of swells) {
    const peak = 10 ** (e.gainDb / 20);

    const i0 = Math.max(0, Math.round(e.startS * sampleRate));

    const iA = Math.min(n, Math.round((e.startS + e.attackS) * sampleRate));

    const iH = Math.min(n, Math.round(e.holdUntilS * sampleRate));

    const iR = Math.min(n, Math.round((e.holdUntilS + e.releaseS) * sampleRate));

    for (let i = i0; i < iA; i++) {
      const u = iA > i0 ? (i - i0) / (iA - i0) : 1;

      curve[i] = 1 + (peak - 1) * u;
    }

    for (let i = iA; i < iH; i++) curve[i] = peak;

    for (let i = iH; i < iR; i++) {
      const u = iR > iH ? (i - iH) / (iR - iH) : 1;

      curve[i] = peak + (1 - peak) * u;
    }
  }

  return curve;
}

/** Renders the bed drone at the scene's base level, times the bed curve. */

function renderBed(
  curve: Float32Array,

  left: Float32Array,

  right: Float32Array,

  n: number,

  sampleRate: number,
): void {
  const base = 10 ** (DRONE_GAIN_DB / 20);

  const gainPerOsc = base / DRONE_VOICE.oscillators.length;

  const alpha = poleAlpha(DRONE_VOICE.lowpassHz, sampleRate);

  let filtered = 0;

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;

    let sig = 0;

    for (const osc of DRONE_VOICE.oscillators) {
      const freq = midiToFrequency(osc.midi) * 2 ** (osc.detuneCents / 1200);

      sig += oscillatorSample(osc, freq, t);
    }

    filtered += alpha * (sig - filtered);

    const level = filtered * gainPerOsc * (curve[i] ?? 1);

    left[i] = (left[i] ?? 0) + level * Math.SQRT1_2;

    right[i] = (right[i] ?? 0) + level * Math.SQRT1_2;
  }
}

/** Resamples the actual PCM recording, preserving the hammer and string decay. */
function renderPiano(
  event: Extract<GestureVoiceEvent, { kind: "note" }>,
  samples: readonly PianoPcm[] | undefined,
  buses: readonly Float32Array[],
  left: Float32Array,
  right: Float32Array,
  n: number,
  sampleRate: number,
): void {
  const source =
    samples &&
    [...samples].sort(
      (a, b) => Math.abs(a.midi - event.midi) - Math.abs(b.midi - event.midi) || b.midi - a.midi,
    )[0];
  if (!source) throw new Error("Piano PCM recordings must be provided to render piano cues.");
  const rate = (2 ** ((event.midi - source.midi) / 12) * source.sampleRate) / sampleRate;
  const pan = panLevels(event.pan);
  const start = Math.round(event.startS * sampleRate);
  const end = Math.min(n, Math.ceil((event.holdUntilS + event.releaseS) * sampleRate));
  for (let i = Math.max(0, start); i < end; i++) {
    const position = (i - start) * rate;
    const j = Math.floor(position),
      u = position - j;
    if (j >= source.samples.length - 1) break;
    const value =
      ((source.samples[j] ?? 0) * (1 - u) + (source.samples[j + 1] ?? 0) * u) *
      event.gain *
      envelope(i / sampleRate, event.startS, event.attackS, event.holdUntilS, event.releaseS) *
      (buses[event.laneIndex]?.[i] ?? 0);
    left[i] = (left[i] ?? 0) + value * pan.left;
    right[i] = (right[i] ?? 0) + value * pan.right;
  }
}
