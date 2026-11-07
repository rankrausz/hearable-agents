// packages/audio/test/seats.test.ts — separability evidence for the four
// seats (p7b-t03, ADR 0024). What this is for: showing, not assuming, that
// every pair of seats is told apart by register or by image inside the
// spatial wander's safe windows, and naming the one pair that summed to
// mono separates by timbre alone. What it must not do: judge how the seats
// sound — that is the p7b-t04 renders and the owner's ear.

import { LANE_CAP } from "@hearable/core";
import { describe, expect, it } from "vitest";
import {
  candidatesForLane,
  registerForEnsembleLane,
  startPitchForLane,
} from "../src/ensemble/index.js";
import { gestureEvents } from "../src/gestures/index.js";
import { GESTURE_NOTE_ATTACK_S } from "../src/gestures/player.js";
import { panForLane, recipeForLane, registerForLane } from "../src/graph/index.js";
import {
  clampSpatialPan,
  SPATIAL_PAN_AMPLITUDE,
  SPATIAL_PAN_REGION_GAP,
  spatialWander,
} from "../src/index.js";
import {
  LANE_REGISTER_ORDER,
  LANE_REGISTERS,
  LANE_TIMBRES,
  LANE_WIDTH,
  VOICE_OUTPUT_TRIM_DB,
} from "../src/scenes/clearing/index.js";

const lanes = Array.from({ length: LANE_CAP }, (_, index) => index);
const pairs = lanes.flatMap((a) => lanes.filter((b) => b > a).map((b) => [a, b] as const));

/** Pan window a seat's wander is clamped into. */
function panWindow(lane: number): { readonly min: number; readonly max: number } {
  return { min: clampSpatialPan(-Infinity, lane), max: clampSpatialPan(Infinity, lane) };
}

/** Semitones two seats' registers share beyond a single boundary note. */
function registerOverlap(a: number, b: number): number {
  const ra = LANE_REGISTERS[registerForLane(a)];
  const rb = LANE_REGISTERS[registerForLane(b)];
  return Math.max(0, Math.min(ra.top, rb.top) - Math.max(ra.root, rb.root));
}

/** Gap between two seats' pan windows (negative when they overlap). */
function panGap(a: number, b: number): number {
  const wa = panWindow(a);
  const wb = panWindow(b);
  return Math.max(wa.min, wb.min) - Math.min(wa.max, wb.max);
}

