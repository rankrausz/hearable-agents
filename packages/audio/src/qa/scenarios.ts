// packages/audio/src/qa/scenarios.ts — the eight Automated QA scenario
// inputs as pure data. What this is for: giving the browser QA entry one
// named drive per SOUND_DESIGN.md §Automated QA row (lane timelines,
// calm track, gesture triggers, seed), so the same names cover the
// sandbox presets, the GESTURE_SCENARIOS named inputs and the drift
// metric. What it must not do: import Tone, render audio, or assert
// anything — the browser entry renders these and metrics.ts measures.

import type { LaneRender } from "@hearable/core";
import type { GestureName } from "../gestures/index.js";
import { driveScenario, scenarioFor } from "../gestures/index.js";

/** The eight QA scenario names, exactly per SOUND_DESIGN.md §Automated QA. */
export type QaScenarioName =
  | "routine-3-lanes-calm06"
  | "near-silence-calm09"
  | "single-lane-modes"
  | "struggle-ramp"
  | "waiting-holds"
  | "resolve-fades"
  | "calm-sweep"
  | "foreground-switch"
  | "macro-evolution"
  | "spatial-drift"
  | "ensemble-ab-independent"
  | "ensemble-ab-hybrid"
  | "harmonic-field"
  | "empty-room"
  | "tonal-journey";

/** The nine QA scenario drives plus the p3-t16 spatial-drift entry. */

export const QA_SCENARIO_NAMES: readonly QaScenarioName[] = [
  "routine-3-lanes-calm06",
  "near-silence-calm09",
  "single-lane-modes",
  "struggle-ramp",
  "waiting-holds",
  "resolve-fades",
  "calm-sweep",
  "foreground-switch",
  "macro-evolution",
  "spatial-drift",
  "ensemble-ab-independent",
  "ensemble-ab-hybrid",
  "harmonic-field",
  "empty-room",
  "tonal-journey",
];

/** Fixed RNG seed shared by every QA render (reproducibility check). */
export const QA_SEED = 0x0a1;

/** Render length per scenario in seconds. */
export const QA_DURATIONS: Record<QaScenarioName, number> = {
  "routine-3-lanes-calm06": 60,
  "near-silence-calm09": 30,
  "single-lane-modes": 60,
  "struggle-ramp": 60,
  "waiting-holds": 30,
  "resolve-fades": 30,
  "calm-sweep": 60,
  "foreground-switch": 60,
  // Long enough to cross at least one seeded macro boundary: the first
  // checkpoint ends 60–240 s in, so a 240 s render always hears the
  // world re-voice at least once.
  "macro-evolution": 240,
  // Slow spatial movement (p3-t16, ADR 0017): a 60 s routine render with
  // the wander on the minute-span clock — long enough to cross one
  // wander epoch inside the render, so the stereo image breathes the
  // way a long session hears it. REPORTED, never gated: the entry
  // proves the motion rides declared ramps without lifting a level the
  // mix cannot separate from the floor.
  "spatial-drift": 60,
  // p5-t01 ensemble A/B prototype (ADR 0021): the shared 150 s slice
  // timeline (normal activity, busy/quiet pair, waiting at 60 s,
  // completion at 110 s) at calm 0.6 under the seed-161 independent or
  // hybrid routine-note schedule plus the production question/resolve
  // cues. REPORTED, never gated: the entry proves the new audible path
  // renders inside the existing fatigue bounds without changing any
  // threshold, window, or metric.
  "ensemble-ab-independent": 150,
  "ensemble-ab-hybrid": 150,
  // The harmonic field (ADR 0025): one agent in the mid seat under the
  // evolving world for eight minutes — long enough for several epochs,
  // so the chord thickens, thins and hands voices over inside one render.
  // The solo-agent shape is the one the owner asked to hear first.
  "harmonic-field": 480,
  // The empty room (owner direction 2026-10-29): one agent works for
  // 20 s and stops; the rest of the render is the room with nobody in it,
  // long enough for the 8 s drone ramp and every tail to settle.
  "empty-room": 90,
  // The tonal journey (owner direction 2026-10-29): one agent in the mid
  // seat while the world clock crosses seed 161's D → F# lydian move
  // (TONAL_JOURNEY_START_S), so the drone and the ground voice are heard
  // handing over to the new centre inside a short render.
  "tonal-journey": 60,
};

