// packages/audio/src/ensemble/timeline.ts — the shared A/B slice timeline.
// What this is for: the ONE representative 150 s semantic trajectory both
// versions sound — normal activity, a busy/quiet pair, and waiting +
// completion with their existing hard cues — so scheduling is the only
// experimental variable. Drives the scheduler inputs (smoothed readings)
// and the gesture triggers the existing gesture path sounds. What it must
// not do: invent agent inference, touch audio, or redefine the waiting
// grammar — question/resolve keep their production shapes.

import type { LaneRender } from "@hearable/core";

/** Slice length in seconds (2–3 minute versions). */
export const AB_SLICE_S = 150;

/** Calm for both renders (production default). */
export const AB_CALM = 0.6;

/** Seed for voices, palette, loudness and drift in both renders. */
export const AB_SEED = 161;

/** One lane snapshot at a slice time. */
export type AbTimelineStep = {
  /** Seconds from slice start. */
  readonly atS: number;
  /** The lane renders from this time until the next step. */
  readonly lanes: readonly LaneRender[];
};

function lane(
  laneId: number,
  mode: LaneRender["mode"],
  overrides: Partial<LaneRender> = {},
): LaneRender {
  const displayedMode =
    (Object.entries(mode).sort(([, left], [, right]) => right - left)[0]?.[0] as
      | LaneRender["displayedMode"]
      | undefined) ?? "other";
  return {
    laneId,
    lifecycle: "active",
    mode,
    displayedMode,
    activity: 0.65,
    progress: 0.35,
    struggle: 0.1,
    prominence: laneId === 1 ? 0.7 : 0.35,
    foreground: laneId === 1,
    gestures: [],
    ...overrides,
  };
}

function exploring(): LaneRender["mode"] {
  return { exploring: 0.65, editing: 0.2, testing: 0.05, other: 0.1 };
}

function editing(): LaneRender["mode"] {
  return { exploring: 0.15, editing: 0.65, testing: 0.1, other: 0.1 };
}

function testing(): LaneRender["mode"] {
  return { exploring: 0.1, editing: 0.2, testing: 0.6, other: 0.1 };
}

/**
 * The shared trajectory: three routine lanes in mixed modes; lane 0 runs
 * quiet (low activity) against lane 1's busy stretch; lane 2 enters
 * waiting at 60 s (question) and completes at 110 s (resolve + 4 s fade).
 * Progress rises on lane 1 twice (0.55 → 0.75 at 90 s, → 0.9 at 120 s):
 * two fresh evidence steps the hybrid may move on; struggle stays low so
 * stuck voicing never dominates.
 */
export function abTimeline(): readonly AbTimelineStep[] {
  const base = (waiting: boolean, complete: boolean): LaneRender[] => [
    lane(0, exploring(), { activity: 0.25, progress: 0.2 }),
    lane(1, editing(), { activity: 0.85, progress: 0.55 }),
    waiting
      ? lane(2, testing(), {
          lifecycle: "waiting",
          activity: 0.4,
          progress: 0.3,
          gestures: [{ gesture: "question", at: 60 }],
        })
      : complete
        ? lane(2, testing(), {
            lifecycle: "turn_complete",
            gestures: [{ gesture: "resolve", at: 110 }],
          })
        : lane(2, testing(), { activity: 0.55, progress: 0.3 }),
  ];
  return [
    { atS: 0, lanes: base(false, false) },
    {
      atS: 30,
      lanes: base(false, false).map((item) =>
        item.laneId === 1 ? { ...item, mode: testing(), displayedMode: "testing" as const } : item,
      ),
    },
    { atS: 60, lanes: base(true, false) },
    {
      atS: 90,
      lanes: base(true, false).map((item) =>
        item.laneId === 1 ? { ...item, progress: 0.75 } : item,
      ),
    },
    { atS: 110, lanes: base(false, true) },
    {
      atS: 120,
      lanes: base(false, false).map((item) =>
        item.laneId === 1 ? { ...item, progress: 0.9 } : item,
      ),
    },
  ];
}

/** Lanes active at time `t` (last step at or before `t`). */
export function lanesAt(t: number, steps: readonly AbTimelineStep[] = abTimeline()): LaneRender[] {
  let lanes: readonly LaneRender[] = steps[0]?.lanes ?? [];
  for (const step of steps) {
    if (step.atS <= t) lanes = step.lanes;
    else break;
  }
  return [...lanes];
}

/** Fade progress for turn_complete lanes (0 at resolve, 1 at +4 s). */
export function abFadeProgress(lanes: readonly LaneRender[], t: number): readonly number[] {
  return lanes.map((item) =>
    item.lifecycle === "turn_complete" ? Math.min(1, Math.max(0, (t - 110) / 4)) : 0,
  );
}
