// packages/audio/test/harmonic-voice.test.ts — behaviour tests for the
// p5-t03 harmonic-move voicing seam. What this is for: proving the p5-t02
// core planner's `HarmonicMove` plans voice through the p5-t01 prototype
// path — the same `EnsembleQaSchedule` shape the QA entry crossfades —
// with no second voicing engine, no re-pitching, and no lane but the
// move's own lane touched: the contract pins the voiceable-move gate, the
// window horizon (moves past the window never start), common-tone-safe
// fields (every voiced move stays in key and in register), soft envelopes
// (the crossfade holds level by construction), and planner compatibility
// (a real planner trajectory voices end to end). What it must not do:
// import Tone, render audio, or judge sound — audibility belongs to the
// named QA renders and the owner's ears.

import {
  HARMONIC_COOLDOWN_S,
  HARMONIC_ELIGIBILITY_WINDOW_S,
  type HarmonicMove,
  harmonicIsInKey,
  harmonicIsInRegister,
  initialHarmonicState,
  type LaneSignal,
  planHarmonicStep,
  planHarmonicTrajectory,
} from "@hearable/core";
import { describe, expect, it } from "vitest";
import { CROSSFADE_MID_GAIN } from "../src/apply.js";
import {
  AB_SLICE_S,
  candidatesForLane,
  HARMONIC_VOICE_MAX_STEP,
  harmonicMoveIsVoiceable,
  harmonicSliceSignals,
  harmonicVoiceIsInWindow,
  harmonicVoicePlan,
  isInKey,
  isInRegister,
  RAMP_TIMES,
} from "../src/index.js";

const predicates = { isInKey, isInRegister };

/** Plans one live second per lane, folding trails the planner's way. */
function planTrajectory(
  durationS: number,
  signalsAt: (laneIndex: number, t: number) => LaneSignal,
): readonly HarmonicMove[] {
  let state = initialHarmonicState(
    [0, 1, 2],
    new Map([0, 1, 2].map((laneIndex) => [laneIndex, signalsAt(laneIndex, 0).progress])),
  );
  const moves: HarmonicMove[] = [];
  const seen = new Map<number, { atS: number; signal: LaneSignal }[]>();
  for (let t = 0; t <= durationS; t += 1) {
    const frame = [0, 1, 2].map((laneIndex) => ({
      laneIndex,
      atS: t,
      signal: signalsAt(laneIndex, t),
    }));
    const history = new Map<number, readonly LaneSignal[]>();
    for (const item of frame) {
      history.set(
        item.laneIndex,
        (seen.get(item.laneIndex) ?? [])
          .filter(
            (entry) =>
              entry.atS >= item.atS - HARMONIC_ELIGIBILITY_WINDOW_S - 1 && entry.atS < item.atS,
          )
          .sort((a, b) => a.atS - b.atS)
          .map((entry) => entry.signal),
      );
    }
    const step = planHarmonicStep(state, frame, history, { seed: 161 });
    state = step.state;
    if (step.move !== null) moves.push(step.move);
    for (const item of frame) {
      const trail = seen.get(item.laneIndex) ?? [];
      trail.push({ atS: item.atS, signal: item.signal });
      seen.set(item.laneIndex, trail);
    }
  }
  return moves;
}

function signal(overrides: Partial<LaneSignal> = {}): LaneSignal {
  return {
    laneIndex: 1,
    lifecycle: "active",
    mode: { exploring: 0.15, editing: 0.65, testing: 0.1, other: 0.1 },
    activity: 0.65,
    progress: 0.35,
    ...overrides,
  };
}

