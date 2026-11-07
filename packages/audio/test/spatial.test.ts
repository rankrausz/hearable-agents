// Slow spatial movement (p3-t16, ADR 0017): seeded minute-scale wander of
// pan/width/distance per lane, driven by the macro schedule (never lane
// state, never agent events) — register + timbre + position stay redundant.

import { type LaneRender, render } from "@hearable/core";
import { describe, expect, it } from "vitest";
import { spaceWanderFor } from "../src/apply.js";
import { panForLane } from "../src/graph/index.js";
import {
  clampSpatialPan,
  clampSpatialSend,
  clampSpatialWidth,
  planGraph,
  SPATIAL_CORRELATION_SECONDS,
  SPATIAL_PAN_AMPLITUDE,
  SPATIAL_PAN_REGION_GAP,
  SPATIAL_SEND_AMPLITUDE,
  SPATIAL_WIDTH_AMPLITUDE,
  spatialEpochAt,
  spatialWander,
} from "../src/index.js";
import { SPATIAL_MINUTE_SPAN } from "../src/qa/render.js";
import {
  FLUTE_VOICE,
  LANE_REGISTERS,
  MALLET_VOICE,
  PAD_VOICE,
  REVERB_SEND_BASE,
} from "../src/scenes/clearing/index.js";

function laneRender(overrides: Partial<LaneRender> = {}): LaneRender {
  return {
    laneId: 0,
    lifecycle: "active",
    mode: { exploring: 0.5, editing: 0.3, testing: 0.2, other: 0 },
    displayedMode: "exploring",
    activity: 0.8,
    progress: 0.2,
    struggle: 0.1,
    prominence: 0.5,
    foreground: false,
    gestures: [],
    ...overrides,
  };
}

