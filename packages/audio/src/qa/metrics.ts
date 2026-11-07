// packages/audio/src/qa/metrics.ts — small auditable buffer-analysis
// functions for the audio QA harness. What this is for: turning a rendered
// stereo buffer into the fatigue-rule numbers `pnpm audio:qa` asserts
// (level, spectrum, repetition, clicks, DC), so a QA failure points at the
// metric or the mix unambiguously. What it must not do: import Tone, keep
// state, or touch time — every function is pure over the samples.

/** RMS level of a mono mix in dBFS (silence is -Infinity). */
export function rmsDb(samples: ArrayLike<number>): number {
  if (samples.length === 0) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return 10 * Math.log10(sum / samples.length);
}

/** RMS level of a time window in dBFS (silence is -Infinity). */
export function windowRmsDb(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  if (i1 <= i0) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = i0; i < i1; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return 10 * Math.log10(sum / (i1 - i0));
}

/** Peak absolute level of the whole buffer in dBFS. */
export function peakDb(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i] ?? 0));
  }
  return peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak);
}

/** Peak absolute level of a time window in dBFS. */
export function windowPeakDb(
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
 * Maximum sample-to-sample jump across both channels (fatigue rule 6).
 * A ramped mix never steps; an un-ramped one does.
 */
export function maxSampleJump(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let jump = 0;
  for (const channel of [left, right]) {
    let previous = channel[0] ?? 0;
    for (let i = 1; i < channel.length; i++) {
      const v = channel[i] ?? 0;
      jump = Math.max(jump, Math.abs(v - previous));
      previous = v;
    }
  }
  return jump;
}

/** Mean (DC offset) of a mono mix; fatigue rule 7 caps it at 0.01. */
export function dcOffset(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] ?? 0;
  return sum / samples.length;
}

/** FFT length for spectral estimates: ~93 ms at 44.1 kHz. */
export const SPECTRUM_FFT_SIZE = 4096;

/**
 * Forward radix-2 FFT, in place over the real/imaginary arrays. The
 * textbook iterative Cooley–Tukey form: bit-reversal permutation, then
 * one pass per stage. Only this module's spectrum estimates use it.
 */
export function forwardFft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i] ?? 0;
      real[i] = real[j] ?? 0;
      real[j] = tr;
      const ti = imag[i] ?? 0;
      imag[i] = imag[j] ?? 0;
      imag[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = real[i + k] ?? 0;
        const ui = imag[i + k] ?? 0;
        const vr = (real[i + k + len / 2] ?? 0) * cwr - (imag[i + k + len / 2] ?? 0) * cwi;
        const vi = (real[i + k + len / 2] ?? 0) * cwi + (imag[i + k + len / 2] ?? 0) * cwr;
        real[i + k] = ur + vr;
        imag[i + k] = ui + vi;
        real[i + k + len / 2] = ur - vr;
        imag[i + k + len / 2] = ui - vi;
        const nextWr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nextWr;
      }
    }
  }
}

/**
 * Mean power spectrum of the samples: Hann-windowed frames of
 * SPECTRUM_FFT_SIZE with no overlap, power averaged across frames
 * (Welch's method without overlap). Returns bin powers 0..N/2 and the
 * bin width in Hz. Windows shorter than one frame score all zeros.
 */
export function meanPowerSpectrum(
  samples: ArrayLike<number>,
  sampleRate: number,
): { powers: Float64Array; binHz: number } {
  const n = SPECTRUM_FFT_SIZE;
  const binHz = sampleRate / n;
  const powers = new Float64Array(n / 2 + 1);
  const frames = Math.floor(samples.length / n);
  if (frames === 0) return { powers, binHz };
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < n; i++) {
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      real[i] = (samples[f * n + i] ?? 0) * hann;
      imag[i] = 0;
    }
    forwardFft(real, imag);
    for (let b = 0; b <= n / 2; b++) {
      const r = real[b] ?? 0;
      const m = imag[b] ?? 0;
      powers[b] = (powers[b] ?? 0) + r * r + m * m;
    }
  }
  for (let b = 0; b <= n / 2; b++) powers[b] = (powers[b] ?? 0) / frames;
  return { powers, binHz };
}

