// apps/web/src/protocol.test.ts — runtime wire guards for complete soundscape
// frames. What this is for: proving malformed LaneRender data is rejected while
// valid snapshot/event frames retain Calm and gesture fields. What it must not
// do: test daemon inference or audio scheduling.

import { describe, expect, it } from "vitest";
import { parseServerMessage } from "./protocol.js";

const signal = {
  laneId: 0,
  sessionId: "session-a",
  agent: "claude-code",
  lifecycleConfidence: "observed",
  lifecycle: "waiting",
  waitingReason: "question",
  fidelity: null,
  mode: { exploring: 0.2, editing: 0.3, testing: 0.4, other: 0.1 },
  displayedMode: "testing",
  activity: 0.7,
  progress: 0.4,
  struggle: 0.2,
  lastEventAt: 1000,
  reasons: [],
  prominence: 0.9,
  foreground: true,
  gestures: [{ gesture: "question", at: 1000 }],
} as const;

const lane = {
  laneId: 0,
  state: "active",
  sessions: [
    {
      sessionId: "session-a",
      agent: "claude-code",
      name: "workspace",
      firstSeenAt: 1,
      lastActivityAt: 2,
    },
  ],
} as const;

describe("the browser wire guard", () => {
  it("retains full LaneRender fields and Calm", () => {
    const frame = parseServerMessage({
      type: "snapshot",
      lanes: [lane],
      queued: [],
      serverTime: 1000,
      calm: 0.35,
      signals: [signal],
    });

    expect(frame).toMatchObject({ calm: 0.35, signals: [signal] });
  });

  it("rejects malformed gesture fields without throwing", () => {
    const frame = parseServerMessage({
      type: "events",
      events: [],
      serverTime: 1000,
      calm: 0.6,
      signals: [{ ...signal, gestures: [{ gesture: "unknown", at: 1000 }] }],
    });

    expect(frame).toBeNull();
  });
});
