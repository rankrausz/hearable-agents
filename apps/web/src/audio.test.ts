// apps/web/src/audio.test.ts — pure checks around the browser audio boundary.
// What this is for: proving daemon-time gestures are converted to the audio
// clock before the existing player sees them. What it must not do: construct a
// Tone graph or make an audibility judgement.

import { LANE_CAP, macroPresence, renderWithMacro } from "@hearable/core";
import { describe, expect, it } from "vitest";
import { applyMixer, laneRenderForAudio, sceneRendersForAudio } from "./audio.js";

describe("live audio frame mapping", () => {
  it("converts daemon gesture milliseconds to audio seconds", () => {
    const render = laneRenderForAudio({
      laneId: 1,
      sessionId: "session-b",
      agent: "codex",
      lifecycleConfidence: "inferred",
      lifecycle: "waiting",
      fidelity: null,
      mode: { exploring: 0, editing: 1, testing: 0, other: 0 },
      displayedMode: "editing",
      activity: 0.5,
      progress: 0.2,
      struggle: 0.1,
      lastEventAt: 1200,
      reasons: [],
      prominence: 0.5,
      foreground: false,
      gestures: [{ gesture: "question", at: 1200 }],
    });

    expect(render.gestures).toEqual([{ gesture: "question", at: 1.2 }]);
  });

  it("fills missing graph lanes with silent idle renders and keeps sparse lane ids seated", () => {
    const signal = {
      laneId: 2,
      sessionId: "session-c",
      agent: "claude-code",
      lifecycleConfidence: "observed" as const,
      lifecycle: "active" as const,
      fidelity: null,
      mode: { exploring: 1, editing: 0, testing: 0, other: 0 },
      displayedMode: "exploring" as const,
      activity: 1,
      progress: 0,
      struggle: 0,
      lastEventAt: 1200,
      reasons: [],
      prominence: 1,
      foreground: true,
      gestures: [],
    };

    expect(sceneRendersForAudio([signal])).toMatchObject([
      { laneId: 0, lifecycle: "idle", activity: 0 },
      { laneId: 1, lifecycle: "idle", activity: 0 },
      { laneId: 2, lifecycle: "active", activity: 1 },
      { laneId: 3, lifecycle: "idle", activity: 0 },
    ]);
    // One render per seat: the pad follows the one declared lane cap.
    expect(sceneRendersForAudio([signal])).toHaveLength(LANE_CAP);
    // And the empty fourth seat changes nothing for the three seats: the
    // same mix and macro inputs as the pre-fourth-seat three-lane frame.
    const padded = sceneRendersForAudio([signal]);
    const three = sceneRendersForAudio([signal], 3);
    expect(macroPresence(padded)).toBe(macroPresence(three));
    const world = (frame: typeof padded) =>
      renderWithMacro(frame, 0.6, {
        nowSeconds: 120,
        seed: 7,
        presence: macroPresence(frame),
        calm: 0.6,
        applyWorld: true,
      });
    const paddedParams = world(padded);
    const threeParams = world(three);
    expect(paddedParams.lanes.slice(0, 3)).toEqual(threeParams.lanes);
    expect(paddedParams.macro).toEqual(threeParams.macro);
    expect(paddedParams.bed).toEqual(threeParams.bed);
    expect(paddedParams.densityScale).toBe(threeParams.densityScale);
  });

  it("applies lane gain and mute before rendering live audio", () => {
    const signal = {
      laneId: 0,
      sessionId: "session-a",
      agent: "claude-code",
      lifecycleConfidence: "observed" as const,
      lifecycle: "active" as const,
      fidelity: null,
      mode: { exploring: 1, editing: 0, testing: 0, other: 0 },
      displayedMode: "exploring" as const,
      activity: 0.8,
      progress: 0.6,
      struggle: 0.4,
      lastEventAt: 1200,
      reasons: [],
      prominence: 0.7,
      foreground: true,
      gestures: [{ gesture: "attention" as const, at: 1200 }],
    };
    expect(applyMixer([signal], { 0: { gain: 0.5, muted: false } })[0]).toMatchObject({
      activity: 0.4,
      progress: 0.3,
      struggle: 0.2,
      prominence: 0.35,
      foreground: true,
    });
    expect(
      applyMixer([{ ...signal, lifecycle: "waiting" }], { 0: { gain: 0, muted: false } })[0],
    ).toMatchObject({ lifecycle: "idle", gestures: [] });
    expect(applyMixer([signal], { 0: { gain: 1, muted: true } })[0]).toMatchObject({
      lifecycle: "idle",
      activity: 0,
      gestures: [],
      foreground: false,
    });
  });
});