/**
 * Share of total spectral energy inside [lowHz, highHz] (fatigue rule 2
 * caps 2–5 kHz at 15%). Returns 0 for a silent buffer.
 */
export function bandEnergyShare(
  samples: ArrayLike<number>,
  sampleRate: number,
  lowHz: number,
  highHz: number,
): number {
  const { powers, binHz } = meanPowerSpectrum(samples, sampleRate);
  let band = 0;
  let total = 0;
  for (let b = 1; b < powers.length; b++) {
    const freq = b * binHz;
    const energy = powers[b] ?? 0;
    total += energy;
    if (freq >= lowHz && freq <= highHz) band += energy;
  }
  return total <= 0 ? 0 : band / total;
}

/**
 * Inverse radix-2 FFT, in place over the real/imaginary arrays: the
 * forward transform conjugated (negated twiddle), scaled by 1/n. Only the
 * band-isolation helper below uses it.
 */
export function inverseFft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 0; i < n; i++) imag[i] = -(imag[i] ?? 0);
  forwardFft(real, imag);
  for (let i = 0; i < n; i++) {
    real[i] = (real[i] ?? 0) / n;
    imag[i] = -(imag[i] ?? 0) / n;
  }
}

/**
 * RMS level of the [lowHz, highHz] band of a time window in dBFS: the
 * window is zero-padded to whole FFT frames, each frame is Hann-windowed,
 * bins outside the band are zeroed, and the surviving band is inverse
 * transformed; frame RMS values average in energy. Windowing and framing
 * colour the answer slightly, so this is a reporting/metering helper —
 * gates compare its readings relatively (drop between windows), never
 * against an absolute spec number.
 */
export function bandRmsDb(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
  lowHz: number,
  highHz: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  const length = i1 - i0;
  if (length <= 0) return Number.NEGATIVE_INFINITY;
  const n = SPECTRUM_FFT_SIZE;
  const binHz = sampleRate / n;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  let energy = 0;
  let frames = 0;
  for (let base = 0; base < length; base += n) {
    for (let i = 0; i < n; i++) {
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      real[i] = (samples[base + i + i0] ?? 0) * hann;
      imag[i] = 0;
    }
    forwardFft(real, imag);
    for (let b = 0; b <= n / 2; b++) {
      const freq = b * binHz;
      if (freq < lowHz || freq > highHz) {
        real[b] = 0;
        imag[b] = 0;
        if (b > 0 && b < n / 2) {
          real[n - b] = 0;
          imag[n - b] = 0;
        }
      }
    }
    inverseFft(real, imag);
    let frameSum = 0;
    for (let i = 0; i < n; i++) {
      const v = real[i] ?? 0;
      frameSum += v * v;
    }
    energy += frameSum / n;
    frames += 1;
  }
  if (frames === 0) return Number.NEGATIVE_INFINITY;
  const level = 10 * Math.log10(Math.max(1e-30, energy / frames));
  return level <= -299 ? Number.NEGATIVE_INFINITY : level;
}

/**
 * Spectral centroid of a window in Hz: the energy-weighted mean bin.
 * Two windows whose centroids differ carry different spectral content —
 * the single-lane-modes distinction metric.
 */
export function spectralCentroid(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  if (i1 - i0 < SPECTRUM_FFT_SIZE) return 0;
  const window: number[] = [];
  for (let i = i0; i < i1; i++) window.push(samples[i] ?? 0);
  const { powers, binHz } = meanPowerSpectrum(window, sampleRate);
  let weighted = 0;
  let total = 0;
  for (let b = 1; b < powers.length; b++) {
    const energy = powers[b] ?? 0;
    weighted += b * binHz * energy;
    total += energy;
  }
  return total <= 0 ? 0 : weighted / total;
}

/**
 * Normalized autocorrelation at one lag (in samples) for a mono mix.
 * 1 is a perfect repeat; the p3-t04 drift suite calibrates the
 * fatigue-rule-4 bound (< 0.9) against this same formula.
 */
