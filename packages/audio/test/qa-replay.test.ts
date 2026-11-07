// packages/audio/test/qa-replay.test.ts — behaviour tests for the p4-t06
// replay drives: fixture-shaped events folded through the live path
// (engine → attention → LaneRender) without reading fixtures or touching
// audio. What this is for: proving the replay drives carry engine signals
// plus attention prominence/foreground/gestures deterministically, so the
// browser QA numbers read the integrated mapping, not the sandbox sliders.
// What it must not do: import Tone, render audio, read fixture files, or
// assert anything audible — levels live in e2e/audio-qa.spec.ts.

import type { NormalizedEvent } from "@hearable/core";
import { describe, expect, it } from "vitest";
import {
  buildReplayDrive,
  REPLAY_CALMS,
  REPLAY_CAPABILITIES,
  REPLAY_WINDOWS,
  type ReplayLaneInput,
} from "../src/qa/replay.js";

function toolEvent(
  ts: number,
  kind: NormalizedEvent["kind"],
  extra: Record<string, unknown> = {},
): NormalizedEvent {
  return {
    v: 1,
    id: `replay-test-${kind}-${ts}`,
    ts,
    receivedAt: ts,
    agent: "claude-code",
    sessionId: "s1",
    kind,
    ...extra,
  } as NormalizedEvent;
}

function stuckLikeSession(anchor: number, spanS: number): NormalizedEvent[] {
  const events: NormalizedEvent[] = [
    toolEvent(anchor, "session.start"),
    toolEvent(anchor + 2500, "turn.start"),
  ];
  for (let t = 5; t < spanS; t += 5) {
    events.push(
      toolEvent(anchor + t * 1000, "tool.start", {
        tool: { name: "Read", category: "read", fingerprint: `fp-${t}`, target: "a.py" },
      }),
    );
    events.push(
      toolEvent(anchor + t * 1000 + 500, "tool.end", {
        tool: {
          name: "Read",
          category: "read",
          fingerprint: `fp-${t}`,
          target: "a.py",
          durationMs: 5,
          outcome: { ok: true, outputChars: 100 },
        },
      }),
    );
  }
  events.push(
    toolEvent(anchor + spanS * 1000, "turn.end", {
      lifecycle: { reason: "completed", confidence: "observed" },
    } as Record<string, unknown>),
  );
  return events;
}

function waitingLikeSession(anchor: number): NormalizedEvent[] {
  return [
    toolEvent(anchor, "session.start"),
    toolEvent(anchor + 1000, "turn.start"),
    toolEvent(anchor + 2000, "permission.request", {
      permission: { reason: "permission", confidence: "observed" },
    } as Record<string, unknown>),
  ];
}

function laneFor(
  agent: "claude-code" | "codex",
  events: NormalizedEvent[],
  laneId = 0,
): ReplayLaneInput {
  return { laneId, sessionId: "s1", agent, events };
}

