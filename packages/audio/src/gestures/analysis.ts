// packages/audio/src/gestures/analysis.ts - small buffer-analysis helpers for
// the offline gesture renders. What this is for: proving, from the rendered
// buffer, what each gesture sounds like: RMS level in dB, peak level, and the
// dominant frequency or autocorrelation pitch over a time window, so tests
// (and later the QA harness, p3-t05) can assert timing, pitch content,
// lane-register and level properties without a browser. What it must not do:
// import Tone, keep state, or claim spectral precision - it answers the
// monophonic gesture voices, which is what the acceptance criteria need.

/** RMS level of a window in dBFS (silence is -Infinity). */

export function rmsDb(
  samples: ArrayLike<number>,

  sampleRate: number,

  fromS: number,

  toS: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));

  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));

  let sum = 0;

  let count = 0;

  for (let i = i0; i < i1; i++) {
    const v = samples[i] ?? 0;

    sum += v * v;

    count++;
  }

  if (count === 0) return Number.NEGATIVE_INFINITY;

  return 10 * Math.log10(sum / count);
}

/** Peak absolute level of a window in dBFS. */

export function peakDb(
  samples: ArrayLike<number>,

  sampleRate: number,

  fromS: number,

  toS: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));

  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));

  let peak = 0;

  for (let i = i0; i < i1; i++) {
    peak = Math.max(peak, Math.abs(samples[i] ?? 0));
  }

  return peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak);
}

/**

 *  Dominant frequency of a window via zero-crossing rate:for the

 *  monophonic gesture voices (sine/saw/triangle/FM carrier) this equals

 *  the fundamental. Returns 0 for silence or near-silence windows.


 */

export function dominantFrequency(
  samples: ArrayLike<number>,

  sampleRate: number,

  fromS: number,

  toS: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));

  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));

  if (i1 - i0 <= 1) return 0;

  let crossings = 0;

  let prev = samples[i0] ?? 0;

  for (let i = i0 + 1; i < i1; i++) {
    const v = samples[i] ?? 0;

    if ((prev < 0 && v >= 0) || (prev > 0 && v <= 0)) crossings++;

    prev = v;
  }

  const duration = (i1 - i0) / sampleRate;

  return crossings / (2 * duration);
}

/**
 *  Robust monophonic pitch estimate via autocorrelation: the first strong
 *  lag peak in the 30..2000 Hz range returns that frequency. Unlike the
 *  zero-crossing rate, this stays correct for harmonic-rich voices (saw,
 *  FM bell, mallet) whose zero crossings cluster near the higher
 *  harmonics. Returns 0 for a silent or unpitched window.
 */
export function estimatePitch(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
  minHz = 30,
  maxHz = 2000,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  if (i1 - i0 < sampleRate / maxHz) return 0;
  const kMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const kMax = Math.min(i1 - i0, Math.ceil(sampleRate / minHz));
  let r0 = 0;
  for (let i = i0; i < i1; i++) r0 += (samples[i] ?? 0) * (samples[i] ?? 0);
  if (r0 <= 1e-6) return 0;
  let bestK = 0;
  let bestScore = 0;
  for (let k = kMin; k <= kMax; k++) {
    let r = 0;
    for (let i = i0; i < i1 - k; i++) r += (samples[i] ?? 0) * (samples[i + k] ?? 0);
    const score = r / r0;
    if (score > bestScore) {
      bestScore = score;
      bestK = k;
    }
  }
  if (bestK === 0 || bestScore < 0.2) return 0;
  return sampleRate / bestK;
}