export function autocorrelationAtLag(samples: ArrayLike<number>, lag: number): number {
  const n = samples.length;
  if (lag <= 0 || lag >= n) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i] ?? 0;
  mean /= n;
  let denominator = 0;
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    const v = (samples[i] ?? 0) - mean;
    denominator += v * v;
    if (i + lag < n) numerator += v * ((samples[i + lag] ?? 0) - mean);
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Block-averaged downsampling to `targetRate` Hz. Rule-4 repetition is a
 * slow-envelope question, so the 60 s render is analysed at a low rate
 * where multi-second lags stay cheap without changing the answer.
 */
export function downsampleMean(
  samples: ArrayLike<number>,
  sampleRate: number,
  targetRate: number,
): Float32Array {
  const block = Math.max(1, Math.round(sampleRate / targetRate));
  const n = Math.floor(samples.length / block);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < block; k++) sum += samples[i * block + k] ?? 0;
    out[i] = sum / block;
  }
  return out;
}

/**
 * Maximum absolute autocorrelation over lags at or above `minLagS`
 * (fatigue rule 4: below 0.9 at any lag ≥ 5 s proves the render moves).
 * This is the p3-t04-calibrated metric, shared verbatim: block-average to
 * 100 Hz, integer lags, absolute value. Cross-task consistency beats a
 * per-task variant — the 60 s drift unit suite calibrates this same
 * formula against the < 0.9 bound, so QA reuses it rather than inventing
 * a second rule-4 number. The lag window covers lags ≥ 5 s up to the
 * caller-supplied cap (the routine render scans to 30 s); a mix with a
 * slow deterministic repeat inside the cap would score high, by design.
 */
export function maxAutocorrelation(
  samples: ArrayLike<number>,
  sampleRate: number,
  minLagS: number,
  maxLagS?: number,
  stepS = 1,
): number {
  const slow = downsampleMean(samples, sampleRate, 100);
  const slowRate = 100;
  const minLag = Math.round(minLagS * slowRate);
  const maxLag = Math.min(
    slow.length - 1,
    Math.round((maxLagS ?? slow.length / slowRate / 2) * slowRate),
  );
  let max = 0;
  for (let lag = minLag; lag <= maxLag; lag += Math.max(1, Math.round(stepS * slowRate))) {
    max = Math.max(max, Math.abs(autocorrelationAtLag(slow, lag)));
  }
  return max;
}

/**
 * Window regularity: short-lag autocorrelation of the block-energy
 * envelope of a time window. HOW TO READ IT: the window is averaged into
 * 100 ms blocks of mean-square energy and the lag-4 (400 ms)
 * autocorrelation is reported. A window whose short-time energy repeats
 * on a sub-second grid (a metronomic pulse, a two-note alternation)
 * scores higher than one whose energy wanders. Block/lag choice is
 * calibrated, not principled: 100 ms blocks resolve the scene's ~3 s
 * pulse swell, and lag-4 (400 ms) sits where metronomic and wandering
 * textures separate — lag-2 (200 ms) aliases a 5 Hz gate against its own
 * period and scores a perfect pulse train near −1. This is a RELATIVE
 * meter — gates compare two windows of the same render (early vs late),
 * never an absolute number, because the absolute score depends on the
 * scene's pulse period and register. Returns 0 for windows shorter
 * than ~4 s.
 */
export function windowRegularity(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  const length = i1 - i0;
  const blockS = 0.1;
  const block = Math.max(1, Math.round(blockS * sampleRate));
  const nb = Math.floor(length / block);
  if (nb < 40) return 0;
  const envelope: number[] = [];
  for (let b = 0; b < nb; b++) {
    let sum = 0;
    for (let k = 0; k < block; k++) {
      const v = samples[i0 + b * block + k] ?? 0;
      sum += v * v;
    }
    envelope.push(sum / block);
  }
  return autocorrelationAtLag(envelope, 4);
}

/**
 * Mixes stereo channels to mono. Averaged (not summed): a dual-mono
 * signal measures the same RMS as either channel, so level bounds read
 * the same on mono and stereo renders. The gesture offline renderer sums
 * instead — that surface is p3-t03's, not this one.
 */
