// Shared sound lab test inputs: daemon signals and the scene targets core
// renders for them. What this is for: giving the lab's pure tests a real
// SceneParams. What it must not do: hand-build scene targets core never makes.

import { macroPresence, renderWithMacro, type SceneParams } from "@hearable/core";
import { sceneRendersForAudio } from "./audio.js";
import type { LaneSignal } from "./protocol.js";

export function signal(overrides: Partial<LaneSignal> = {}): LaneSignal {
  return {
    laneId: 1,
    sessionId: "session-a",
    agent: "claude-code",
    lifecycleConfidence: "observed",
    lifecycle: "active",
    fidelity: null,
    mode: { exploring: 0.4, editing: 0.6, testing: 0, other: 0 },
    displayedMode: "editing",
    activity: 0.7,
    progress: 0.3,
    struggle: 0.1,
    lastEventAt: 10_000,
    reasons: [{ at: 9_000, signal: "activity", text: "Edited src/app.ts" }],
    prominence: 0.6,
    foreground: true,
    gestures: [],
    ...overrides,
  };
}

export function sceneFor(signals: readonly LaneSignal[], serverTime = 10_000): SceneParams {
  const renders = sceneRendersForAudio(signals);
  return renderWithMacro(renders, 0.3, {
    nowSeconds: serverTime / 1000,
    seed: 7,
    presence: macroPresence(renders),
    calm: 0.3,
    applyWorld: true,
  });
}
