// Drift tests cover the audio package's pure render-to-apply seam: seeded
// trajectories are reproducible, updates stay in musical bounds, and discrete
// scene choices are not altered.

import { createRng, type LaneRender, render, type SceneParams } from "@hearable/core";
import { describe, expect, it } from "vitest";

import {
  createDriftStepper,
  createLiveDriftStepper,
  createSeededDriftStepper,
  DRIFT_STEP_SECONDS,
  driftSceneParams,
} from "../src/drift.js";

function lane(laneId: number): LaneRender {
  return {
    laneId,
    lifecycle: "active",
    mode: { exploring: 0.25, editing: 0.5, testing: 0.2, other: 0.05 },
    displayedMode: "editing",
    activity: 0.7,
    progress: 0.4,
    struggle: 0.2,
    prominence: 0.5,
    foreground: laneId === 0,
    gestures: [],
  };
}

function routineScene(): SceneParams {
  return render([lane(0), lane(1), lane(2)], 0.6);
}

function trajectory(seed: number): string[] {
  const stepper = createSeededDriftStepper(seed);
  const params = routineScene();
  const values: string[] = [];
  for (let index = 0; index < 120; index += 1) {
    values.push(JSON.stringify(stepper.step(params, DRIFT_STEP_SECONDS)));
  }
  return values;
}

function autocorrelation(values: readonly number[], lag: number): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map((value) => value - mean);
  const denominator = centered.reduce((sum, value) => sum + value * value, 0);
  const numerator = centered
    .slice(0, -lag)
    .reduce((sum, value, index) => sum + value * (centered[index + lag] ?? 0), 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

describe("SceneParams drift", () => {
  it("repeats the complete seeded trajectory byte-for-byte", () => {
    const first = trajectory(7);
    expect(first).toEqual(trajectory(7));
    expect(first).not.toEqual(trajectory(8));
  });

  it("moves only at the half-second cadence", () => {
    const stepper = createDriftStepper(createRng(11));
    const initial = routineScene();
    const beforeStep = stepper.step(initial, 0.25);
    const afterStep = stepper.step(initial, 0.25);

    expect(beforeStep).toBe(initial);
    expect(afterStep).not.toBe(initial);
  });

  it("keeps continuous fields bounded and discrete choices unchanged", () => {
    const initial = routineScene();
    const drifted = driftSceneParams(initial, createRng(19), 0.5);

    expect(drifted.masterGainDb).toBeGreaterThanOrEqual(-6);
    expect(drifted.masterGainDb).toBeLessThanOrEqual(0);
    expect(Math.abs(drifted.masterGainDb - initial.masterGainDb)).toBeLessThanOrEqual(0.3);
    expect(drifted.densityScale).toBeGreaterThanOrEqual(0);
    expect(drifted.densityScale).toBeLessThanOrEqual(1);
    expect(Math.abs(drifted.densityScale - initial.densityScale)).toBeLessThanOrEqual(0.05);
    expect(drifted.bed.gainDbfs).toBeGreaterThanOrEqual(-40);
    expect(drifted.bed.gainDbfs).toBeLessThanOrEqual(-30);

    drifted.lanes.forEach((lane, index) => {
      const original = initial.lanes[index];
      expect(lane.laneId).toBe(original?.laneId);
      expect(lane.tension.on).toBe(original?.tension.on);
      expect(lane.grain.noteSet).toBe(original?.grain.noteSet);
      expect(lane.grain.upperRegister).toBe(original?.grain.upperRegister);
      expect(lane.air.cutoff).toBeGreaterThanOrEqual(0.8);
      expect(lane.air.cutoff).toBeLessThanOrEqual(1.2);
      expect(
        Math.abs(lane.air.cutoff - (initial.lanes[index]?.air.cutoff ?? 0)),
      ).toBeLessThanOrEqual(0.04);
      expect(lane.grain.stuckDepth).toBeGreaterThanOrEqual(0);
      expect(lane.grain.stuckDepth).toBeLessThanOrEqual(1);
      expect(
        Math.abs(lane.grain.stuckDepth - (initial.lanes[index]?.grain.stuckDepth ?? 0)),
      ).toBeLessThanOrEqual(0.05);
      expect(lane.grain.stuckRateHz).toBeGreaterThanOrEqual(0.01);
      expect(lane.grain.stuckRateHz).toBeLessThanOrEqual(4);
      expect(lane.proximity.brightnessDb).toBeGreaterThanOrEqual(-4);
      expect(lane.proximity.brightnessDb).toBeLessThanOrEqual(3);
    });
  });

  it("carries the macro checkpoint through untouched", () => {
    const initial = routineScene();
    const drifted = driftSceneParams(initial, createRng(19), 0.5);
    expect(drifted.macro).toEqual(initial.macro);
  });

  it("does not settle into an exact five-second repeat over a 60-second walk", () => {
    const values = trajectory(23);
    const lag = 10;
    expect(values.slice(lag)).not.toEqual(values.slice(0, -lag));
  });

  it("keeps the 60-second routine trajectory below the fatigue autocorrelation threshold", () => {
    const stepper = createSeededDriftStepper(23);
    const params = routineScene();
    const masterGain = Array.from(
      { length: 120 },
      () => stepper.step(params, DRIFT_STEP_SECONDS).masterGainDb,
    );
    const correlations = Array.from({ length: 51 }, (_, index) =>
      Math.abs(autocorrelation(masterGain, index + 10)),
    );

    expect(Math.max(...correlations)).toBeLessThan(0.9);
  });

  it("offers a live seed boundary through the same stepper path", () => {
    expect(createLiveDriftStepper().step(routineScene(), DRIFT_STEP_SECONDS)).toBeDefined();
    expect(createDriftStepper(createRng(31)).step(routineScene(), DRIFT_STEP_SECONDS)).toEqual(
      createSeededDriftStepper(31).step(routineScene(), DRIFT_STEP_SECONDS),
    );
  });
});

describe("drift never lifts what is silent", () => {
  it("keeps idle seats, a closed tension pad and the empty-room bed exactly where core put them", () => {
    const idle = [0, 1, 2, 3].map(
      (laneId): LaneRender => ({
        laneId,
        lifecycle: "idle",
        mode: { exploring: 0, editing: 0, testing: 0, other: 0 },
        displayedMode: "exploring",
        activity: 0,
        progress: 0,
        struggle: 0,
        prominence: 0,
        foreground: false,
        gestures: [],
      }),
    );
    const empty = render(idle, 0.6);
    let params: SceneParams = empty;
    const rng = createRng(7);
    for (let step = 0; step < 400; step += 1) {
      params = driftSceneParams(empty, rng, 0.5);
      expect(params.bed.gainDbfs).toBe(empty.bed.gainDbfs);
      for (const lane of params.lanes) {
        expect(lane.layers).toEqual({ air: 0, grain: 0, pulse: 0, tension: 0 });
        expect(lane.air.gain).toBe(0);
        expect(lane.grain.gain).toBe(0);
        expect(lane.pulse.gain).toBe(0);
        expect(lane.tension.gain).toBe(0);
      }
    }
  });
});