export function toMono(left: ArrayLike<number>, right: ArrayLike<number>): Float32Array {
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ((left[i] ?? 0) + (right[i] ?? 0)) / 2;
  return out;
}

/** Converts dBFS to a linear amplitude ratio. */
export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/** Converts a linear amplitude ratio to dBFS (-Infinity at silence). */
export function linearToDb(linear: number): number {
  return linear <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(linear);
}

// A-weighted loudness, flux onsets, and report-only musical diagnostics
// (p3-t11). What these are for: measuring what the spec claims —
// perceptual lane comparison, gesture onsets, fade trajectories, and
// listening-support numbers — without touching voices or mapping. What
// they must not do: gate anything by themselves; gates live in
// e2e/audio-qa.spec.ts and every diagnostic below is reported, not gated.

/** Reference numerator of the A-weighting curve at 1 kHz. */
const RA_1000 = (() => {
  const f2 = 1000 * 1000;
  return (
    (12194 ** 2 * f2 ** 2) /
    ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2))
  );
})();

/**
 * A-weighting power weight at one frequency (1.0 at 1 kHz, 0 at DC).
 * The standard curve: deaf to lows, hottest at 2–5 kHz — the ear's
 * weighting, so a low pad voice and a mid mallet at equal RMS read
 * differently, as they sound.
 */
export function aWeightPower(freqHz: number): number {
  if (freqHz <= 0) return 0;
  const f2 = freqHz * freqHz;
  const ra =
    (12194 ** 2 * f2 ** 2) /
    ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  const ratio = ra / RA_1000;
  return ratio * ratio;
}

/**
 * A-weighted RMS level of a window in dB (silence is -Infinity). A 1 kHz
 * sine reads its RMS; a 100 Hz sine reads ~19 dB below its RMS. Lane
 * solos report this ALONGSIDE raw RMS: when both agree on the gap, the
 * gap is a seating defect, not a meter artifact.
 */
export function loudnessDb(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  if (i1 - i0 < SPECTRUM_FFT_SIZE) return Number.NEGATIVE_INFINITY;
  const window: number[] = [];
  let meanSquare = 0;
  for (let i = i0; i < i1; i++) {
    const v = samples[i] ?? 0;
    window.push(v);
    meanSquare += v * v;
  }
  meanSquare /= i1 - i0;
  if (meanSquare <= 0) return Number.NEGATIVE_INFINITY;
  const { powers, binHz } = meanPowerSpectrum(window, sampleRate);
  let weighted = 0;
  let total = 0;
  for (let b = 1; b < powers.length; b++) {
    const energy = powers[b] ?? 0;
    total += energy;
    weighted += energy * aWeightPower(b * binHz);
  }
  if (total <= 0) return Number.NEGATIVE_INFINITY;
  return 10 * Math.log10(meanSquare * (weighted / total));
}

/** Next power of two at or above `n`. */
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Normalized spectral flux per Hann frame: the half-wave-rectified L1
 * change of successive magnitude spectra, divided by the current frame's
 * energy. A note onset spikes toward 1; steady texture sits near 0.
 * Returns one value per frame starting at `fromS` (the first is 0).
 */
export function fluxSeries(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
  frameS: number,
): Float64Array {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  const frameLen = Math.max(64, Math.round(frameS * sampleRate));
  const count = Math.floor((i1 - i0) / frameLen);
  const out = new Float64Array(count);
  if (count === 0) return out;
  const n = nextPow2(frameLen);
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  let previous: Float64Array | null = null;
  for (let f = 0; f < count; f++) {
    for (let i = 0; i < n; i++) {
      const sample = i < frameLen ? (samples[i0 + f * frameLen + i] ?? 0) : 0;
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frameLen);
      real[i] = sample * hann;
      imag[i] = 0;
    }
    forwardFft(real, imag);
    const mags = new Float64Array(n / 2 + 1);
    let energy = 0;
    for (let b = 0; b <= n / 2; b++) {
      const r = real[b] ?? 0;
      const m = imag[b] ?? 0;
      mags[b] = Math.sqrt(r * r + m * m);
      energy += r * r + m * m;
    }
    if (previous !== null && energy > 0) {
      let rise = 0;
      for (let b = 0; b <= n / 2; b++) {
        const delta = (mags[b] ?? 0) - (previous[b] ?? 0);
        if (delta > 0) rise += delta * delta;
      }
      out[f] = rise / energy;
    }
    previous = mags;
  }
  return out;
}

