// packages/core/test/scene/agent-blind.test.ts — the agent-blindness
// property: `render` reads no agent identity, so identical `LaneRender`
// values produce identical `SceneParams`. The schema enforces the strong
// half (there is no agent field to branch on); this suite proves the
// behavioural half across a seeded sweep of the input space.

import { describe, expect, it } from "vitest";
import { type LaneRender, LaneRenderSchema, render, SceneParamsSchema } from "../../src/index.js";
import { createRng } from "../../src/rng.js";

function sweepLane(random: () => number, laneId: number): LaneRender {
  const lifecycles: readonly LaneRender["lifecycle"][] = [
    "idle",
    "active",
    "quiet",
    "stale",
    "waiting",
    "turn_complete",
  ];
  const modes: readonly LaneRender["displayedMode"][] = [
    "exploring",
    "editing",
    "testing",
    "other",
  ];
  const pick = <T>(values: readonly T[]): T => {
    const chosen = values[Math.floor(random() * values.length)];
    if (chosen === undefined) throw new Error("sweep generator picked an empty bucket");
    return chosen;
  };
  const weights = [random(), random(), random(), random()];
  const sum = weights.reduce((total, weight) => total + (weight ?? 0), 0);
  const share = (index: number): number => (weights[index] ?? 0) / sum;
  return {
    laneId,
    lifecycle: pick(lifecycles),
    mode: {
      exploring: share(0),
      editing: share(1),
      testing: share(2),
      other: share(3),
    },
    displayedMode: pick(modes),
    activity: random(),
    progress: random(),
    struggle: random(),
    prominence: random(),
    foreground: random() > 0.5,
    gestures: [],
  };
}

describe("agent-blind scene mapping", () => {
  it("produces identical scenes for identical renders across a seeded sweep", () => {
    const rng = createRng(20260907);
    for (let trial = 0; trial < 200; trial += 1) {
      const count = 1 + Math.floor(rng.next() * 3);
      const lanes: LaneRender[] = Array.from({ length: count }, (_, index) =>
        sweepLane(rng.next, index),
      );
      const calm = rng.next();
      // Two renders with the same field values but built independently.
      const twin: LaneRender[] = JSON.parse(JSON.stringify(lanes)) as LaneRender[];
      expect(render(twin, calm)).toEqual(render(lanes, calm));
    }
  });

  it("rejects an agent field on the input contract", () => {
    const parsed = LaneRenderSchema.safeParse({
      ...sweepLane(createRng(1).next, 0),
      agent: "codex",
    });
    expect(parsed.success).toBe(false);
  });

  it("emits schema-valid scenes on the sweep", () => {
    const rng = createRng(77);
    for (let trial = 0; trial < 50; trial += 1) {
      const lanes = [sweepLane(rng.next, 0), sweepLane(rng.next, 1)];
      expect(SceneParamsSchema.safeParse(render(lanes, rng.next())).success).toBe(true);
    }
  });
});