/**
 * World-clock offset for `tonal-journey`: 880 s, 20.8 s before seed 161's
 * epoch boundary at 900.8 s, where the centre moves from D to F#.
 */
export const TONAL_JOURNEY_START_S = 880;

/** Bass pitch classes above D the tonal-journey render walks from and to. */
export const TONAL_JOURNEY_BASSES = { first: 7, last: 4 } as const;

/**
 * Named routine-note schedule behind an ensemble A/B scenario: the
 * deterministic move plan the named version sounds — the independent
 * seeded per-lane clocks, the hybrid arbitrated eligibility, or the p5-t02
 * core harmonic planner's `HarmonicMove` plans voiced through the p5-t03
 * seam (`harmonicVoicePlan`, same shape, tagged `"harmonic"`) — as
 * (lane, time, pitch) triples. Pure data for the QA entry: the browser
 * voices these through the same lane timbres the audition slice uses.
 * The cue triggers above (question at 60 s, resolve at 110 s) are the
 * hard-signal half; this schedule is the routine-note half.
 */
export type EnsembleQaSchedule = {
  readonly version: "independent" | "hybrid" | "harmonic";
  readonly moves: readonly {
    readonly laneIndex: number;
    readonly atS: number;
    readonly pitch: number;
    readonly fromPitch: number;
  }[];
};

/** One lane snapshot at a scenario time. */
export type QaLaneStep = {
  /** Seconds from render start. */
  readonly atS: number;
  /** The lane renders from this time until the next step. */
  readonly lanes: readonly LaneRender[];
};