/**
 * First flux rise-edge at or above `threshold`: the earliest frame whose
 * flux crosses from below to at-or-above, as seconds from render start.
 * A gesture onset is a rise; the sustain tail it hands over to is a
 * peak — so the locator takes the FIRST edge in the window, never the
 * maximum. Returns -1 when nothing crosses (silence or a swell with no
 * attack inside the window).
 */
export function firstFluxOnset(
  flux: ArrayLike<number>,
  fromS: number,
  frameS: number,
  threshold: number,
): number {
  for (let i = 0; i < flux.length; i++) {
    const v = flux[i] ?? 0;
    const prev = i === 0 ? 0 : (flux[i - 1] ?? 0);
    if (v >= threshold && prev < threshold) return fromS + i * frameS;
  }
  return -1;
}

/**
 * Pitch-class (chroma) entropy of a window in bits (0 for silence, max
 * ~3.58 for a flat twelve-way spread). Bins at or above 55 Hz fold onto
 * the twelve semitones relative to A; a single sustained tone scores
 * near 0, a wandering pentatonic line scores higher. Report-only: it
 * sketches harmonic diversity over minutes for listening, it names no
 * key and gates nothing.
 */
export function chromaEntropy(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  if (i1 - i0 < SPECTRUM_FFT_SIZE) return 0;
  const window: number[] = [];
  for (let i = i0; i < i1; i++) window.push(samples[i] ?? 0);
  const { powers, binHz } = meanPowerSpectrum(window, sampleRate);
  const classes = new Float64Array(12);
  let total = 0;
  for (let b = 1; b < powers.length; b++) {
    const freq = b * binHz;
    if (freq < 55) continue;
    const energy = powers[b] ?? 0;
    const cls = ((Math.round(12 * Math.log2(freq / 440)) % 12) + 12) % 12;
    classes[cls] = (classes[cls] ?? 0) + energy;
    total += energy;
  }
  if (total <= 0) return 0;
  let entropy = 0;
  for (let c = 0; c < 12; c++) {
    const p = (classes[c] ?? 0) / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * The strongest pitch class (semitones above D) in a window: the power at
 * every equal-tempered note from A1 (55 Hz) up to `maxHz`, measured at the
 * note's exact frequency (Goertzel), summed per class. Below about 200 Hz
 * the mix is the drone and the field's ground voice, so this names the
 * tonal centre the floor sits on (owner direction 2026-10-29: the key
 * moves). Exact frequencies, not FFT bins: at the analysis FFT size a bin
 * is wider than a semitone down there, and D2 would read as C#.
 * Returns −1 for an empty window.
 */
export function dominantPitchClass(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
  maxHz: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  if (i1 <= i0) return -1;
  const classes = new Float64Array(12);
  for (let midi = 33; 440 * 2 ** ((midi - 69) / 12) <= maxHz; midi++) {
    const coeff = 2 * Math.cos((2 * Math.PI * 440 * 2 ** ((midi - 69) / 12)) / sampleRate);
    let prev = 0;
    let prev2 = 0;
    for (let i = i0; i < i1; i++) {
      const next = (samples[i] ?? 0) + coeff * prev - prev2;
      prev2 = prev;
      prev = next;
    }
    const cls = (((midi - 2) % 12) + 12) % 12;
    classes[cls] = (classes[cls] ?? 0) + prev * prev + prev2 * prev2 - coeff * prev * prev2;
  }
  let best = 0;
  for (let c = 1; c < 12; c++) if ((classes[c] ?? 0) > (classes[best] ?? 0)) best = c;
  return best;
}

/**
 * Contour recurrence: the peak normalized autocorrelation of the
 * 1 s-block RMS contour (in dB, mean-removed) over lags 10–30 s.
 * A render whose minute-scale shape repeats scores toward 1; one that
 * keeps moving scores low. Report-only motif/recurrence sketch —
 * distinct from rule 4, which reads the fast envelope, not the minute
 * contour. Returns 0 for windows under ~40 s.
 */
export function contourRecurrence(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  const block = Math.max(1, Math.round(sampleRate));
  const nb = Math.floor((i1 - i0) / block);
  if (nb < 40) return 0;
  const contour: number[] = [];
  for (let b = 0; b < nb; b++) {
    let sum = 0;
    for (let k = 0; k < block; k++) {
      const v = samples[i0 + b * block + k] ?? 0;
      sum += v * v;
    }
    contour.push(10 * Math.log10(Math.max(1e-12, sum / block)));
  }
  let best = 0;
  for (let lag = 10; lag <= Math.min(30, nb - 1); lag++) {
    best = Math.max(best, Math.abs(autocorrelationAtLag(contour, lag)));
  }
  return best;
}

/**
 * Density variation: the coefficient of variation (std/mean) of 1 s-block
 * energies across the window. A flat bed scores ~0; a render that
 * breathes between sparse and busy scores higher. Report-only.
 */
export function densityVariation(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
): number {
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  const block = Math.max(1, Math.round(sampleRate));
  const nb = Math.floor((i1 - i0) / block);
  if (nb < 4) return 0;
  let mean = 0;
  const energies: number[] = [];
  for (let b = 0; b < nb; b++) {
    let sum = 0;
    for (let k = 0; k < block; k++) {
      const v = samples[i0 + b * block + k] ?? 0;
      sum += v * v;
    }
    const e = sum / block;
    energies.push(e);
    mean += e;
  }
  mean /= nb;
  if (mean <= 0) return 0;
  let variance = 0;
  for (const e of energies) variance += (e - mean) * (e - mean);
  return Math.sqrt(variance / nb) / mean;
}

/**
 * Long-term spectral change between the first and second half of a
 * window: each half's centroid plus the cosine distance of the two mean
 * power spectra. A static drone scores ~0 distance; an evolving
 * composition scores higher. Report-only timbral-change sketch.
 */
export function spectralDrift(
  samples: ArrayLike<number>,
  sampleRate: number,
  fromS: number,
  toS: number,
): { centroidFirstHz: number; centroidSecondHz: number; cosineDistance: number } {
  const mid = (fromS + toS) / 2;
  const i0 = Math.max(0, Math.round(fromS * sampleRate));
  const im = Math.min(samples.length, Math.round(mid * sampleRate));
  const i1 = Math.min(samples.length, Math.round(toS * sampleRate));
  const empty = { centroidFirstHz: 0, centroidSecondHz: 0, cosineDistance: 0 };
  if (im - i0 < SPECTRUM_FFT_SIZE || i1 - im < SPECTRUM_FFT_SIZE) return empty;
  const first: number[] = [];
  const second: number[] = [];
  for (let i = i0; i < im; i++) first.push(samples[i] ?? 0);
  for (let i = im; i < i1; i++) second.push(samples[i] ?? 0);
  const a = meanPowerSpectrum(first, sampleRate);
  const b = meanPowerSpectrum(second, sampleRate);
  let dot = 0;
  let na = 0;
  let nb = 0;
  let wa = 0;
  let ta = 0;
  let wb = 0;
  let tb = 0;
  for (let k = 1; k < a.powers.length; k++) {
    const pa = a.powers[k] ?? 0;
    const pb = b.powers[k] ?? 0;
    dot += pa * pb;
    na += pa * pa;
    nb += pb * pb;
    wa += k * a.binHz * pa;
    ta += pa;
    wb += k * b.binHz * pb;
    tb += pb;
  }
  const denom = Math.sqrt(na * nb);
  return {
    centroidFirstHz: ta <= 0 ? 0 : wa / ta,
    centroidSecondHz: tb <= 0 ? 0 : wb / tb,
    cosineDistance: denom <= 0 ? 0 : 1 - dot / denom,
  };
}
