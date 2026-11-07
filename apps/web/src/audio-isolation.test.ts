// Sound lab isolation checks. What this is for: proving solo and mute reach the
// right sources and leave everything else, and the un-isolated mix, untouched.
// What it must not do: build a Tone graph or judge how anything sounds.

import { describe, expect, it } from "vitest";
import {
  groupAudible,
  isAudible,
  isolateParams,
  NO_ISOLATION,
  soloOnly,
  toggleMute,
  toggleSolo,
} from "./audio-isolation.js";
import { sceneFor, signal } from "./audio-test-inputs.js";

const params = sceneFor([
  signal({ laneId: 0, sessionId: "a" }),
  signal({ laneId: 1, sessionId: "b", lifecycle: "waiting", waitingReason: "permission" }),
]);

describe("sound lab isolation", () => {
  it("leaves the mix exactly as planned when nothing is isolated", () => {
    expect(isolateParams(params, NO_ISOLATION)).toBe(params);
  });

  it("hears only the soloed lane layer, and silences the world with it", () => {
    const out = isolateParams(params, toggleSolo(NO_ISOLATION, "lane:0:grain"));
    expect(out.lanes[0]?.grain.gain).toBe(params.lanes[0]?.grain.gain);
    expect(out.lanes[0]?.grain.gain).toBeGreaterThan(0);
    expect(out.lanes[0]?.air.gain).toBe(0);
    expect(out.lanes[1]?.grain.gain).toBe(0);
    expect(out.lanes[1]?.tension).toEqual({ on: false, gain: 0 });
    expect(out.macro.fieldGain).toBe(0);
    expect(out.macro.textureSwell).toBe(0);
    expect(out.densityScale).toBe(0);
    expect(out.bed.gainDbfs).toBeLessThan(-90);
  });

  it("mutes one layer on every seat without touching the rest", () => {
    const out = isolateParams(params, toggleMute(NO_ISOLATION, "layer:grain"));
    expect(out.lanes.every((lane) => lane.grain.gain === 0)).toBe(true);
    expect(out.lanes[0]?.air.gain).toBe(params.lanes[0]?.air.gain);
    expect(out.macro).toEqual(params.macro);
    expect(out.bed).toEqual(params.bed);
  });

  it("lets a mute inside a soloed lane win", () => {
    const isolation = toggleMute(toggleSolo(NO_ISOLATION, "lane:1"), "lane:1:tension");
    expect(isAudible(isolation, "lane:1:grain")).toBe(true);
    expect(isAudible(isolation, "lane:1:tension")).toBe(false);
    expect(isAudible(isolation, "lane:0:grain")).toBe(false);
    expect(isAudible(isolation, "world:drone")).toBe(false);
  });

  it("keeps the waiting pad when its lane is soloed", () => {
    const out = isolateParams(params, toggleSolo(NO_ISOLATION, "lane:1"));
    expect(params.lanes[1]?.tension.on).toBe(true);
    expect(out.lanes[1]?.tension).toEqual(params.lanes[1]?.tension);
  });

  it("treats a group as heard when only one of its layers is soloed", () => {
    const isolation = toggleSolo(NO_ISOLATION, "lane:2:pulse");
    expect(groupAudible(isolation, "lane:2", [0, 1, 2, 3])).toBe(true);
    expect(groupAudible(isolation, "lane:0", [0, 1, 2, 3])).toBe(false);
  });

  it("toggles an exclusive solo off on the second press", () => {
    const once = soloOnly(toggleSolo(NO_ISOLATION, "world"), "lane:0");
    expect(once.solo).toEqual(["lane:0"]);
    expect(soloOnly(once, "lane:0").solo).toEqual([]);
  });
});