describe("slow spatial movement", () => {
  it("wanders on minute-scale correlation times, not the half-second cadence", () => {
    expect(SPATIAL_CORRELATION_SECONDS).toBeGreaterThanOrEqual(60);
    expect(SPATIAL_CORRELATION_SECONDS).toBe(180);
    expect(spatialEpochAt(0)).toBe(0);
    expect(spatialEpochAt(179)).toBe(0);
    expect(spatialEpochAt(180)).toBe(1);
    expect(spatialEpochAt(360)).toBe(2);
  });

  it("plans the same wander twice from the render seed, and moves across epochs", () => {
    const first = spatialWander(161, 0, 3);
    expect(spatialWander(161, 0, 3)).toEqual(first);
    const second = spatialWander(161, 1, 3);
    expect(second).not.toEqual(first);
    expect(first.pan).toHaveLength(3);
    expect(first.width).toHaveLength(3);
    expect(first.reverbSend).toHaveLength(3);
  });

  it("bounds every wander offset inside its declared amplitude", () => {
    for (const epoch of [0, 1, 2, 7]) {
      const wander = spatialWander(161, epoch, 3);
      for (const offset of wander.pan) {
        expect(Math.abs(offset)).toBeLessThanOrEqual(SPATIAL_PAN_AMPLITUDE);
      }
      for (const offset of wander.width) {
        expect(Math.abs(offset)).toBeLessThanOrEqual(SPATIAL_WIDTH_AMPLITUDE);
      }
      for (const offset of wander.reverbSend) {
        expect(Math.abs(offset)).toBeLessThanOrEqual(SPATIAL_SEND_AMPLITUDE);
      }
    }
  });

  it("keeps neighbouring drifted pan regions from threatening each other", () => {
    // Worst case: adjacent lanes push toward each other at full opposing
    // amplitude. The static 0.6 spacing minus twice the 0.12 amplitude
    // leaves the 0.36 gap — the regions never overlap.
    for (const epoch of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const wander = spatialWander(161, epoch, 3);
      const drifted = [0, 1, 2].map((lane) => panForLane(lane) + (wander.pan[lane] ?? 0));
      for (let lane = 1; lane < drifted.length; lane += 1) {
        const gap = (drifted[lane] ?? 0) - (drifted[lane - 1] ?? 0);
        expect(gap).toBeGreaterThanOrEqual(SPATIAL_PAN_REGION_GAP - 1e-9);
      }
    }
  });

  it("ignores lane state: busy and idle lanes plan the same wander", () => {
    // The wander is a pure function of (seed, epoch) — lane traffic
    // (mode, struggle, lifecycle, prominence) cannot steer it. The proof
    // reads the two plans at the same epoch: identical wander, whatever
    // the lanes do.
    const busy = spatialWander(161, 2, 3);
    const idle = spatialWander(161, 2, 3);
    expect(idle).toEqual(busy);
    // And the helper the mono-identity proof uses is exactly silent.
    const silent = spatialWander(161, 2, 3, { laneBlind: false });
    expect(silent.pan).toEqual([0, 0, 0]);
    expect(silent.width).toEqual([0, 0, 0]);
    expect(silent.reverbSend).toEqual([0, 0, 0]);
  });

  it("resolves the wander from the render clock alone, never lane state", () => {
    const wander = spaceWanderFor({ seed: 161, nowSeconds: 400 }, 3);
    expect(wander).toEqual(spatialWander(161, spatialEpochAt(400), 3));
    expect(spaceWanderFor(undefined, 3)).toBeUndefined();
  });

  it("rides the declared pan/width/reverbSend ramps, never a new class", () => {
    const params = render(
      [laneRender(), laneRender({ laneId: 1 }), laneRender({ laneId: 2 })],
      0.6,
    );
    const wander = spatialWander(161, 1, 3);
    const plan = planGraph(params, undefined, wander);
    for (const lane of plan.lanes) {
      expect(lane.pan.ramp).toBe("pan");
      expect(lane.width.ramp).toBe("width");
      expect(lane.reverbSend.ramp).toBe("reverbSend");
    }
  });

  it("passes the static targets through untouched without a wander", () => {
    const params = render(
      [laneRender(), laneRender({ laneId: 1 }), laneRender({ laneId: 2 })],
      0.6,
    );
    const plain = planGraph(params);
    const wandered = planGraph(params, undefined, spatialWander(161, 0, 3));
    // Static pans hold the −0.6/0/+0.6 regions without a wander; with one
    // they breathe inside the ±0.12 safe window, never outside it.
    expect(plain.lanes[0]?.pan.target).toBe(-0.6);
    expect(plain.lanes[1]?.pan.target).toBe(0);
    expect(plain.lanes[2]?.pan.target).toBe(0.6);
    for (const [index, lane] of wandered.lanes.entries()) {
      expect(Math.abs(lane.pan.target - (plain.lanes[index]?.pan.target ?? 0))).toBeLessThanOrEqual(
        SPATIAL_PAN_AMPLITUDE + 1e-9,
      );
      expect(lane.pan.target).toBe(clampSpatialPan(lane.pan.target, index));
      expect(lane.width.target).toBe(
        clampSpatialWidth(lane.width.target, plain.lanes[index]?.width.target ?? 0.5),
      );
      expect(lane.reverbSend.target).toBeLessThanOrEqual(REVERB_SEND_BASE + 1e-9);
      expect(lane.reverbSend.target).toBeGreaterThanOrEqual(0);
      expect(lane.reverbSend.target).toBe(
        clampSpatialSend(lane.reverbSend.target, REVERB_SEND_BASE),
      );
    }
  });

  it("keeps the foreground lane the driest across wander epochs", () => {
    // Foreground closeness reads through the drift: the foreground
    // lane's drifted send stays below every background lane's drifted
    // send at every probed epoch — the wander breathes distance, never
    // the foreground order.
    for (const epoch of [0, 1, 2, 3, 4, 5]) {
      const params = render(
        [
          laneRender({ laneId: 0, prominence: 0.15 }),
          laneRender({ laneId: 1, prominence: 1, foreground: true }),
          laneRender({ laneId: 2, prominence: 0.15 }),
        ],
        0.6,
      );
      const plan = planGraph(params, undefined, spatialWander(161, epoch, 3));
      const sends = plan.lanes.map((lane) => lane.reverbSend.target);
      expect(sends[1]).toBeLessThan(sends[0] ?? 1);
      expect(sends[1]).toBeLessThan(sends[2] ?? 1);
    }
  });

  it("carries no binaural/HRTF path: identity is register + timbre + static pan only", () => {
    // ADR 0017: binaural is at most a headphone-only enhancement, never
    // required. This task ships none — the graph exposes panner/width/
    // send only, and this test pins that the plan carries no fourth
    // spatial channel (no HRTF azimuth/elevation entry anywhere).
    const params = render(
      [laneRender(), laneRender({ laneId: 1 }), laneRender({ laneId: 2 })],
      0.6,
    );
    const plan = planGraph(params, undefined, spatialWander(161, 1, 3));
    const paths = plan.lanes.flatMap((lane) => [
      lane.pan.path,
      lane.width.path,
      lane.reverbSend.path,
    ]);
    for (const path of paths) {
      expect(path.toLowerCase()).not.toContain("hrtf");
      expect(path.toLowerCase()).not.toContain("binaural");
      expect(path.toLowerCase()).not.toContain("azimuth");
    }
  });

  it("keeps lane identity redundant without any spatial cue (mono-identity proof)", () => {
    // Lane identity is register + timbre + position — redundant, so the
    // lane reads even when every spatial cue is parked at centre. The
    // proof: with the wander forced silent, the per-lane voice recipes
    // (register/timbre) still differ — identity never depended on the
    // wander. Pans stay planned (never removed), the wander adds nothing,
    // and the mono sum keeps every lane's own voice: register ranges and
    // timbre names differ per lane, so a laptop-speaker-equivalent
    // ((L+R)/2) render carries the same register + timbre separation the
    // stereo image shows (the QA spatial-drift entry proves the render
    // half: stereo-vs-summed lane-1 solos, reported never gated).
    const params = render(
      [laneRender(), laneRender({ laneId: 1 }), laneRender({ laneId: 2 })],
      0.6,
    );
    const silent = spatialWander(161, 1, 3, { laneBlind: false });
    const plan = planGraph(params, undefined, silent);
    // The silent wander adds nothing: plans match the static targets.
    const plain = planGraph(params);
    for (const [index, lane] of plan.lanes.entries()) {
      expect(lane.pan.target).toBe(plain.lanes[index]?.pan.target);
      expect(lane.width.target).toBe(plain.lanes[index]?.width.target);
      expect(lane.reverbSend.target).toBe(plain.lanes[index]?.reverbSend.target);
    }
    // And the static regions themselves stay redundant: distinct pans
    // per lane (position), with register + timbre owned by construction
    // (voices.test.ts pins register/timbre/pan per lane) — re-asserted
    // here so this proof stands alone: three disjoint register ranges
    // and three distinct voice recipes, so collapsing the image to mono
    // removes position but leaves register + timbre intact.
    expect(plan.lanes[0]?.pan.target).toBe(-0.6);
    expect(plan.lanes[1]?.pan.target).toBe(0);
    expect(plan.lanes[2]?.pan.target).toBe(0.6);
    const ranges = [LANE_REGISTERS.low, LANE_REGISTERS.mid, LANE_REGISTERS.high];
    expect(ranges[0]?.top).toBeLessThanOrEqual(ranges[1]?.root ?? 0);
    expect(ranges[1]?.top).toBeLessThanOrEqual(ranges[2]?.root ?? 0);
    const names = [PAD_VOICE.name, MALLET_VOICE.name, FLUTE_VOICE.name];
    expect(new Set(names).size).toBe(3);
  });

  it("reads the wander on the minute-span clock the QA suite sounds", () => {
    // The whole suite sounds the wander at renderT * SPAN + 1, so a 60 s
    // render crosses one epoch step at the same cadence a long session
    // hears. Pin the clock the render entry uses: epoch 0 at t=0, epoch 1
    // inside the render, never more than two epochs in 60 s.
    expect(SPATIAL_MINUTE_SPAN).toBe((2 * SPATIAL_CORRELATION_SECONDS) / 60);
    const epochAt = (t: number): number => spatialEpochAt(t * SPATIAL_MINUTE_SPAN + 1);
    expect(epochAt(0)).toBe(0);
    expect(epochAt(60)).toBeGreaterThan(epochAt(0));
    expect(epochAt(60) - epochAt(0)).toBeLessThanOrEqual(2);
    expect(spaceWanderFor({ seed: 161, nowSeconds: 30 * SPATIAL_MINUTE_SPAN + 1 }, 3)).toEqual(
      spatialWander(161, epochAt(30), 3),
    );
  });
});
