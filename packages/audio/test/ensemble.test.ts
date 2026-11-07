// packages/audio/test/ensemble.test.ts — behaviour tests for the p5-t01
// ensemble A/B prototype. What this is for: proving the palette stays in
// key and in register with small adjacent moves, the independent schedule
// is seeded-deterministic and state-blind, the hybrid eligibility fires on
// sustained change/fresh progress (never held levels or non-routine
// lanes), arbitration enforces one move at a time with holds/cooldowns,
// and every voiced envelope ramps (no steps). What it must not do: import
// Tone, render audio, or judge sound — audibility belongs to QA renders
// and the owner's ears.

import { describe, expect, it } from "vitest";
import { CROSSFADE_MID_GAIN } from "../src/apply.js";
import {
  AB_CUE_LANE,
  AB_RESOLVE_AT_S,
  AB_SEED,
  AB_SLICE_S,
  AB_WAITING_AT_S,
  abCueEvents,
  abTimeline,
  candidatesForLane,
  ENSEMBLE_COOLDOWN_S,
  ENSEMBLE_MIN_HOLD_S,
  ENSEMBLE_SLICE_S,
  type EnsembleLaneReading,
  hybridEligibility,
  hybridSchedule,
  independentMoves,
  isInKey,
  isInRegister,
  lanesAt,
  ROUTINE_SUSTAIN_GAIN,
  startPitchForLane,
  stepPitch,
  sustainedVoiceEventsForPitch,
  voiceFreqsForMove,
} from "../src/ensemble/index.js";
import {
  driveScenario,
  estimatePitch,
  renderGesturePlan,
  scenarioFor,
} from "../src/gestures/index.js";
import { midiToFrequency } from "../src/graph/index.js";
import { maxSampleJump, spectralCentroid, windowRmsDb } from "../src/qa/metrics.js";
import { RAMP_TIMES } from "../src/ramps.js";

function readingsAt(overrides: Partial<EnsembleLaneReading> = {}): EnsembleLaneReading[] {
  return [0, 1, 2].map((laneIndex) => ({
    laneIndex,
    activity: 0.65,
    dominantMode: 0.65,
    progress: 0.35,
    progressAtS: 0,
    routine: true,
    ...overrides,
  }));
}

function pitchFor(lane: number, index: number): number {
  const candidates = candidatesForLane(lane);
  return candidates[index % candidates.length] ?? startPitchForLane(lane);
}

describe("ensemble palette", () => {
  it("holds three D-pentatonic candidates inside each lane register", () => {
    for (let lane = 0; lane < 3; lane += 1) {
      const candidates = candidatesForLane(lane);
      expect(candidates).toHaveLength(3);
      for (const midi of candidates) {
        expect(isInKey(midi)).toBe(true);
        expect(isInRegister(midi, lane)).toBe(true);
      }
      expect(isInKey(startPitchForLane(lane))).toBe(true);
    }
  });

  it("steps adjacently by at most three semitones and holds on unknown pitches", () => {
    for (let lane = 0; lane < 3; lane += 1) {
      const candidates = candidatesForLane(lane);
      const first = candidates[0] ?? 0;
      const second = stepPitch(lane, first, 1);
      expect(Math.abs(second - first)).toBeLessThanOrEqual(3);
      expect(stepPitch(lane, 12, 1)).toBe(12);
    }
  });
});

describe("independent scheduling", () => {
  it("is deterministic for the same seed and differs across seeds", () => {
    const first = independentMoves(3, ENSEMBLE_SLICE_S, AB_SEED, pitchFor);
    const second = independentMoves(3, ENSEMBLE_SLICE_S, AB_SEED, pitchFor);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    const other = independentMoves(3, ENSEMBLE_SLICE_S, AB_SEED + 1, pitchFor);
    expect(other).not.toEqual(first);
  });

  it("reads no lane state: the same seed always yields the same plan", () => {
    const plan = independentMoves(3, 60, 7, pitchFor);
    for (const move of plan) {
      expect(move.atS).toBeLessThan(60);
      expect(isInKey(move.pitch)).toBe(true);
      expect(isInRegister(move.pitch, move.laneIndex)).toBe(true);
    }
  });
});

