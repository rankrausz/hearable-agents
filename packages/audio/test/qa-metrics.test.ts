// packages/audio/test/qa-metrics.test.ts — behaviour tests for the QA
// buffer-analysis functions: each metric answers its named question on
// synthetic signals (level, peaks, clicks, DC, band shares, repetition,
// centroid), independent of any browser render.

import { describe, expect, it } from "vitest";
import {
  autocorrelationAtLag,
  aWeightPower,
  bandEnergyShare,
  bandRmsDb,
  chromaEntropy,
  contourRecurrence,
  dcOffset,
  densityVariation,
  downsampleMean,
  firstFluxOnset,
  fluxSeries,
  forwardFft,
  inverseFft,
  loudnessDb,
  maxAutocorrelation,
  maxSampleJump,
  meanPowerSpectrum,
  peakDb,
  rmsDb,
  spectralCentroid,
  spectralDrift,
  toMono,
  windowPeakDb,
  windowRegularity,
  windowRmsDb,
} from "../src/qa/metrics.js";
import { pianoSamples } from "./piano-pcm.js";

function sine(freqHz: number, sampleRate: number, seconds: number, gain = 0.5): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = gain * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

describe("qa level metrics", () => {
  it("reports silence as -Infinity RMS and peak", () => {
    const silent = new Float32Array(44100);
    expect(rmsDb(silent)).toBe(Number.NEGATIVE_INFINITY);
    expect(peakDb(silent)).toBe(Number.NEGATIVE_INFINITY);
    expect(windowRmsDb(silent, 44100, 0, 1)).toBe(Number.NEGATIVE_INFINITY);
    expect(windowPeakDb(silent, 44100, 0, 1)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("measures a sine's RMS 3 dB below its peak", () => {
    const tone = sine(440, 44100, 1, 0.5);
    expect(peakDb(tone)).toBeCloseTo(20 * Math.log10(0.5), 1);
    expect(rmsDb(tone)).toBeCloseTo(peakDb(tone) - 3.01, 0.2);
  });

  it("windows to the requested seconds", () => {
    const tone = sine(440, 1000, 4, 0.5);
    const silent = new Float32Array(4000);
    expect(windowRmsDb(tone, 1000, 0, 1)).toBeCloseTo(rmsDb(tone), 5);
    expect(windowRmsDb(silent, 1000, 1, 2)).toBe(Number.NEGATIVE_INFINITY);
    expect(windowRmsDb(tone, 1000, 2, 2)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("sees a step as a large sample jump and a ramp as a small one", () => {
    const stepped = new Float32Array([0, 0, 1, 1]);
    const silent = new Float32Array(4);
    expect(maxSampleJump(stepped, silent)).toBeCloseTo(1, 5);
    const ramped = sine(440, 44100, 1, 0.1);
    expect(maxSampleJump(ramped, ramped)).toBeLessThan(0.3);
  });

  it("measures DC as the signal mean", () => {
    const offset = new Float32Array(1000).fill(0.005);
    expect(dcOffset(offset)).toBeCloseTo(0.005, 6);
    expect(dcOffset(new Float32Array(1000))).toBe(0);
    expect(dcOffset(new Float32Array(0))).toBe(0);
  });

  it("mixes stereo to averaged mono", () => {
    const mono = toMono(new Float32Array([0.25, 0.5]), new Float32Array([0.25, -0.25]));
    expect(mono[0]).toBeCloseTo(0.25, 6);
    expect(mono[1]).toBeCloseTo(0.125, 6);
  });

  it("measures dual-mono at the same RMS as one channel", () => {
    const tone = sine(440, 44100, 1, 0.5);
    expect(rmsDb(toMono(tone, tone))).toBeCloseTo(rmsDb(tone), 5);
  });
});

describe("qa spectral metrics", () => {
  it("concentrates a sine's FFT energy at its own bin", () => {
    const tone = sine(440, 44100, 1);
    const { powers, binHz } = meanPowerSpectrum(tone, 44100);
    const atTone = powers[Math.round(440 / binHz)] ?? 0;
    const farAway = powers[Math.round(3000 / binHz)] ?? 0;
    expect(atTone).toBeGreaterThan(farAway * 10);
  });

  it("round-trips an FFT impulse", () => {
    const real = new Float64Array([1, 0, 0, 0, 0, 0, 0, 0]);
    const imag = new Float64Array(8);
    forwardFft(real, imag);
    for (let i = 0; i < 8; i++) expect(real[i]).toBeCloseTo(1, 8);
  });

  it("inverts the forward transform sample-for-sample", () => {
    const real = new Float64Array([0.5, -0.25, 0.125, 0.75, -0.5, 0.1, 0.9, -0.3]);
    const imag = new Float64Array(8);
    const expected = [...real];
    forwardFft(real, imag);
    inverseFft(real, imag);
    for (let i = 0; i < 8; i++) {
      expect(real[i]).toBeCloseTo(expected[i] ?? 0, 8);
      expect(imag[i]).toBeCloseTo(0, 8);
    }
  });

  it("reads a tone's band level near its full level and far from it elsewhere", () => {
    const tone = sine(440, 44100, 2, 0.5);
    const inBand = bandRmsDb(tone, 44100, 0, 2, 300, 600);
    const outOfBand = bandRmsDb(tone, 44100, 0, 2, 2000, 3000);
    // Hann + brick-wall framing costs a few dB even in-band; the gate is
    // the 20 dB contrast against the out-of-band floor, not the absolute.
    expect(inBand).toBeGreaterThan(rmsDb(tone) - 6);
    expect(outOfBand).toBeLessThan(inBand - 20);
  });

  it("reads silence as -Infinity band level and clamps empty windows", () => {
    expect(bandRmsDb(new Float32Array(44100), 44100, 0, 1, 300, 600)).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(bandRmsDb(sine(440, 44100, 1), 44100, 0.5, 0.5, 300, 600)).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it("averages identical blocks unchanged", () => {
    const tone = sine(440, 8000, 2, 0.5);
    const down = downsampleMean(tone, 8000, 1000);
    expect(down.length).toBe(Math.floor(tone.length / 8));
    expect(rmsDb(down)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
  });

  it("gives a mid-band tone a mid-band share near one and a far-band share near zero", () => {
    const tone = sine(3000, 44100, 4, 0.5);
    expect(bandEnergyShare(tone, 44100, 2000, 5000)).toBeGreaterThan(0.5);
    expect(bandEnergyShare(tone, 44100, 8000, 12000)).toBeLessThan(0.15);
  });

  it("gives broadband noise a 2–5 kHz share well under the fatigue cap", () => {
    const noise = new Float32Array(44100 * 2);
    let seed = 123456789;
    for (let i = 0; i < noise.length; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0;
      noise[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
    }
    const share = bandEnergyShare(noise, 44100, 2000, 5000);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(0.5);
  });

  it("returns zero share for silence", () => {
    expect(bandEnergyShare(new Float32Array(44100), 44100, 2000, 5000)).toBe(0);
  });

  it("places the centroid near a sine's frequency", () => {
    const tone = sine(880, 44100, 2, 0.5);
    const centroid = spectralCentroid(tone, 44100, 0, 2);
    expect(centroid).toBeGreaterThan(440);
    expect(centroid).toBeLessThan(1760);
  });

  it("separates low and high tones by centroid", () => {
    const low = sine(220, 44100, 2, 0.5);
    const high = sine(3520, 44100, 2, 0.5);
    expect(spectralCentroid(high, 44100, 0, 2)).toBeGreaterThan(
      spectralCentroid(low, 44100, 0, 2) * 2,
    );
  });
});

describe("qa repetition metrics", () => {
  it("autocorrelates a periodic tone near one at its period", () => {
    const rate = 1000;
    const tone = sine(50, rate, 4, 0.5);
    expect(autocorrelationAtLag(tone, 20)).toBeCloseTo(1, 1);
    expect(autocorrelationAtLag(tone, 10)).toBeCloseTo(-1, 0.5);
  });

  it("scores silence and out-of-range lags at zero", () => {
    const silent = new Float32Array(1000);
    expect(autocorrelationAtLag(silent, 10)).toBe(0);
    expect(autocorrelationAtLag(sine(50, 1000, 1), 0)).toBe(0);
    expect(autocorrelationAtLag(sine(50, 1000, 1), 1000)).toBe(0);
  });

  it("flags a repeating envelope above 0.9 and noise below it", () => {
    const rate = 1000;
    const n = rate * 60;
    const repeating = new Float32Array(n);
    for (let i = 0; i < n; i++) repeating[i] = Math.sin((2 * Math.PI * 0.2 * i) / rate);
    expect(maxAutocorrelation(repeating, rate, 5, 10, 1)).toBeGreaterThan(0.9);
    const noise = new Float32Array(n);
    let seed = 987654321;
    for (let i = 0; i < n; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0;
      noise[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
    }
    expect(maxAutocorrelation(noise, rate, 5, 10, 1)).toBeLessThan(0.9);
  });

  it("scores a metronomic pulse train more regular than a wandering one", () => {
    // Gated tone with steady gates (regular) vs gates whose ON amplitude
    // is re-randomized per 200 ms pulse cycle (wandering): windowRegularity
    // reads the RENDERED envelope, not input params. Jitter must be slow
    // (per-cycle) to survive the 100 ms envelope averaging.
    const rate = 44100;
    const seconds = 20;
    const n = rate * seconds;
    const regular = new Float32Array(n);
    const wandering = new Float32Array(n);
    let wobble = 123456789;
    let cycleGain = 1;
    const cycleSamples = Math.round(rate * 0.2);
    for (let i = 0; i < n; i++) {
      if (i % cycleSamples === 0) {
        wobble = (Math.imul(wobble, 1103515245) + 12345) | 0;
        cycleGain = 0.2 + ((wobble >>> 0) / 4294967296) * 0.8;
      }
      const gate = Math.sin((2 * Math.PI * 5 * i) / rate) > 0.7 ? 1 : 0.05;
      regular[i] = gate * Math.sin((2 * Math.PI * 440 * i) / rate);
      wandering[i] = gate * cycleGain * Math.sin((2 * Math.PI * 440 * i) / rate);
    }
    const regularScore = windowRegularity(regular, rate, 0, seconds);
    const wanderingScore = windowRegularity(wandering, rate, 0, seconds);
    expect(regularScore).toBeGreaterThan(wanderingScore + 0.05);
  });

  it("returns 0 for windows too short to hold an envelope", () => {
    expect(windowRegularity(sine(440, 44100, 2, 0.5), 44100, 0, 2)).toBe(0);
    expect(windowRegularity(sine(440, 44100, 5, 0.5), 44100, 0, 3)).toBe(0);
  });
});

describe("qa loudness metrics", () => {
  it("weights 1 kHz at unity and lows near zero", () => {
    expect(aWeightPower(1000)).toBeCloseTo(1, 3);
    expect(aWeightPower(0)).toBe(0);
    expect(aWeightPower(100)).toBeLessThan(0.05);
    expect(aWeightPower(3000)).toBeGreaterThan(aWeightPower(100));
  });

  it("reads a 1 kHz sine's loudness at its RMS and a 100 Hz sine far below", () => {
    const high = sine(1000, 44100, 2, 0.5);
    const low = sine(100, 44100, 2, 0.5);
    expect(loudnessDb(high, 44100, 0, 2)).toBeCloseTo(rmsDb(high), 1);
    expect(loudnessDb(low, 44100, 0, 2)).toBeLessThan(rmsDb(low) - 10);
  });

  it("reads silence as -Infinity loudness", () => {
    expect(loudnessDb(new Float32Array(44100), 44100, 0, 1)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("agrees with raw RMS on which of two same-register tones is louder", () => {
    const soft = sine(3000, 44100, 2, 0.2);
    const loud = sine(3000, 44100, 2, 0.5);
    expect(loudnessDb(loud, 44100, 0, 2)).toBeGreaterThan(loudnessDb(soft, 44100, 0, 2) + 5);
  });
});

describe("qa onset and musical diagnostics", () => {
  it("spikes flux at a note start and rests on steady texture", () => {
    const rate = 44100;
    const steady = sine(440, rate, 2, 0.5);
    const started = new Float32Array(rate * 2);
    for (let i = 0; i < started.length; i++) {
      const gain = i < rate ? 0 : Math.min(1, (i - rate) / (0.01 * rate));
      started[i] = gain * Math.sin((2 * Math.PI * 660 * i) / rate);
    }
    const calm = fluxSeries(steady, rate, 0, 2, 0.05);
    const onset = fluxSeries(started, rate, 0, 2, 0.05);
    let calmMax = 0;
    for (const v of calm) calmMax = Math.max(calmMax, v);
    let onsetMax = 0;
    for (const v of onset) onsetMax = Math.max(onsetMax, v);
    expect(onsetMax).toBeGreaterThan(calmMax * 2);
  });

  it("takes the first flux edge, never the later peak", () => {
    expect(firstFluxOnset([0.1, 0.5, 0.2, 0.9], 10, 0.05, 0.4)).toBeCloseTo(10.05, 5);
    expect(firstFluxOnset([0.1, 0.1, 0.1], 10, 0.05, 0.4)).toBe(-1);
  });

  it("scores a single tone near zero chroma entropy and a chord higher", () => {
    const rate = 44100;
    const tone = sine(440, rate, 4, 0.5);
    const chord = new Float32Array(rate * 4);
    for (const freq of [293.66, 369.99, 440, 587.33]) {
      for (let i = 0; i < chord.length; i++) {
        chord[i] = (chord[i] ?? 0) + 0.25 * Math.sin((2 * Math.PI * freq * i) / rate);
      }
    }
    expect(chromaEntropy(tone, rate, 0, 4)).toBeLessThan(1);
    expect(chromaEntropy(chord, rate, 0, 4)).toBeGreaterThan(chromaEntropy(tone, rate, 0, 4) + 0.5);
    expect(chromaEntropy(new Float32Array(rate * 2), rate, 0, 2)).toBe(0);
  });

  it("scores a repeating minute contour higher than a one-way ramp", () => {
    const rate = 1000;
    const seconds = 60;
    const n = rate * seconds;
    const repeating = new Float32Array(n);
    const ramp = new Float32Array(n);
    let seed = 424242;
    const noise = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0;
      return (((seed >>> 0) / 4294967296) * 2 - 1) * 0.05;
    };
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      repeating[i] = Math.sin((2 * Math.PI * t) / 20) + noise();
      ramp[i] = t / seconds + noise();
    }
    expect(contourRecurrence(repeating, rate, 0, seconds)).toBeGreaterThan(
      contourRecurrence(ramp, rate, 0, seconds),
    );
    expect(contourRecurrence(sine(440, rate, 10), rate, 0, 10)).toBe(0);
  });

  it("scores a breathing render more variable than a flat bed", () => {
    const rate = 8000;
    const seconds = 20;
    const n = rate * seconds;
    const flat = new Float32Array(n).fill(0.3);
    const breathing = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      breathing[i] = 0.3 * (0.2 + 0.8 * (0.5 + 0.5 * Math.sin((2 * Math.PI * i) / (rate * 10))));
    }
    expect(densityVariation(breathing, rate, 0, seconds)).toBeGreaterThan(
      densityVariation(flat, rate, 0, seconds) + 0.2,
    );
  });

  it("reads near-zero drift for a static tone and positive drift for a change", () => {
    const rate = 44100;
    const steady = sine(440, rate, 20, 0.5);
    const changed = new Float32Array(rate * 20);
    for (let i = 0; i < changed.length; i++) {
      const freq = i < changed.length / 2 ? 220 : 880;
      changed[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
    }
    expect(spectralDrift(steady, rate, 0, 20).cosineDistance).toBeLessThan(0.05);
    const drifted = spectralDrift(changed, rate, 0, 20);
    expect(drifted.cosineDistance).toBeGreaterThan(0.2);
    expect(drifted.centroidSecondHz).toBeGreaterThan(drifted.centroidFirstHz * 2);
  });
});

describe("qa onset threshold calibration", () => {
  // The QA gate's onset definition (first flux rise-edge at threshold 0.4,
  // frame 2048/sr) is calibrated HERE, deterministically in Node — not in
  // a spec comment. The isolated question plan must cross exactly at its
  // note attacks, and a smooth texture swell must not cross at all, so the
  // threshold measures the gesture's attack, not the texture's movement.
  const onsetFrameS = (sampleRate: number): number => 2048 / sampleRate;

  function monoOf(result: { left: Float32Array; right: Float32Array }): Float32Array {
    const out = new Float32Array(result.left.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = ((result.left[i] ?? 0) + (result.right[i] ?? 0)) / 2;
    }
    return out;
  }

  it("finds the isolated question plan's 0.5 s note attack at threshold 0.4 and only there", async () => {
    const { gestureEvents, renderGesturePlan } = await import("../src/gestures/index.js");
    const sampleRate = 48000;
    const frameS = onsetFrameS(sampleRate);
    const events = gestureEvents({ laneIndex: 1, gesture: "question", at: 0 }, 0.6, 0.5);
    const mono = monoOf(renderGesturePlan(events, 4, { sampleRate, pianoSamples }));
    const flux = fluxSeries(mono, sampleRate, 0, 3.5, frameS);
    // Real recorded-piano onset, with the same 0.4 threshold and a silent lead-in.
    const onset = firstFluxOnset(flux, 0, frameS, 0.4);
    expect(onset).toBeCloseTo(Math.floor(0.5 / frameS) * frameS, 8);
    expect(onset).toBeLessThan(0.7);
  });

  it("holds a smooth texture swell below 0.4 while a louder swell crosses 0.3 first", () => {
    // Smooth-wandering texture (slow FM + slow AM, no beating pair, no
    // note onsets) under a fast Gaussian swell voice: a moderate swell
    // peaks at flux 0.35 — it fires 0.3 where 0.4 stays silent — and a
    // louder swell crosses both. That is the calibration: 0.3 measures
    // the texture's own swells, 0.4 lets them pass and still hears real
    // attacks (previous test).
    const sampleRate = 48000;
    const frameS = onsetFrameS(sampleRate);
    const fromS = 9.5;
    const toS = 13;
    const renderMix = (swellAmp: number): Float32Array => {
      const n = sampleRate * 14;
      const out = new Float32Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        phase += (2 * Math.PI * (220 + 3 * Math.sin(2 * Math.PI * 0.2 * t))) / sampleRate;
        const texture = 0.3 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.3 * t)) * Math.sin(phase);
        const swell = Math.exp(-((t - 12) ** 2) / (2 * 0.05 ** 2));
        out[i] = texture + swellAmp * swell * Math.sin(2 * Math.PI * 196 * t);
      }
      return out;
    };
    const moderate = fluxSeries(renderMix(1), sampleRate, fromS, toS, frameS);
    expect(firstFluxOnset(moderate, fromS, frameS, 0.3)).toBeGreaterThanOrEqual(10);
    expect(firstFluxOnset(moderate, fromS, frameS, 0.4)).toBe(-1);
    const loud = fluxSeries(renderMix(2), sampleRate, fromS, toS, frameS);
    expect(firstFluxOnset(loud, fromS, frameS, 0.3)).toBeGreaterThanOrEqual(10);
    expect(firstFluxOnset(loud, fromS, frameS, 0.4)).toBeGreaterThanOrEqual(10);
  });
});

describe("dominant low pitch class", () => {
  it("names D for a D2 + D3 floor and F# for an F#2 + F#3 floor, despite coarse low bins", async () => {
    const { dominantPitchClass } = await import("../src/qa/metrics.js");
    const sampleRate = 48000;
    const tone = (hz: readonly number[]): Float32Array => {
      const out = new Float32Array(sampleRate * 4);
      for (let i = 0; i < out.length; i++) {
        out[i] = hz.reduce((sum, f) => sum + 0.1 * Math.sin((2 * Math.PI * f * i) / sampleRate), 0);
      }
      return out;
    };
    expect(dominantPitchClass(tone([73.42, 146.83]), sampleRate, 0, 4, 200)).toBe(0);
    expect(dominantPitchClass(tone([92.5, 185]), sampleRate, 0, 4, 200)).toBe(4);
    expect(dominantPitchClass(tone([]), sampleRate, 1, 1, 200)).toBe(-1);
  });
});
