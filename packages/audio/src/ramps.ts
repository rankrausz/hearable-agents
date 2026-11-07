// packages/audio/src/ramps.ts — the ramp discipline for every audible
// parameter. What this is for: the single transcription of
// docs/SOUND_DESIGN.md §Ramps (parameter class → ramp seconds and curve),
// plus a pure trajectory model (`approachTrajectory`) that proves a ramped
// move approaches its target monotonically, and the exponential-gain floor
// that keeps zero-crossing gains rampable. What it must not do: import Tone
// or schedule anything — apply.ts maps these constants onto Param/Signal
// calls, and tests assert on this module without audio.

/** Which curve a ramped move uses. */
export type RampCurve = "exponential" | "linear" | "target";

/** One ramp class: how long the move takes and which curve it follows. */
export type RampSpec = {
  /** Ramp duration in seconds. */
  readonly seconds: number;
  /** Curve: exponential for gains, linear for musical rates, target for beds. */
  readonly curve: RampCurve;
};

/**
 * Ramp times per docs/SOUND_DESIGN.md §Ramps. Layer gains use exponential
 * ramps; filter cutoffs, reverb send, brightness, detune, pan, width and
 * master use linear ramps toward the target; regularity, density and period
 * drift rather than switch, so they use the slow target approach; tension
 * attacks in 3 s and releases in 5 s.
 *
 * `crossfade` is the p5-t01 lane note move (ADR 0021 prototype): the total
 * length of the equal-power fade that hands a lane's note from one voice
 * bank to the other — old note out, new note in, no pitch ever bending.
 * It replaced a pitch glide (a `portamento` class, exponential in
 * frequency) that the owner heard as too weird however even or short it
 * was made: a sustained ambient voice that slides reads as a tape effect,
 * not as a new note. Scheduled as two linear half-ramps meeting at
 * 1/√2, so the summed power of the two incoherent banks holds flat
 * across the fade (see apply.ts crossfadeLaneVoices).
 */
export const RAMP_TIMES = {
  layerGain: { seconds: 1.5, curve: "exponential" },
  cutoff: { seconds: 2.0, curve: "linear" },
  reverbSend: { seconds: 2.0, curve: "linear" },
  brightness: { seconds: 2.0, curve: "linear" },
  regularity: { seconds: 4.0, curve: "target" },
  density: { seconds: 4.0, curve: "target" },
  period: { seconds: 4.0, curve: "target" },
  detune: { seconds: 6.0, curve: "linear" },
  crossfade: { seconds: 3.0, curve: "linear" },
  // Harmonic field (ADR 0025): a field voice enters or leaves over 12 s —
  // slow enough that a chord thickening reads as a swell, not an entry —
  // and hands its pitch between banks over 5 s, longer than a lane's
  // 3 s because nothing marks the moment and the chord should morph.
  fieldVoice: { seconds: 12.0, curve: "linear" },
  // 5 → 3 s (owner listen 2026-10-29): a semitone handover overlapping
  // for 5 s ground as a vibration; 3 s keeps the morph without the rub.
  fieldCrossfade: { seconds: 3.0, curve: "linear" },
  // The drone bed (owner direction 2026-10-29): entering or leaving the
  // empty room moves it by about 23 dB, which over a layer gain's 1.5 s
  // reads as a switch; 8 s reads as the room settling or waking.
  room: { seconds: 8.0, curve: "exponential" },
  // The drone hands its tonal centre between banks over 10 s (owner
  // direction 2026-10-29): longer than a field voice's 5 s, because the
  // floor moving is the deepest change in the scene and should feel like
  // the ground shifting, not a note.
  droneCrossfade: { seconds: 10.0, curve: "linear" },
  pan: { seconds: 3.0, curve: "linear" },
  width: { seconds: 3.0, curve: "linear" },
  master: { seconds: 1.0, curve: "linear" },
  tensionAttack: { seconds: 3.0, curve: "linear" },
  tensionRelease: { seconds: 5.0, curve: "linear" },
} as const satisfies Record<string, RampSpec>;

export type RampClass = keyof typeof RAMP_TIMES;

/**
 * Floor substituted for zero when an exponential gain ramp targets or
 * starts at silence. Matches the smallest positive gain Tone's Param keeps
 * rampable (`_minOutput = 1e-7` in Tone 15.1.22's Param): the Web Audio
 * exponential ramp cannot start or end at 0, so approaching this floor is
 * silence for every QA bound (−140 dB) without ever stepping.
 */
export const EXPONENTIAL_GAIN_FLOOR = 1e-7;

/** One sample of a planned ramp: normalized 0..1 progress and value. */
export type TrajectoryPoint = {
  /** Progress through the ramp in seconds from the move start. */
  readonly t: number;
  /** Planned parameter value at t. */
  readonly value: number;
};

/**
 * Models the trajectory of a ramped move from `from` to `to` over the ramp
 * class duration: exponential for gain-shaped classes, linear otherwise,
 * sampled every `stepS`. Zero-valued gain endpoints are lifted to
 * EXPONENTIAL_GAIN_FLOOR so the model matches what apply.ts schedules.
 * Pure and deterministic: tests assert monotonic approach on its output.
 */
export function approachTrajectory(
  rampClass: RampClass,
  from: number,
  to: number,
  stepS = 0.05,
): readonly TrajectoryPoint[] {
  const spec = RAMP_TIMES[rampClass];
  const points: TrajectoryPoint[] = [];
  const steps = Math.max(1, Math.ceil(spec.seconds / stepS));
  for (let i = 0; i <= steps; i += 1) {
    const t = Math.min(spec.seconds, i * stepS);
    const progress = t / spec.seconds;
    points.push({ t, value: interpolate(spec.curve, from, to, progress) });
  }
  return points;
}

/** Interpolates one ramp step for the given curve. */
function interpolate(curve: RampCurve, from: number, to: number, progress: number): number {
  if (curve === "linear") return from + (to - from) * progress;
  if (curve === "target") {
    const settled = 1 - Math.exp(-progress * 5);
    return from + (to - from) * settled;
  }
  const safeFrom = from === 0 ? EXPONENTIAL_GAIN_FLOOR : from;
  const safeTo = to === 0 ? EXPONENTIAL_GAIN_FLOOR : to;
  return safeFrom * (safeTo / safeFrom) ** progress;
}
