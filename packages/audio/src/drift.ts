// packages/audio/src/drift.ts — seeded, bounded motion for continuous scene
// parameters. What this is for: keeping a rendered scene alive between core's
// render() and the graph's apply() without changing musical bounds, plus the
// slow spatial movement (p3-t16, ADR 0017 space requirement): a separate
// seeded low-frequency wander of each lane's pan, width and distance
// (reverb send) around the mapped scene targets on minute-scale macro
// epochs — macro-schedule driven (render seed + engine-clock minute
// epochs, never lane state, never agent events), clamped inside per-lane
// safe windows so the −0.6/0/+0.6 regions never overlap and foreground
// closeness still reads through the drift. What it must not do: touch
// Tone nodes, change discrete scene choices, or keep shared mutable state.
// The live factory is the audio boundary; sandbox wiring can inject its
// own seed in p3-t06/Phase 4.

import { createRng, type Rng, type SceneParams } from "@hearable/core";

import { LANE_PANS, LANE_REGISTER_ORDER } from "./scenes/clearing/index.js";

/**
 * Seeded low-frequency spatial state: per-lane pan/width/distance offsets.
 */
export type SpatialWander = {
  /** Pan offset per lane, bounded to its lane-safe window. */
  readonly pan: readonly number[];
  /** Width offset per lane, bounded to its lane-safe window. */
  readonly width: readonly number[];
  /** Reverb-send offset per lane, bounded to its lane-safe window. */
  readonly reverbSend: readonly number[];
};

/** Correlation time of the spatial wander in seconds: minute-scale drift. */
export const SPATIAL_CORRELATION_SECONDS = 180;

/**
 * Maximum pan wander per lane in pan units: the static regions sit at
 * −0.6/0/+0.6 (0.6 apart), so ±0.12 keeps every drifted lane 0.36 from its
 * neighbour — the regions never threaten each other.
 */
export const SPATIAL_PAN_AMPLITUDE = 0.12;

/**
 * Maximum width wander per lane in widener units: the planned scene width
 * (0.15 far … 0.35 near) maps to 0.5+width/2, so ±0.04 widens and narrows
 * the region without multiplying level or touching the neighbours.
 */
export const SPATIAL_WIDTH_AMPLITUDE = 0.04;

/**
 * Maximum reverb-send wander per lane (linear share of REVERB_SEND_BASE):
 * ±0.06 of the 0.65→0.15 far→near mapping — the drift breathes distance,
 * never loudness, and the foreground lane stays the driest by margin.
 */
export const SPATIAL_SEND_AMPLITUDE = 0.06;

/** Pan safety margin: neighbouring drifted regions stay this far apart. */
export const SPATIAL_PAN_REGION_GAP = 0.36;

/** Drift is sampled at this cadence; apply() still ramps each resulting target. */
export const DRIFT_STEP_SECONDS = 0.5;

/** Relative target offset, expressed as a share of each field's musical range. */
export const DRIFT_AMPLITUDES = {
  gain: 0.05,
  cutoff: 0.1,
  density: 0.08,
  timing: 0.08,
  tone: 0.05,
  proximity: 0.05,
} as const;

/** OU correlation times are named so audio QA can calibrate them explicitly. */
export const DRIFT_CORRELATION_TIMES_SECONDS = {
  gain: 30,
  cutoff: 30,
  density: 30,
  timing: 30,
  tone: 30,
  proximity: 30,
} as const;

const MASTER_GAIN_RANGE = { min: -6, max: 0 } as const;
const DENSITY_SCALE_RANGE = { min: 0, max: 1 } as const;
const BED_GAIN_RANGE = { min: -40, max: -30 } as const;
const NORMALIZED_RANGE = { min: 0, max: 1 } as const;
const AIR_CUTOFF_RANGE = { min: 0.8, max: 1.2 } as const;
const BRIGHTNESS_RANGE = { min: -4, max: 3 } as const;
const WIDTH_RANGE = { min: 0.15, max: 0.35 } as const;
const STUCK_DEPTH_RANGE = { min: 0, max: 1 } as const;
const STUCK_RATE_RANGE = { min: 0.01, max: 4 } as const;
const PULSE_PERIOD_RANGE = { min: 0.5, max: 8 } as const;
const CALM_DUCK_RANGE = { min: 0, max: 12 } as const;
const GAIN_NUDGE_RANGE = { min: 0, max: 2 } as const;

type Range = { readonly min: number; readonly max: number };
type DriftGroup = keyof typeof DRIFT_AMPLITUDES;
type OffsetState = number[];

type DriftSpec = {
  readonly range: Range;
  readonly group: DriftGroup;
};

function clamp(value: number, range: Range): number {
  return Math.min(range.max, Math.max(range.min, value));
}

