// packages/audio/test/ramps.test.ts — behaviour tests for the ramp
// discipline: every ramp class matches docs/SOUND_DESIGN.md §Ramps times,
// and every planned trajectory approaches its target monotonically within
// tolerance, including moves through silence via the shared floor.

import { describe, expect, it } from "vitest";

import { approachTrajectory, EXPONENTIAL_GAIN_FLOOR, RAMP_TIMES } from "../src/ramps.js";

describe("ramp times", () => {
  it("matches the sound design table", () => {
    expect(RAMP_TIMES.layerGain.seconds).toBe(1.5);
    expect(RAMP_TIMES.cutoff.seconds).toBe(2.0);
    expect(RAMP_TIMES.reverbSend.seconds).toBe(2.0);
    expect(RAMP_TIMES.brightness.seconds).toBe(2.0);
    expect(RAMP_TIMES.regularity.seconds).toBe(4.0);
    expect(RAMP_TIMES.density.seconds).toBe(4.0);
    expect(RAMP_TIMES.period.seconds).toBe(4.0);
    expect(RAMP_TIMES.detune.seconds).toBe(6.0);
    expect(RAMP_TIMES.crossfade.seconds).toBe(3.0);
    expect(RAMP_TIMES.fieldVoice.seconds).toBe(12.0);
    expect(RAMP_TIMES.fieldCrossfade.seconds).toBe(3.0);
    expect(RAMP_TIMES.droneCrossfade.seconds).toBe(10.0);
    expect(RAMP_TIMES.room.seconds).toBe(8.0);
    expect(RAMP_TIMES.pan.seconds).toBe(3.0);
    expect(RAMP_TIMES.width.seconds).toBe(3.0);
    expect(RAMP_TIMES.master.seconds).toBe(1.0);
    expect(RAMP_TIMES.tensionAttack.seconds).toBe(3.0);
    expect(RAMP_TIMES.tensionRelease.seconds).toBe(5.0);
  });

  it("ramps layer gains exponentially and drift classes by approach", () => {
    expect(RAMP_TIMES.layerGain.curve).toBe("exponential");
    expect(RAMP_TIMES.regularity.curve).toBe("target");
    expect(RAMP_TIMES.density.curve).toBe("target");
    expect(RAMP_TIMES.period.curve).toBe("target");
    // The p5-t01 lane note move is a LINEAR equal-power crossfade between
    // the lane's two voice banks (apply.ts schedules it as two half-ramps
    // meeting at 1/√2) — no pitch bends, so no frequency curve at all.
    expect(RAMP_TIMES.crossfade.curve).toBe("linear");
  });
});

describe("ramp trajectories", () => {
  it("approaches the target monotonically upward", () => {
    const points = approachTrajectory("layerGain", 0.1, 0.8);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]?.value ?? 0).toBeGreaterThanOrEqual((points[i - 1]?.value ?? 0) - 1e-12);
    }
    const last = points[points.length - 1]?.value ?? 0;
    expect(Math.abs(last - 0.8)).toBeLessThan(1e-9);
  });

  it("approaches the target monotonically downward", () => {
    const points = approachTrajectory("cutoff", 3000, 900);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]?.value ?? 0).toBeLessThanOrEqual((points[i - 1]?.value ?? 0) + 1e-9);
    }
    const last = points[points.length - 1]?.value ?? 0;
    expect(Math.abs(last - 900)).toBeLessThan(1e-6);
  });

  it("ramps through silence without touching zero", () => {
    const points = approachTrajectory("layerGain", 0.5, 0);
    for (const point of points) {
      expect(point.value).toBeGreaterThan(0);
    }
    const last = points[points.length - 1]?.value ?? 0;
    expect(last).toBe(EXPONENTIAL_GAIN_FLOOR);
  });

  it("settles detune over the full 6 s window", () => {
    const points = approachTrajectory("detune", 0, 18);
    const last = points[points.length - 1];
    expect(last?.t).toBe(6.0);
    expect(Math.abs((last?.value ?? 0) - 18)).toBeLessThan(1e-9);
  });

  it("releases tension slower than it attacks", () => {
    const attack = approachTrajectory("tensionAttack", 0, 0.7);
    const release = approachTrajectory("tensionRelease", 0.7, 0);
    expect(release[release.length - 1]?.t).toBeGreaterThan(attack[attack.length - 1]?.t ?? 0);
  });
});
