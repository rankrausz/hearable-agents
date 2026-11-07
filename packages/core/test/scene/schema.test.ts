// packages/core/test/scene/schema.test.ts — boundary tests for the
// scene schemas: `LaneRender` accepts the engine subset plus synthetic
// attention fields, rejects out-of-range signals and unknown keys, and
// `SceneParams` round-trips a render (plain JSON-able data, no Tone.js).

import { describe, expect, it } from "vitest";

import { LaneRenderSchema, render, SceneParamsSchema } from "../../src/index.js";

describe("scene schemas", () => {
  it("accepts a full lane render with synthetic attention fields", () => {
    const parsed = LaneRenderSchema.safeParse({
      laneId: 2,
      lifecycle: "waiting",
      waitingReason: "permission",
      mode: { exploring: 0.5, editing: 0.25, testing: 0.15, other: 0.1 },
      displayedMode: "exploring",
      activity: 0.7,
      progress: 0.4,
      struggle: 0.65,
      prominence: 0.9,
      foreground: true,
      gestures: [{ gesture: "question", at: 1000 }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown keys and out-of-range signals", () => {
    const extra = LaneRenderSchema.safeParse({
      laneId: 0,
      lifecycle: "active",
      mode: { exploring: 1, editing: 0, testing: 0, other: 0 },
      displayedMode: "exploring",
      activity: 0.5,
      progress: 0,
      struggle: 0,
      prominence: 0.25,
      foreground: false,
      gestures: [],
      agent: "claude-code",
    });
    expect(extra.success).toBe(false);
    const ranged = LaneRenderSchema.safeParse({
      laneId: 0,
      lifecycle: "active",
      mode: { exploring: 1, editing: 0, testing: 0, other: 0 },
      displayedMode: "exploring",
      activity: 1.5,
      progress: 0,
      struggle: 0,
      prominence: 0.25,
      foreground: false,
      gestures: [],
    });
    expect(ranged.success).toBe(false);
  });

  it("round-trips a render through JSON as plain data", () => {
    const scene = render(
      [
        {
          laneId: 0,
          lifecycle: "active",
          mode: { exploring: 0.6, editing: 0.3, testing: 0.1, other: 0 },
          displayedMode: "editing",
          activity: 0.8,
          progress: 0.2,
          struggle: 0.1,
          prominence: 0.25,
          foreground: false,
          gestures: [],
        },
      ],
      0.6,
    );
    const revived: unknown = JSON.parse(JSON.stringify(scene));
    expect(SceneParamsSchema.safeParse(revived).success).toBe(true);
  });
});