/** One QA scenario drive: lane timelines plus the calm track. */
export type QaScenarioDrive = {
  readonly name: QaScenarioName;
  readonly seed: number;
  readonly durationS: number;
  /** Calm at the render start; calm tracks are piecewise-linear below. */
  readonly calm: number;
  /** Calm waypoints (time, value) after t=0; empty means constant calm. */
  readonly calmTrack: readonly (readonly [number, number])[];
  /** Lane timelines in ascending time order. */
  readonly steps: readonly QaLaneStep[];
  /**
   * Gesture triggers the browser entry feeds the GesturePlayer:
   * cross-checked in Node against driveScenario(scenarioFor(...)) for
   * the gesture scenarios, so the QA entry and the gesture suite drive
   * the same named inputs.
   */
  readonly gestures: readonly { readonly at: number; readonly laneIndex: number }[];
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

function routineLanes(struggle = 0.1): LaneRender[] {
  return [
    lane(0, { exploring: 0.65, editing: 0.2, testing: 0.05, other: 0.1 }, { struggle }),
    lane(1, { exploring: 0.15, editing: 0.65, testing: 0.1, other: 0.1 }, { struggle }),
    lane(2, { exploring: 0.1, editing: 0.2, testing: 0.6, other: 0.1 }, { struggle }),
  ];
}

function modeAt(progress: number): LaneRender["mode"] {
  if (progress < 0.5) {
    const blend = progress * 2;
    return { exploring: 1 - blend, editing: blend, testing: 0, other: 0 };
  }
  const blend = (progress - 0.5) * 2;
  return { exploring: 0, editing: 1 - blend, testing: blend, other: 0 };
}

function singleLaneAt(progress: number): LaneRender {
  const base = lane(1, { exploring: 0.15, editing: 0.65, testing: 0.1, other: 0.1 }, { laneId: 0 });
  return {
    ...base,
    mode: modeAt(progress),
    displayedMode: progress < 0.5 ? "exploring" : progress < 1 ? "editing" : "testing",
  };
}

/** Steps a piecewise lane timeline at `stepS` resolution. */
function stepped(
  durationS: number,
  stepS: number,
  lanesAt: (t: number) => readonly LaneRender[],
): QaLaneStep[] {
  const steps: QaLaneStep[] = [];
  for (let t = 0; t < durationS; t += stepS) {
    steps.push({ atS: t, lanes: lanesAt(t) });
  }
  return steps;
}

/**
 * The p5-t01 shared slice timeline as QA steps: the same six-step
 * trajectory the ensemble prototype drives (normal activity, busy/quiet
 * pair, waiting at 60 s, fresh progress at 90 s, completion at 110 s,
 * return at 120 s). QA steps duplicate the trajectory as data — the
 * timeline module owns the playable form, this owns the render drive —
 * so the scenario render and the audition slice never drift apart
 * silently: the ensemble tests pin both.
 */
function ensembleAbTimelineSteps(): QaLaneStep[] {
  const waiting = routineLanes(0.1).map((item, index) =>
    index === 2
      ? {
          ...item,
          activity: 0.55,
          lifecycle: "waiting" as const,
          gestures: [{ gesture: "question" as const, at: 60 }],
        }
      : index === 1
        ? { ...item, activity: 0.85 }
        : { ...item, activity: 0.25 },
  );
  const complete = routineLanes(0.1).map((item, index) =>
    index === 2
      ? {
          ...item,
          lifecycle: "turn_complete" as const,
          gestures: [{ gesture: "resolve" as const, at: 110 }],
        }
      : index === 1
        ? { ...item, activity: 0.85 }
        : { ...item, activity: 0.25 },
  );
  const routine = routineLanes(0.1).map((item, index) =>
    index === 1 ? { ...item, activity: 0.85 } : index === 0 ? { ...item, activity: 0.25 } : item,
  );
  const progress = routineLanes(0.1).map((item, index) =>
    index === 1
      ? { ...item, activity: 0.85, progress: 0.75 }
      : index === 0
        ? { ...item, activity: 0.25 }
        : { ...item, activity: 0.55, lifecycle: "waiting" as const },
  );
  return [
    { atS: 0, lanes: routine },
    { atS: 60, lanes: waiting },
    { atS: 90, lanes: progress },
    { atS: 110, lanes: complete },
    { atS: 120, lanes: routine },
  ];
}

/** Builds the named scenario drive at the fixed QA seed. */
export function scenarioDrive(name: QaScenarioName, seed: number = QA_SEED): QaScenarioDrive {
  switch (name) {
    case "routine-3-lanes-calm06":
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: [{ atS: 0, lanes: routineLanes(0.1) }],
        gestures: [],
      };
    case "near-silence-calm09":
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.9,
        calmTrack: [],
        steps: [{ atS: 0, lanes: routineLanes(0.1) }],
        gestures: [],
      };
    case "single-lane-modes":
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: stepped(60, 5, (t) => [singleLaneAt(t / 60)]),
        gestures: [],
      };
    case "struggle-ramp":
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: stepped(
          60,
          5,
          (t) =>
            [
              { ...routineLanes()[1], laneId: 0, struggle: Math.min(1, t / 60) },
            ] as readonly LaneRender[],
        ),
        gestures: [],
      };
    case "waiting-holds":
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: [
          { atS: 0, lanes: routineLanes(0.1) },
          {
            atS: 10,
            lanes: routineLanes(0.1).map((item, index) =>
              index === 1
                ? { ...item, lifecycle: "waiting", gestures: [{ gesture: "question", at: 10 }] }
                : item,
            ),
          },
        ],
        gestures: [{ at: 10, laneIndex: 1 }],
      };
    case "resolve-fades":
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: [
          { atS: 0, lanes: routineLanes(0.1) },
          {
            atS: 10,
            lanes: routineLanes(0.1).map((item, index) =>
              index === 1
                ? {
                    ...item,
                    lifecycle: "turn_complete",
                    gestures: [{ gesture: "resolve", at: 10 }],
                  }
                : item,
            ),
          },
        ],
        gestures: [{ at: 10, laneIndex: 1 }],
      };
    case "calm-sweep":
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0,
        calmTrack: [
          [30, 1],
          [60, 0],
        ],
        steps: [{ atS: 0, lanes: routineLanes(0.1) }],
        gestures: [],
      };
    case "foreground-switch":
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: [0, 20, 40].map((atS) => {
          const active = Math.min(2, Math.floor(atS / 20));
          return {
            atS,
            lanes: routineLanes(0.1).map((item, index) => ({
              ...item,
              prominence: index === active ? 1 : 0.15,
              foreground: index === active,
            })),
          };
        }),
        gestures: [],
      };
    case "macro-evolution":
      // Three routine lanes under the evolving world: no gestures, no
      // mode changes — the only long-term motion is the macro
      // checkpoint schedule, so the render proves the world re-voices
      // on its own clock while meso holds steady.
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: [{ atS: 0, lanes: routineLanes(0.1) }],
        gestures: [],
      };
    case "spatial-drift":
      // Slow spatial movement (p3-t16): the same routine lanes as the
      // baseline mix — meso held steady, so the only long-term motion
      // inside the render is the seeded macro wander (the whole suite
      // sounds the wander on the minute-span clock): pan/width/distance
      // breathe while register + timbre + position hold. REPORTED, never
      // gated (no threshold, window, or metric edits to pass the mix):
      // the levels say whether the drift moves space without masking the
      // hard signals, and the stereo-vs-mono read says whether lane
      // identity survives the wander on laptop-speaker-equivalent sums.
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: [{ atS: 0, lanes: routineLanes(0.1) }],
        gestures: [],
      };
    case "harmonic-field":
      // One routine agent in the mid seat (lane index 1 — the centre-first
      // seat a solo agent gets), the low seat idle, under the evolving
      // world (the render entry passes the clock, like macro-evolution).
      // No gestures: the only long-term motion is the field's own.
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: [
          {
            atS: 0,
            lanes: [
              lane(
                0,
                { exploring: 0, editing: 0, testing: 0, other: 0 },
                { lifecycle: "idle", activity: 0, prominence: 0, foreground: false },
              ),
              lane(1, { exploring: 0.25, editing: 0.55, testing: 0.1, other: 0.1 }),
            ],
          },
        ],
        gestures: [],
      };
    case "empty-room":
      // One routine agent in the mid seat for 20 s, then idle: every seat
      // idle is the empty room, which should all but disappear.
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: [
          { atS: 0, lanes: soloMidLanes("active") },
          { atS: 20, lanes: soloMidLanes("idle") },
        ],
        gestures: [],
      };
    case "tonal-journey":
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: [{ atS: 0, lanes: soloMidLanes("active") }],
        gestures: [],
      };
    case "ensemble-ab-independent":
    case "ensemble-ab-hybrid":
      // p5-t01 ensemble A/B prototype: the shared 150 s slice timeline —
      // normal activity, a busy/quiet pair, waiting at 60 s (question on
      // lane 2) and completion at 110 s (resolve on lane 2) — at calm
      // 0.6 under the seed-161 schedule of the named version. The
      // routine-note plans differ; the cues are identical. REPORTED,
      // never gated: the entry proves the new audible path renders
      // inside the existing fatigue bounds (rule 1/2/4/6/7 read the mix
      // like every scenario) without changing any threshold, window,
      // or metric.
      return {
        name,
        seed,
        durationS: QA_DURATIONS[name],
        calm: 0.6,
        calmTrack: [],
        steps: ensembleAbTimelineSteps(),
        gestures: [
          { at: 60, laneIndex: 2 },
          { at: 110, laneIndex: 2 },
        ],
      };
  }
}