describe("hybrid eligibility", () => {
  it("permits a move on a sustained mode-identity change with a steady peak", () => {
    const samples: EnsembleLaneReading[][] = [];
    const editing = { exploring: 0.15, editing: 0.65, testing: 0.1 };
    const testing = { exploring: 0.12, editing: 0.2, testing: 0.62 };
    for (let s = 0; s <= 30; s += 1) {
      samples.push(
        readingsAt().map((reading) =>
          reading.laneIndex === 1
            ? {
                ...reading,
                dominantMode: s < 10 ? 0.65 : 0.62,
                mode: s < 10 ? editing : testing,
              }
            : reading,
        ),
      );
    }
    const eligibility = hybridEligibility(samples, 1);
    expect((eligibility.get(1) ?? []).length).toBeGreaterThan(0);
    expect(eligibility.get(0) ?? []).toEqual([]);
    expect(eligibility.get(2) ?? []).toEqual([]);
  });

  it("permits exactly one move per fresh progress evidence, never for held levels", () => {
    const samples: EnsembleLaneReading[][] = [];
    for (let s = 0; s <= 20; s += 1) {
      const progress = s < 5 ? 0.3 : 0.7;
      samples.push(
        readingsAt().map((reading) =>
          reading.laneIndex === 0 ? { ...reading, progress, progressAtS: s < 5 ? 0 : 5 } : reading,
        ),
      );
    }
    const eligibility = hybridEligibility(samples, 1);
    expect(eligibility.get(0)).toHaveLength(1);
  });

  it("never marks non-routine lanes eligible", () => {
    const samples: EnsembleLaneReading[][] = [];
    for (let s = 0; s <= 20; s += 1) {
      samples.push(readingsAt().map((reading) => ({ ...reading, activity: 0.95, routine: false })));
    }
    expect(hybridEligibility(samples, 1).size).toBe(0);
  });
});

describe("hybrid arbitration", () => {
  it("enforces one move at a time with holds and cooldowns", () => {
    const eligibility = new Map<number, readonly number[]>([
      [0, [12, 14, 40]],
      [1, [13, 50]],
    ]);
    const moves = hybridSchedule(eligibility, ENSEMBLE_SLICE_S, startPitchForLane, stepPitch, 3);
    expect(moves.length).toBeGreaterThan(0);
    for (let i = 1; i < moves.length; i += 1) {
      const gap = (moves[i]?.atS ?? 0) - (moves[i - 1]?.atS ?? 0);
      expect(gap).toBeGreaterThanOrEqual(ENSEMBLE_COOLDOWN_S - 1e-9);
    }
    const lane0 = moves.filter((move) => move.laneIndex === 0);
    for (let i = 1; i < lane0.length; i += 1) {
      expect((lane0[i]?.atS ?? 0) - (lane0[i - 1]?.atS ?? 0)).toBeGreaterThanOrEqual(
        ENSEMBLE_MIN_HOLD_S - 1e-9,
      );
    }
  });
});

describe("shared timeline", () => {
  it("covers normal, busy/quiet, waiting and completion inside 150 s", () => {
    expect(AB_SLICE_S).toBe(150);
    const steps = abTimeline();
    expect(lanesAt(0, steps)[0]?.activity).toBeLessThan(lanesAt(0, steps)[1]?.activity ?? 1);
    expect(lanesAt(60, steps)[2]?.lifecycle).toBe("waiting");
    expect(lanesAt(110, steps)[2]?.lifecycle).toBe("turn_complete");
    expect(lanesAt(120, steps)[2]?.lifecycle).toBe("active");
    expect(lanesAt(120, steps)[1]?.progress).toBeGreaterThan(lanesAt(90, steps)[1]?.progress ?? 0);
  });
});