describe("four seats", () => {
  it("backs every lane index up to the cap with its own seat, and no more", () => {
    expect(LANE_REGISTER_ORDER).toHaveLength(LANE_CAP);
    expect(new Set(LANE_REGISTER_ORDER).size).toBe(LANE_CAP);
    expect(lanes.map(registerForLane)).toEqual(["low", "mid", "high", "upper"]);
    expect(lanes.map(registerForEnsembleLane)).toEqual(["low", "mid", "high", "upper"]);
    expect(new Set(lanes.map((lane) => recipeForLane(lane).name)).size).toBe(LANE_CAP);
  });

  it("keeps the three existing seats byte-unchanged in register, timbre, pan and trim", () => {
    expect(LANE_REGISTERS.low).toEqual({ root: 33, top: 52 });
    expect(LANE_REGISTERS.mid).toEqual({ root: 52, top: 69 });
    expect(LANE_REGISTERS.high).toEqual({ root: 69, top: 88 });
    expect([LANE_TIMBRES.low, LANE_TIMBRES.mid, LANE_TIMBRES.high]).toEqual([
      "pad",
      "mallet",
      "flute",
    ]);
    expect([panForLane(0), panForLane(1), panForLane(2)]).toEqual([-0.6, 0, 0.6]);
    expect([VOICE_OUTPUT_TRIM_DB.low, VOICE_OUTPUT_TRIM_DB.mid, VOICE_OUTPUT_TRIM_DB.high]).toEqual(
      [-3.6, -2.6, -7.6],
    );
    expect(LANE_WIDTH).toBe(0.2);
  });

  it("seats the fourth voice per the p7b-t01 table without asking for level", () => {
    expect(LANE_REGISTERS.upper).toEqual({ root: 69, top: 81 });
    expect(panForLane(3)).toBe(0);
    expect(LANE_TIMBRES.upper).toBe("glass");
    // The budget takes, it does not give: no louder than the quietest seat.
    expect(VOICE_OUTPUT_TRIM_DB.upper).toBeLessThan(
      Math.min(VOICE_OUTPUT_TRIM_DB.low, VOICE_OUTPUT_TRIM_DB.mid, VOICE_OUTPUT_TRIM_DB.high),
    );
  });

  it("separates every pair by register or by pan window, inside the wander", () => {
    for (const [a, b] of pairs) {
      const collides = registerOverlap(a, b) > 0;
      const shareImage = panGap(a, b) < SPATIAL_PAN_REGION_GAP - 1e-9;
      expect({ a, b, collides, shareImage }).not.toMatchObject({
        collides: true,
        shareImage: true,
      });
    }
  });

  it("keeps laterally distinct seats at least the region gap apart at every wander epoch", () => {
    for (let epoch = 0; epoch < 50; epoch += 1) {
      const wander = spatialWander(161, epoch, LANE_CAP);
      const drifted = lanes.map((lane) =>
        clampSpatialPan(panForLane(lane) + (wander.pan[lane] ?? 0), lane),
      );
      for (const [a, b] of pairs) {
        if (panForLane(a) === panForLane(b)) continue;
        expect(Math.abs((drifted[a] ?? 0) - (drifted[b] ?? 0))).toBeGreaterThanOrEqual(
          SPATIAL_PAN_REGION_GAP - 1e-9,
        );
      }
      // The upper seat wanders inside the mid seat's own centre window.
      expect(Math.abs(drifted[3] ?? 0)).toBeLessThanOrEqual(SPATIAL_PAN_AMPLITUDE + 1e-9);
    }
  });

  it("gives no two seats a shared planner pitch or construction pitch", () => {
    const starts = lanes.map(startPitchForLane);
    expect(new Set(starts).size).toBe(LANE_CAP);
    for (const [a, b] of pairs) {
      const shared = candidatesForLane(a).filter((midi) => candidatesForLane(b).includes(midi));
      expect({ a, b, shared }).toEqual({ a, b, shared: [] });
    }
  });

  it("voices upper-seat event cues as centred piano in a warm playable register", () => {
    for (const gesture of ["arrive", "question", "resolve"] as const) {
      const events = gestureEvents({ laneIndex: 3, gesture, at: 0 }, 0.6);
      const notes = events.filter((event) => event.kind === "note");
      expect(notes.length).toBeGreaterThan(0);
      expect(events.some((event) => event.kind === "breath")).toBe(false);
      for (const note of notes) {
        if (note.kind !== "note") continue;
        expect(note.midi).toBeGreaterThanOrEqual(48);
        expect(note.midi).toBeLessThanOrEqual(LANE_REGISTERS.upper.top);
        expect(note.pan).toBe(0);
        expect(note.instrument).toBe("piano");
        expect(note.attackS).toBeLessThanOrEqual(GESTURE_NOTE_ATTACK_S);
      }
    }
  });

  it("names upper vs high as the one pair that summed to mono separates by timbre alone", () => {
    // Stated limitation (docs/SOUND_DESIGN.md §Seats and allocation): once
    // the image is mono, pan is gone, so only pairs whose registers collide
    // lose a cue. Exactly one pair does, and it must at least differ in
    // timbre family. Its mono-summed separation is p7b-t04's headline read.
    const monoTimbreOnly = pairs.filter(([a, b]) => registerOverlap(a, b) > 0);
    expect(monoTimbreOnly).toEqual([[2, 3]]);
    expect(recipeForLane(2).name).not.toBe(recipeForLane(3).name);
    const flute = recipeForLane(2).oscillators.map(
      (osc) => osc.midi - (recipeForLane(2).oscillators[0]?.midi ?? 0),
    );
    const glass = recipeForLane(3).oscillators.map(
      (osc) => osc.midi - (recipeForLane(3).oscillators[0]?.midi ?? 0),
    );
    expect(flute).toEqual([0, 0]);
    expect(glass).toEqual([0, 12]);
  });
});
