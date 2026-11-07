// Policy regression cases: ongoing work is not the same thing as a connected session.
import { describe, expect, it } from "vitest";
import { COMPLETION_TAIL_MS, ongoing, playbackWanted } from "./playback-policy.js";
import type { LaneSignal } from "./protocol.js";

const signal = (lifecycle: LaneSignal["lifecycle"]): LaneSignal => ({
  laneId: 0,
  sessionId: "one",
  agent: "codex",
  lifecycle,
  lifecycleConfidence: "observed",
  fidelity: null,
  mode: { exploring: 1, editing: 0, testing: 0, other: 0 },
  displayedMode: "exploring",
  activity: 0,
  progress: 0,
  struggle: 0,
  lastEventAt: 1000,
  reasons: [],
  prominence: 0.5,
  foreground: false,
  gestures: [],
});
describe("activity-only playback", () => {
  it.each(["active", "quiet", "waiting"] as const)(
    "keeps %s audible even without tool activity",
    (state) => {
      expect(ongoing(signal(state))).toBe(true);
      expect(playbackWanted([signal(state)], "activity", true, 20_000)).toBe(true);
    },
  );
  it.each(["idle", "stale"] as const)("does not treat %s as ongoing work", (state) => {
    expect(playbackWanted([signal(state)], "activity", true, 20_000)).toBe(false);
  });
  it("lets completion finish but never opens on an old completion snapshot", () => {
    expect(
      playbackWanted([signal("turn_complete")], "activity", true, 1000 + COMPLETION_TAIL_MS - 1),
    ).toBe(true);
    expect(
      playbackWanted([signal("turn_complete")], "activity", true, 1000 + COMPLETION_TAIL_MS),
    ).toBe(false);
    expect(playbackWanted([signal("turn_complete")], "activity", true, 0)).toBe(false);
  });
  it("finishes an inferred resolve even when its last event is old and the next frame is idle", () => {
    const completed = {
      ...signal("turn_complete"),
      lifecycleConfidence: "inferred" as const,
      gestures: [{ gesture: "resolve" as const, at: 121_000 }],
    };
    expect(playbackWanted([completed], "activity", true, 121_000)).toBe(true);
    expect(playbackWanted([{ ...completed, lifecycle: "idle" }], "activity", true, 127_000)).toBe(
      true,
    );
    expect(playbackWanted([{ ...completed, lifecycle: "idle" }], "activity", true, 129_000)).toBe(
      false,
    );
    expect(playbackWanted([{ ...completed, lifecycle: "idle" }], "activity", true, 120_000)).toBe(
      false,
    );
  });

  it("a second agent waiting keeps playback alive after the first completes", () => {
    expect(
      playbackWanted(
        [signal("idle"), { ...signal("waiting"), laneId: 2 }],
        "activity",
        true,
        50_000,
      ),
    ).toBe(true);
  });
  it("continuous mode keeps the ambient bed but a lost feed silences either mode", () => {
    expect(playbackWanted([], "continuous", true, 0)).toBe(true);
    expect(playbackWanted([], "activity", true, 0)).toBe(false);
    for (const mode of ["activity", "continuous"] as const) {
      expect(playbackWanted([signal("waiting")], mode, false, 0)).toBe(false);
    }
  });
});