describe("voiced prototype", () => {
  it("carries the production question and resolve cues at the slice times", () => {
    const cues = abCueEvents(0.6);
    const question = driveScenario(scenarioFor("question", AB_CUE_LANE, 0.6));
    const resolve = driveScenario(scenarioFor("resolve", AB_CUE_LANE, 0.6));
    expect(cues.length).toBe(question.length + resolve.length);
    const noteStarts = cues
      .filter((event) => event.kind === "note")
      .map((event) => (event.kind === "note" ? event.startS : 0));
    expect(Math.min(...noteStarts.filter((t) => t >= AB_WAITING_AT_S))).toBeCloseTo(
      AB_WAITING_AT_S,
      1,
    );
    expect(Math.min(...noteStarts.filter((t) => t >= AB_RESOLVE_AT_S))).toBeCloseTo(
      AB_RESOLVE_AT_S,
      1,
    );
    for (const event of cues) {
      if (event.kind === "note") {
        expect(event.attackS).toBeGreaterThanOrEqual(0.005);
        expect(event.gain).toBeLessThanOrEqual(0.45 + 1e-9);
      }
    }
  });

  it("voices NO event for a routine move: the lane's own pitch is the gesture", () => {
    // Regression for the owner's "sudden notes" listen: a routine move
    // must not sound anything on top of the lane. The audition drive
    // carries the two hard cues and nothing else, so the only events in
    // the slice belong to lane 2 at 60 s and 110 s — a routine move on
    // lane 0/1 contributes none.
    const cues = abCueEvents(0.6);
    for (const event of cues) {
      if (!("laneIndex" in event)) continue;
      expect(event.laneIndex).toBe(AB_CUE_LANE);
    }
    const onsets = cues
      .filter((event) => event.kind === "note")
      .map((event) => (event.kind === "note" ? event.startS : 0));
    for (const onset of onsets) {
      const nearCue =
        Math.abs(onset - AB_WAITING_AT_S) < 5 || Math.abs(onset - AB_RESOLVE_AT_S) < 5;
      expect(nearCue).toBe(true);
    }
  });

  it("reads a move as a pitch change of the lane's own sustained voice", () => {
    // Offline audibility proof, sustained path: the lane's continuous
    // voice rendered at the old pitch vs the new one resolves as two
    // distinct pitches. This replaces the old articulation-based proof —
    // the transition is now carried by the lane itself, so this is the
    // surface that must show it.
    const pitchAt = (midi: number): number => {
      const rendered = renderGesturePlan(sustainedVoiceEventsForPitch(1, midi), 5);
      const mono = new Float32Array(rendered.left.length);
      for (let i = 0; i < mono.length; i++) {
        mono[i] = ((rendered.left[i] ?? 0) + (rendered.right[i] ?? 0)) / 2;
      }
      return estimatePitch(mono, rendered.sampleRate, 1, 3.5);
    };
    const oldPitch = pitchAt(64);
    const newPitch = pitchAt(66);
    expect(oldPitch).toBeGreaterThan(0);
    expect(newPitch).toBeGreaterThan(0);
    // E4 → F#4: a two-semitone step the estimator must resolve as
    // distinct, not identical.
    expect(Math.abs(newPitch - oldPitch) / oldPitch).toBeGreaterThan(0.05);
  });

  it("keeps the sustained voice audible and step-free at the move pitch", () => {
    const rendered = renderGesturePlan(sustainedVoiceEventsForPitch(1, 66), 5);
    const mono = new Float32Array(rendered.left.length);
    for (let i = 0; i < mono.length; i++) {
      mono[i] = ((rendered.left[i] ?? 0) + (rendered.right[i] ?? 0)) / 2;
    }
    const silent = new Float32Array(rendered.left.length);
    expect(windowRmsDb(mono, rendered.sampleRate, 1, 3.5)).toBeGreaterThan(
      windowRmsDb(silent, rendered.sampleRate, 1, 3.5) + 20,
    );
    expect(maxSampleJump(rendered.left, rendered.right)).toBeLessThanOrEqual(0.3);
  });
});