describe("harmonic move voicing", () => {
  it("voices a planner move through the prototype schedule shape, untouched", () => {
    const move: HarmonicMove = { laneIndex: 1, atS: 23, pitch: 66, fromPitch: 69 };
    const plan = harmonicVoicePlan([move], AB_SLICE_S, predicates);
    // Provenance: planner output is tagged harmonic, never hybrid — the
    // audition labels stay hand-authored, planner-voiced plans stay marked.
    expect(plan.schedule.version).toBe("harmonic");
    expect(plan.schedule.moves).toEqual([move]);
  });

  it("reuses the core grammar, never a second pitch set", () => {
    // Every candidate of every lane passes the voicing gate as a step —
    // the seam guards with the same key/register predicates the schedule
    // path uses, so it cannot voice what the planner would not plan.
    for (let lane = 0; lane < 3; lane += 1) {
      const candidates = candidatesForLane(lane);
      for (let i = 1; i < candidates.length; i += 1) {
        const move: HarmonicMove = {
          laneIndex: lane,
          atS: 30,
          pitch: candidates[i] ?? 0,
          fromPitch: candidates[i - 1] ?? 0,
        };
        expect(harmonicIsInKey(move.pitch)).toBe(true);
        expect(harmonicIsInRegister(move.pitch, lane)).toBe(true);
        expect(harmonicMoveIsVoiceable(move, AB_SLICE_S, predicates)).toBe(true);
      }
    }
    expect(HARMONIC_VOICE_MAX_STEP).toBe(3);
  });

  it("holds invalid plans instead of reinterpreting them", () => {
    const held: HarmonicMove[] = [
      // A hold disguised as a move voices nothing.
      { laneIndex: 1, atS: 23, pitch: 69, fromPitch: 69 },
      // A leap is never a routine step.
      { laneIndex: 1, atS: 23, pitch: 64, fromPitch: 69 },
      // Off the grammar: unknown pitches stay silent.
      { laneIndex: 1, atS: 23, pitch: 70, fromPitch: 69 },
    ];
    expect(harmonicVoicePlan(held, AB_SLICE_S, predicates).schedule.moves).toEqual([]);
  });

  it("never starts a move past the voiced window", () => {
    const late: HarmonicMove = { laneIndex: 1, atS: AB_SLICE_S, pitch: 66, fromPitch: 69 };
    expect(harmonicVoiceIsInWindow(late.atS, AB_SLICE_S)).toBe(false);
    expect(harmonicMoveIsVoiceable(late, AB_SLICE_S, predicates)).toBe(false);
    expect(harmonicVoicePlan([late], AB_SLICE_S, predicates).schedule.moves).toEqual([]);
    // The horizon matches the audition schedulers: strictly before the end.
    expect(harmonicVoiceIsInWindow(AB_SLICE_S - 0.01, AB_SLICE_S)).toBe(true);
    expect(harmonicVoiceIsInWindow(-0.01, AB_SLICE_S)).toBe(false);
  });

  it("touches only the move's own lane", () => {
    const moves: HarmonicMove[] = [
      { laneIndex: 1, atS: 23, pitch: 66, fromPitch: 69 },
      { laneIndex: 1, atS: 53, pitch: 69, fromPitch: 66 },
    ];
    const voiced = harmonicVoicePlan(moves, AB_SLICE_S, predicates).schedule.moves;
    expect(voiced.every((move) => move.laneIndex === 1)).toBe(true);
    // A lane-1 isolation of the voiced plan keeps both moves; a lane-0
    // isolation keeps none — the entry's solo filter and the seam agree.
    expect(voiced.filter((move) => move.laneIndex === 1)).toHaveLength(2);
    expect(voiced.filter((move) => move.laneIndex === 0)).toHaveLength(0);
  });

  it("protects waiting semantics: waiting lanes never voice routine moves", () => {
    const moves = planTrajectory(60, (laneIndex, t) => {
      if (laneIndex === 2 && t >= 20) {
        return signal({ laneIndex, lifecycle: "waiting", activity: 0.4, progress: 0.8 });
      }
      return signal({ laneIndex });
    });
    for (const move of moves) {
      expect(move.laneIndex).not.toBe(2);
    }
  });

  it("hands planned notes over on the declared crossfade without bending pitch", () => {
    // The declared handover the seam schedules through: the crossfade
    // class is 3 s of two linear half-ramps meeting at 1/√2, and the
    // two banks sum in power to one bank alone — bounded gain, no click
    // source, no frequency ramp anywhere.
    expect(RAMP_TIMES.crossfade.seconds).toBe(3.0);
    expect(RAMP_TIMES.crossfade.curve).toBe("linear");
    expect(CROSSFADE_MID_GAIN ** 2 + CROSSFADE_MID_GAIN ** 2).toBeCloseTo(1, 12);
    const held = planTrajectory(90, (laneIndex, t) =>
      signal({ laneIndex, progress: t < 5 ? 0.1 : 0.8 }),
    );
    const voiced = harmonicVoicePlan(held, 150, predicates).schedule.moves;
    expect(voiced.length).toBeGreaterThan(0);
    for (let i = 1; i < voiced.length; i += 1) {
      expect((voiced[i]?.atS ?? 0) - (voiced[i - 1]?.atS ?? 0)).toBeGreaterThanOrEqual(
        HARMONIC_COOLDOWN_S - 1e-9,
      );
    }
    for (const move of voiced) {
      expect(move.pitch).not.toBe(move.fromPitch);
      expect(Math.abs(move.pitch - move.fromPitch)).toBeLessThanOrEqual(3);
    }
  });

  it("preserves instrument identity and octave relationships across the seam", () => {
    // The seam carries fromPitch alongside pitch, so the handover knows
    // which note it leaves: adjacent 2–3 semitone steps in the lane's own
    // register, never a re-voicing of the lane's timbre or range.
    const moves = planTrajectory(150, (laneIndex, t) =>
      signal({ laneIndex, progress: Math.min(0.9, 0.1 + t * 0.02) }),
    );
    const voiced = harmonicVoicePlan(moves, 150, predicates).schedule.moves;
    expect(voiced.length).toBeGreaterThan(0);
    for (const move of voiced) {
      expect(isInKey(move.pitch)).toBe(true);
      expect(isInRegister(move.pitch, move.laneIndex)).toBe(true);
      expect(isInRegister(move.fromPitch, move.laneIndex)).toBe(true);
    }
  });

  it("voices the real planner plan for the shared slice through the crossfade schedule", () => {
    // Consumer proof: the slice trajectory the QA entry sounds, folded
    // through the real core planner, voices end to end into the exact
    // schedule shape the QA entry crossfades — planner timing and
    // pitches in, handover triples out, no hand-authored middle step.
    // The same voiced schedule below renders settled audio in the
    // browser QA probes (lane-1 solo alternation) and in
    // e2e/audio-qa.spec.ts, which threads it as the hybrid schedule.
    const frames = harmonicSliceSignals(AB_SLICE_S, 1);
    const laneIndexes = [0, 1, 2];
    const baseline = new Map(
      (frames[0]?.signals ?? []).map((item) => [item.laneIndex, item.progress]),
    );
    const samples = frames.map((frame) =>
      laneIndexes.map((laneIndex) => {
        const found = frame.signals.find((item) => item.laneIndex === laneIndex);
        return {
          laneIndex,
          atS: frame.atS,
          signal: found ?? signal({ laneIndex }),
        };
      }),
    );
    const historyFor = (laneIndex: number, atS: number): readonly LaneSignal[] =>
      samples
        .flatMap((frame) => frame.filter((item) => item.laneIndex === laneIndex))
        .filter((item) => item.atS >= atS - HARMONIC_ELIGIBILITY_WINDOW_S - 1 && item.atS < atS)
        .sort((a, b) => a.atS - b.atS)
        .map((item) => item.signal);
    const planned = planHarmonicTrajectory(
      initialHarmonicState(laneIndexes, baseline),
      samples,
      historyFor,
      { seed: 161 },
    );
    expect(planned.moves.length).toBeGreaterThan(0);
    const voiced = harmonicVoicePlan(planned.moves, AB_SLICE_S, predicates);
    expect(voiced.schedule.version).toBe("harmonic");
    expect(voiced.schedule.moves).toHaveLength(planned.moves.length);
    expect(voiced.schedule.moves).toEqual(
      planned.moves.map((move) => ({
        laneIndex: move.laneIndex,
        atS: move.atS,
        pitch: move.pitch,
        fromPitch: move.fromPitch,
      })),
    );
    // The slice signals are the trajectory the entry sounds: same
    // per-second samples the render drives, so the plan and the render
    // agree on what the lanes did.
    expect(frames).toHaveLength(AB_SLICE_S + 1);
    for (const frame of frames) {
      expect(frame.signals).toHaveLength(3);
    }
  });
});