function spec(range: Range, group: DriftGroup): DriftSpec {
  return { range, group };
}

function driftValue(
  target: number,
  rng: Rng,
  dt: number,
  state: OffsetState,
  index: number,
  parameter: DriftSpec,
): number {
  const amplitude = DRIFT_AMPLITUDES[parameter.group];
  const correlation = DRIFT_CORRELATION_TIMES_SECONDS[parameter.group];
  const limit = (parameter.range.max - parameter.range.min) * amplitude;
  const priorOffset = state[index] ?? 0;
  const pull = Math.min(1, dt / correlation);
  const noise = (rng.next() * 2 - 1) * limit * Math.sqrt(2 * pull);
  const offset = clamp(priorOffset * (1 - pull) + noise, { min: -limit, max: limit });
  state[index] = offset;
  return clamp(target + offset, parameter.range);
}

/**
 * Applies one bounded mean-reverting update. It is stateless: the supplied
 * params are the current mapped targets, while DriftStepper owns OU offsets.
 */
export function driftSceneParams(params: SceneParams, rng: Rng, dt: number): SceneParams {
  if (!(dt > 0)) return params;
  return driftWithState(params, rng, dt, []);
}

function driftWithState(
  params: SceneParams,
  rng: Rng,
  dt: number,
  state: OffsetState,
): SceneParams {
  let index = 0;
  const value = (target: number, parameter: DriftSpec): number => {
    const result = driftValue(target, rng, dt, state, index, parameter);
    index += 1;
    return result;
  };
  // A target below a field's drift range holds exactly, and so does
  // every gain of an idle seat (owner direction 2026-10-29, the empty
  // room): drift keeps a working scene alive, it must not lift an emptied
  // room or a seat nobody sits in back into earshot. The RNG is still
  // drawn, so every other field keeps its drift sequence.
  const held = (target: number, parameter: DriftSpec, hold: boolean): number => {
    const drifted = value(target, parameter);
    return hold || target < parameter.range.min ? target : drifted;
  };
  const lanes = params.lanes.map((lane) => {
    const idle = lane.presence <= 0;
    const gain = (target: number): number => held(target, spec(NORMALIZED_RANGE, "gain"), idle);
    return {
      ...lane,
      presence: gain(lane.presence),
      layers: {
        air: gain(lane.layers.air),
        grain: gain(lane.layers.grain),
        pulse: gain(lane.layers.pulse),
        tension: gain(lane.layers.tension),
      },
      air: {
        ...lane.air,
        gain: gain(lane.air.gain),
        cutoff: value(lane.air.cutoff, spec(AIR_CUTOFF_RANGE, "cutoff")),
        cutoffRange: value(lane.air.cutoffRange, spec(NORMALIZED_RANGE, "cutoff")),
      },
      grain: {
        ...lane.grain,
        gain: gain(lane.grain.gain),
        density: value(lane.grain.density, spec(NORMALIZED_RANGE, "density")),
        stuckDepth: value(lane.grain.stuckDepth, spec(STUCK_DEPTH_RANGE, "timing")),
        stuckRateHz: value(lane.grain.stuckRateHz, spec(STUCK_RATE_RANGE, "timing")),
        pulsePeriodS: value(lane.grain.pulsePeriodS, spec(PULSE_PERIOD_RANGE, "timing")),
      },
      pulse: {
        ...lane.pulse,
        gain: gain(lane.pulse.gain),
        pulsePeriodS: value(lane.pulse.pulsePeriodS, spec(PULSE_PERIOD_RANGE, "timing")),
      },
      tension: { ...lane.tension, gain: gain(lane.tension.gain) },
      proximity: {
        reverbSend: value(lane.proximity.reverbSend, spec(NORMALIZED_RANGE, "proximity")),
        brightnessDb: value(lane.proximity.brightnessDb, spec(BRIGHTNESS_RANGE, "tone")),
        width: value(lane.proximity.width, spec(WIDTH_RANGE, "proximity")),
        gainNudgeDb: value(lane.proximity.gainNudgeDb, spec(GAIN_NUDGE_RANGE, "proximity")),
        calmDuckDb: value(lane.proximity.calmDuckDb, spec(CALM_DUCK_RANGE, "proximity")),
      },
    };
  });
  return {
    masterGainDb: value(params.masterGainDb, spec(MASTER_GAIN_RANGE, "gain")),
    densityScale: value(params.densityScale, spec(DENSITY_SCALE_RANGE, "density")),
    bed: { gainDbfs: held(params.bed.gainDbfs, spec(BED_GAIN_RANGE, "gain"), false) },
    macro: params.macro,
    lanes,
  };
}

export type DriftStepper = {
  readonly step: (params: SceneParams, dt: number) => SceneParams;
};