describe("sustained retune", () => {
  it("preserves every voice's offset when gliding to the move pitch", () => {
    // Mid-lane recipe [69, 69+detune]: a move to 66 keeps the pair
    // spaced, re-rooted at 66 — timbre (type/detune) untouched.
    expect(voiceFreqsForMove([69, 69], 66)).toEqual([66, 66]);
    expect(voiceFreqsForMove([40, 40], 45)).toEqual([45, 45]);
    expect(voiceFreqsForMove([], 66)).toEqual([]);
    // The lane's full voice list — grain pair, pulse pair an octave
    // down, tension set (builder.ts voiceMidi order) — moves as ONE
    // voice: every offset from the root survives, so the octave below
    // stays an octave below instead of holding the old pitch.
    expect(voiceFreqsForMove([69, 69, 57, 57, 69, 69], 64)).toEqual([64, 64, 52, 52, 64, 64]);
  });

  it("centers sustained spectral content on the carried pitch after a move", () => {
    // Sustained-voice proof: the lane's continuous voice rendered at
    // the old move pitch (64, E4) vs the new move pitch (66, F#4) must
    // center spectrally on the carried pitch — the harmony morphs,
    // not just a blip over a static bed.
    const renderSustained = (pitch: number): number => {
      const rendered = renderGesturePlan(sustainedVoiceEventsForPitch(1, pitch), 5);
      const mono = new Float32Array(rendered.left.length);
      for (let i = 0; i < mono.length; i++) {
        mono[i] = ((rendered.left[i] ?? 0) + (rendered.right[i] ?? 0)) / 2;
      }
      return spectralCentroid(mono, rendered.sampleRate, 1, 4);
    };
    const oldCentroid = renderSustained(64);
    const newCentroid = renderSustained(66);
    expect(oldCentroid).toBeGreaterThan(0);
    expect(newCentroid).toBeGreaterThan(oldCentroid);
    // Both centroids sit near their fundamentals (within an octave):
    // the voice carries the pitch, not an unrelated resonance.
    expect(oldCentroid).toBeGreaterThan(midiToFrequency(64) / 2);
    expect(oldCentroid).toBeLessThan(midiToFrequency(64) * 2);
    expect(newCentroid).toBeGreaterThan(midiToFrequency(66) / 2);
    expect(newCentroid).toBeLessThan(midiToFrequency(66) * 2);
    expect(ROUTINE_SUSTAIN_GAIN).toBeLessThanOrEqual(0.2 + 1e-9);
  });

  it("hands the note over by crossfade: no pitch bends, and the level holds", () => {
    // The owner's verdict on the glide ("the pitch shift sounds too
    // weird") turned into a contract: a move is a 3 s fade between two
    // banks, not a frequency ramp. Equal power at the midpoint is what
    // keeps the lane from dipping or swelling as the note changes hands —
    // the two banks sound different pitches, so they sum as power.
    expect(RAMP_TIMES.crossfade.seconds).toBe(3.0);
    expect(RAMP_TIMES.crossfade.curve).toBe("linear");
    expect(CROSSFADE_MID_GAIN).toBeCloseTo(Math.SQRT1_2, 12);
    expect(CROSSFADE_MID_GAIN ** 2 + CROSSFADE_MID_GAIN ** 2).toBeCloseTo(1, 12);
    // The scheduled shape, sampled: two linear half-ramps per bank
    // meeting at 1/√2. Summed power stays within a fraction of a dB of
    // one bank alone across the whole fade — no hole, no bloom.
    const half = RAMP_TIMES.crossfade.seconds / 2;
    const gainAt = (t: number, from: number, to: number): number =>
      t <= half
        ? from + (CROSSFADE_MID_GAIN - from) * (t / half)
        : CROSSFADE_MID_GAIN + (to - CROSSFADE_MID_GAIN) * ((t - half) / half);
    for (let t = 0; t <= RAMP_TIMES.crossfade.seconds + 1e-9; t += 0.1) {
      const out = gainAt(t, 1, 0);
      const incoming = gainAt(t, 0, 1);
      const powerDb = 10 * Math.log10(out ** 2 + incoming ** 2);
      expect(powerDb).toBeLessThanOrEqual(0.01);
      expect(powerDb).toBeGreaterThan(-1);
    }
  });
});
