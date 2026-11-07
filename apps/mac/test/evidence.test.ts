// Checks the evidence accounting with literal observations; must not fabricate a passing endurance run.
import { expect, it } from "vitest";
import { summarizeEvidence } from "./evidence.js";

it("reports a lapse and takeback and includes the full heartbeat gap across sleep", () => {
  const summary = summarizeEvidence(
    [
      { at: 0, kind: "election", ownerId: "a" },
      { at: 500, kind: "heartbeat" },
      { at: 1000, kind: "suspend" },
      { at: 4000, kind: "election", ownerId: null },
      { at: 4500, kind: "resume" },
      { at: 5000, kind: "heartbeat" },
      { at: 5001, kind: "election", ownerId: "a" },
      { at: 1000, kind: "visibility", visible: false },
    ],
    100,
    6000,
  );
  expect(summary).toMatchObject({
    lapses: 1,
    takebacks: 1,
    longestGapMs: 4500,
    sleepWake: true,
    allWindowsHidden: true,
    qualifies: false,
  });
});
it("never qualifies a short run or an hour without heartbeat and visibility evidence", () => {
  expect(summarizeEvidence([], 0, 3_600_000).qualifies).toBe(false);
  expect(summarizeEvidence([{ at: 500, kind: "heartbeat" }], 0, 1000).qualifies).toBe(false);
});

it("counts an owner change even when a handoff passes through an unowned interval", () => {
  expect(
    summarizeEvidence(
      [
        { at: 0, kind: "election", ownerId: "a" },
        { at: 1000, kind: "election", ownerId: null },
        { at: 2300, kind: "election", ownerId: "b" },
      ],
      100,
      3000,
    ),
  ).toMatchObject({ lapses: 1, ownerChanges: 1, takebacks: 0, qualifies: false });
});