describe("replay drives", () => {
  it("pins three Calm levels and three replay windows", () => {
    expect(REPLAY_CALMS).toEqual([0.3, 0.6, 0.9]);
    expect(Object.keys(REPLAY_WINDOWS).sort()).toEqual([
      "claude-stuck",
      "codex-stuck",
      "three-lane-mix",
    ]);
    for (const window of Object.values(REPLAY_WINDOWS)) {
      expect(window.endS - window.startS).toBeGreaterThanOrEqual(60);
    }
  });

  it("copies the adapters' declared capabilities without branching on them", () => {
    expect(REPLAY_CAPABILITIES["claude-code"].editEvents).toBe(true);
    expect(REPLAY_CAPABILITIES["claude-code"].questionEvents).toBe(true);
    expect(REPLAY_CAPABILITIES.codex.editEvents).toBe(false);
    expect(REPLAY_CAPABILITIES.codex.questionEvents).toBe(false);
  });

  it("builds the same drive twice from the same events", () => {
    const events = stuckLikeSession(1_700_000_000_000, 300);
    const options = { windowStartS: 170, windowEndS: 260, calm: 0.6 };
    expect(buildReplayDrive("claude-stuck", [laneFor("claude-code", events)], options)).toEqual(
      buildReplayDrive("claude-stuck", [laneFor("claude-code", events)], options),
    );
  });

  it("drives one step per second across the window in ascending time", () => {
    const drive = buildReplayDrive(
      "claude-stuck",
      [laneFor("claude-code", stuckLikeSession(1_700_000_000_000, 300))],
      { windowStartS: 170, windowEndS: 260, calm: 0.6 },
    );
    expect(drive.durationS).toBe(90);
    expect(drive.steps.length).toBe(91);
    expect(drive.steps[0]?.atS).toBe(0);
    expect(drive.steps.at(-1)?.atS).toBe(90);
    for (let i = 1; i < drive.steps.length; i += 1) {
      expect(drive.steps[i]?.atS).toBeGreaterThan(drive.steps[i - 1]?.atS ?? 0);
    }
  });

  it("carries engine lifecycles and attention prominence on every step", () => {
    const drive = buildReplayDrive(
      "three-lane-mix",
      [laneFor("claude-code", stuckLikeSession(1_700_000_000_000, 300), 0)],
      { windowStartS: 0, windowEndS: 90, calm: 0.6 },
    );
    for (const step of drive.steps) {
      expect(step.lanes).toHaveLength(1);
      const lane = step.lanes[0];
      expect(lane?.laneId).toBe(0);
      expect(lane?.mode.exploring).toBeGreaterThanOrEqual(0);
      expect(lane?.prominence).toBeGreaterThanOrEqual(0);
      expect(lane?.prominence).toBeLessThanOrEqual(1);
      expect(typeof lane?.foreground).toBe("boolean");
    }
    // Mid-window the active lane is prominent: attention computed it, not
    // a sandbox slider.
    const mid = drive.steps[45]?.lanes[0];
    expect(mid?.lifecycle).toBe("active");
    expect(mid?.prominence).toBeGreaterThan(0);
  });

  it("marks waiting identically for observed and inferred waiting", () => {
    const anchor = 1_700_000_000_000;
    const observed = buildReplayDrive(
      "three-lane-mix",
      [laneFor("claude-code", waitingLikeSession(anchor), 0)],
      { windowStartS: 0, windowEndS: 30, calm: 0.6 },
    );
    const inferredEvents = waitingLikeSession(anchor).map((event) =>
      event.kind === "permission.request"
        ? toolEvent(anchor + 2000, "turn.end", {
            lifecycle: { reason: "permission", confidence: "inferred" },
          } as Record<string, unknown>)
        : event,
    );
    const inferred = buildReplayDrive(
      "three-lane-mix",
      [laneFor("claude-code", inferredEvents, 0)],
      { windowStartS: 0, windowEndS: 30, calm: 0.6 },
    );
    expect(observed.waitingAtS).not.toBeNull();
    expect(inferred.waitingAtS).not.toBeNull();
    // Both waiting entries carry the identical question gesture shape —
    // the emission path reads lifecycle only, never confidence.
    const questionsAt = (atS: number | null, laneId: number): unknown =>
      atS === null ? null : laneId;
    expect(questionsAt(observed.waitingAtS, 0)).toBe(questionsAt(inferred.waitingAtS, 0));
    for (const drive of [observed, inferred]) {
      const firstWaiting = drive.steps.find((step) =>
        step.lanes.some((lane) => lane.lifecycle === "waiting"),
      );
      const questions = (firstWaiting?.lanes[0]?.gestures ?? []).filter(
        (gesture) => gesture.gesture === "question",
      );
      expect(questions.length).toBeGreaterThan(0);
      for (const question of questions) {
        expect(Object.keys(question).sort()).toEqual(["at", "gesture"]);
      }
    }
  });

  it("scales routine presence with Calm while waiting stays unmistakable", () => {
    const events = stuckLikeSession(1_700_000_000_000, 300);
    const atCalm = (calm: number): number =>
      buildReplayDrive("claude-stuck", [laneFor("claude-code", events)], {
        windowStartS: 170,
        windowEndS: 260,
        calm,
      }).steps[45]?.lanes[0]?.prominence ?? 0;
    // Routine (active, low struggle) presence falls as Calm rises.
    expect(atCalm(0.3)).toBeGreaterThan(atCalm(0.9));
  });

  it("sounds the calm track when the drive sweeps it", () => {
    const drive = buildReplayDrive(
      "three-lane-mix",
      [laneFor("claude-code", stuckLikeSession(1_700_000_000_000, 300), 0)],
      {
        windowStartS: 0,
        windowEndS: 90,
        calm: 0,
        calmTrack: [
          [45, 1],
          [90, 0],
        ],
      },
    );
    expect(drive.calmTrack).toEqual([
      [45, 1],
      [90, 0],
    ]);
    const early = drive.steps[10]?.lanes[0]?.prominence ?? 0;
    const mid = drive.steps[50]?.lanes[0]?.prominence ?? 0;
    expect(mid).toBeLessThanOrEqual(early);
  });
});
