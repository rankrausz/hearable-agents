// packages/audio/test/qa-scenarios.test.ts — behaviour tests for the QA
// scenario drives: every drive is deterministic, ordered, and matches the
// spec row it names (durations, calm, triggers), and the QA gesture plans
// reuse the GESTURE_SCENARIOS named inputs.

import { describe, expect, it } from "vitest";
import { driveScenario, scenarioFor } from "../src/gestures/index.js";
import { natureOffsets } from "../src/graph/index.js";
import {
  QA_DURATIONS,
  QA_SCENARIO_NAMES,
  QA_SEED,
  qaGesturePlan,
  scenarioDrive,
} from "../src/qa/scenarios.js";
import { NATURE_BED } from "../src/scenes/clearing/index.js";

describe("qa scenario drives", () => {
  it("covers all eight sound-design scenarios plus the macro-evolution path", () => {
    expect(QA_SCENARIO_NAMES).toHaveLength(15);
    expect(new Set(QA_SCENARIO_NAMES).size).toBe(15);
    for (const name of QA_SCENARIO_NAMES) {
      expect(QA_DURATIONS[name]).toBeGreaterThanOrEqual(30);
    }
  });

  it("builds the same drive twice from the fixed seed", () => {
    for (const name of QA_SCENARIO_NAMES) {
      expect(scenarioDrive(name, QA_SEED)).toEqual(scenarioDrive(name, QA_SEED));
    }
  });

  it("orders steps in ascending time within the duration", () => {
    for (const name of QA_SCENARIO_NAMES) {
      const drive = scenarioDrive(name);
      expect(drive.steps.length).toBeGreaterThan(0);
      for (let i = 1; i < drive.steps.length; i++) {
        expect(drive.steps[i]?.atS).toBeGreaterThan(drive.steps[i - 1]?.atS ?? 0);
        expect(drive.steps[i]?.atS).toBeLessThan(drive.durationS);
      }
    }
  });

  it("pins calm 0.6 on routine, 0.9 on near-silence, and a 0→1→0 sweep", () => {
    expect(scenarioDrive("routine-3-lanes-calm06").calm).toBe(0.6);
    expect(scenarioDrive("near-silence-calm09").calm).toBe(0.9);
    const sweep = scenarioDrive("calm-sweep");
    expect(sweep.calm).toBe(0);
    expect(sweep.calmTrack).toEqual([
      [30, 1],
      [60, 0],
    ]);
  });

  it("sweeps one lane through the modes over sixty seconds", () => {
    const drive = scenarioDrive("single-lane-modes");
    expect(drive.steps[0]?.lanes).toHaveLength(1);
    expect(drive.steps[0]?.lanes[0]?.mode.exploring).toBe(1);
    const last = drive.steps[drive.steps.length - 1];
    expect(last?.lanes[0]?.mode.testing).toBeGreaterThan(0.5);
  });

  it("ramps struggle from zero to one over sixty seconds", () => {
    const drive = scenarioDrive("struggle-ramp");
    expect(drive.steps[0]?.lanes[0]?.struggle).toBe(0);
    const last = drive.steps[drive.steps.length - 1];
    expect(last?.lanes[0]?.struggle).toBeGreaterThan(0.9);
  });

  it("enters waiting with a question trigger at ten seconds", () => {
    const drive = scenarioDrive("waiting-holds");
    const waiting = drive.steps.find((step) => step.atS === 10);
    expect(waiting?.lanes[1]?.lifecycle).toBe("waiting");
    expect(waiting?.lanes[1]?.gestures).toEqual([{ gesture: "question", at: 10 }]);
  });

  it("completes with a resolve trigger at ten seconds", () => {
    const drive = scenarioDrive("resolve-fades");
    const done = drive.steps.find((step) => step.atS === 10);
    expect(done?.lanes[1]?.lifecycle).toBe("turn_complete");
    expect(done?.lanes[1]?.gestures).toEqual([{ gesture: "resolve", at: 10 }]);
  });

  it("holds the macro-evolution render long enough to cross a boundary", () => {
    const drive = scenarioDrive("macro-evolution");
    expect(drive.durationS).toBeGreaterThanOrEqual(240);
    expect(drive.gestures).toEqual([]);
    expect(drive.steps).toHaveLength(1);
    expect(drive.steps[0]?.lanes).toHaveLength(3);
  });

  it("drives the harmonic field with one agent in the mid seat for eight minutes", () => {
    const drive = scenarioDrive("harmonic-field");
    expect(drive.durationS).toBe(480);
    expect(drive.calm).toBe(0.6);
    expect(drive.gestures).toEqual([]);
    expect(drive.steps).toHaveLength(1);
    const lanes = drive.steps[0]?.lanes ?? [];
    expect(lanes.map((lane) => lane.lifecycle)).toEqual(["idle", "active"]);
    expect(lanes[1]?.laneId).toBe(1);
  });

  it("moves the foreground across the lanes every twenty seconds", () => {
    const drive = scenarioDrive("foreground-switch");
    expect(drive.steps.map((step) => step.atS)).toEqual([0, 20, 40]);
    for (const step of drive.steps) {
      const foreground = step.lanes.filter((lane) => lane.foreground);
      expect(foreground).toHaveLength(1);
    }
  });

  it("drives the same named gesture inputs as the gesture suite", () => {
    expect(qaGesturePlan("question", 1, 0.6)).toEqual(
      driveScenario(scenarioFor("question", 1, 0.6)),
    );
    expect(qaGesturePlan("resolve", 1, 0.6)).toEqual(driveScenario(scenarioFor("resolve", 1, 0.6)));
  });

  it("staggers the nature-bed loop voices by half the loop, deterministically", () => {
    // p3-t15 seeded slow variation: the same seed always yields the same
    // offsets, the pair sits half a loop apart, and both sit in the loop.
    const first = natureOffsets(NATURE_BED.seed);
    expect(natureOffsets(NATURE_BED.seed)).toEqual(first);
    for (const offset of [first.voiceA, first.voiceB]) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(NATURE_BED.loopDurationS);
    }
    const gap = Math.abs(first.voiceA - first.voiceB);
    expect(gap).toBeCloseTo(NATURE_BED.loopDurationS / 2, 6);
  });

  it("drives spatial-drift on the same routine lanes as the baseline mix", () => {
    // p3-t16 entry-only: same lanes, calm and duration class as
    // routine-3-lanes-calm06 — meso held steady, so the only long-term
    // motion inside the render is the seeded macro wander. No gestures.
    const drift = scenarioDrive("spatial-drift");
    expect(drift.durationS).toBe(60);
    expect(drift.calm).toBe(0.6);
    expect(drift.gestures).toEqual([]);
    expect(drift.steps).toEqual(scenarioDrive("routine-3-lanes-calm06").steps);
  });

  it("drives the ensemble A/B slices on the shared 150 s timeline with both cues", () => {
    for (const name of ["ensemble-ab-independent", "ensemble-ab-hybrid"] as const) {
      const drive = scenarioDrive(name);
      expect(drive.durationS).toBe(150);
      expect(drive.calm).toBe(0.6);
      expect(drive.gestures).toEqual([
        { at: 60, laneIndex: 2 },
        { at: 110, laneIndex: 2 },
      ]);
      const waiting = drive.steps.find((step) => step.atS === 60);
      expect(waiting?.lanes[2]?.lifecycle).toBe("waiting");
      const complete = drive.steps.find((step) => step.atS === 110);
      expect(complete?.lanes[2]?.lifecycle).toBe("turn_complete");
    }
  });
});