/** The low seat idle and one agent in the mid seat, the solo shape. */
function soloMidLanes(lifecycle: "active" | "idle"): readonly LaneRender[] {
  return [
    lane(
      0,
      { exploring: 0, editing: 0, testing: 0, other: 0 },
      { lifecycle: "idle", activity: 0, prominence: 0, foreground: false },
    ),
    lifecycle === "active"
      ? lane(1, { exploring: 0.25, editing: 0.55, testing: 0.1, other: 0.1 })
      : lane(
          1,
          { exploring: 0, editing: 0, testing: 0, other: 0 },
          { lifecycle: "idle", activity: 0, prominence: 0, foreground: false },
        ),
  ];
}

/**
 * The gesture scenario (question/resolve on lane 1) behind the
 * waiting-holds and resolve-fades drives, as GESTURE_SCENARIOS named
 * inputs: the QA entry plays exactly these event plans, so the gesture
 * suite's offline renders and the browser QA render agree.
 */
export function gestureScenarioFor(
  gesture: Extract<GestureName, "question" | "resolve">,
  laneIndex: number,
  calm: number,
) {
  return scenarioFor(gesture, laneIndex, calm);
}

/** Resolves the event plan for the QA gesture drives (Node-checkable). */
export function qaGesturePlan(
  gesture: Extract<GestureName, "question" | "resolve">,
  laneIndex: number,
  calm: number,
) {
  return driveScenario(gestureScenarioFor(gesture, laneIndex, calm));
}