/** Creates a cadence-aware stepper without sharing state between scenes. */
export function createDriftStepper(rng: Rng): DriftStepper {
  let remainder = 0;
  const offsets: OffsetState = [];
  return {
    step(params, dt): SceneParams {
      if (!(dt > 0)) return params;
      remainder += dt;
      let next = params;
      while (remainder >= DRIFT_STEP_SECONDS) {
        next = driftWithState(next, rng, DRIFT_STEP_SECONDS, offsets);
        remainder -= DRIFT_STEP_SECONDS;
      }
      return next;
    },
  };
}

/** Builds the same seeded stepper used by QA for a caller-provided seed. */
export function createSeededDriftStepper(seed: number): DriftStepper {
  return createDriftStepper(createRng(seed));
}

/** Live-only seed boundary; callers remain on the same deterministic code path. */
export function createLiveDriftStepper(): DriftStepper {
  return createSeededDriftStepper(Math.floor(Math.random() * 0x1_0000_0000));
}

/** Pure draw helper: one bounded wander offset per lane per channel. */
function wanderChannel(
  amplitude: number,
  laneCount: number,
  seed: number,
  epoch: number,
): number[] {
  const offsets: number[] = [];
  for (let lane = 0; lane < laneCount; lane += 1) {
    const rng = createRng(seed + epoch * 7919 + lane * 104729);
    const draw = rng.next() * 2 - 1;
    offsets.push(draw * amplitude);
  }
  return offsets;
}

/**
 * Plans the spatial wander active at `epochIndex` (a macro-schedule
 * minute epoch) for `laneCount` lanes: deterministic per (seed, epoch),
 * one bounded draw per lane per channel. Lane-blind unless FORCED off —
 * no lane state, no agent events, no clock beyond the epoch index — so
 * the macro-independence property holds for space the same way it holds
 * for harmony. `laneBlind: false` exists ONLY for the mono-identity
 * unit proof (identity must read without any spatial cue): QA and live
 * never pass it.
 */
export function spatialWander(
  seed: number,
  epochIndex: number,
  laneCount: number,
  options: { readonly laneBlind?: boolean } = {},
): SpatialWander {
  const epoch = Math.max(0, Math.floor(epochIndex));
  const lanes = Math.max(0, Math.floor(laneCount));
  if (options.laneBlind === false) {
    const zeros = (count: number): number[] => Array.from({ length: count }, () => 0);
    return { pan: zeros(lanes), width: zeros(lanes), reverbSend: zeros(lanes) };
  }
  return {
    pan: wanderChannel(SPATIAL_PAN_AMPLITUDE, lanes, seed, epoch + 1),
    width: wanderChannel(SPATIAL_WIDTH_AMPLITUDE, lanes, seed + 0x51ab, epoch),
    reverbSend: wanderChannel(SPATIAL_SEND_AMPLITUDE, lanes, seed + 0x9e37, epoch),
  };
}

/** Clamps a drifted pan target inside its lane-safe window: the static
 * region (±0.12 around the seat's pan, −0.6/0/+0.6) keeps laterally
 * neighbouring seats at least SPATIAL_PAN_REGION_GAP apart. The upper seat
 * shares the mid seat's centre window by design — register, not image,
 * separates that pair (docs/SOUND_DESIGN.md §Seats and allocation). Pure,
 * so plan/apply and tests share it.
 */
export function clampSpatialPan(target: number, laneIndex: number): number {
  const register = LANE_REGISTER_ORDER[laneIndex % LANE_REGISTER_ORDER.length] ?? "low";
  const centre = LANE_PANS[register];
  return Math.min(centre + SPATIAL_PAN_AMPLITUDE, Math.max(centre - SPATIAL_PAN_AMPLITUDE, target));
}

/**
 * Clamps a drifted widener target (0.5 + width/2 units) inside the
 * ±SPATIAL_WIDTH_AMPLITUDE window around its centre — the region
 * breathes without multiplying level or touching the neighbours.
 */
export function clampSpatialWidth(target: number, centre: number): number {
  return Math.min(
    centre + SPATIAL_WIDTH_AMPLITUDE,
    Math.max(centre - SPATIAL_WIDTH_AMPLITUDE, target),
  );
}

/**
 * Clamps a drifted reverb-send target at silence and at the planned far
 * base: the wander breathes distance, never above the mapped far send.
 */
export function clampSpatialSend(target: number, base: number): number {
  return Math.min(base, Math.max(0, target));
}

/**
 * Minute epoch index for live/macro callers: which full
 * SPATIAL_CORRELATION_SECONDS window `nowSeconds` falls in. Pure — the
 * only clock spatial motion reads, exactly the macro-schedule cadence.
 */
export function spatialEpochAt(nowSeconds: number): number {
  return Math.max(0, Math.floor(Math.max(0, nowSeconds) / SPATIAL_CORRELATION_SECONDS));
}
