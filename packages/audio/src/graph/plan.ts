// packages/audio/src/graph/plan.ts — the pure SceneParams → ramp-plan
// mapping. What this is for: turning the core `SceneParams` (plus Calm's
// master gain and the per-lane proximity fields p3-t01 renders) into a
// `GraphDescriptor` of current→target moves, assigning each parameter its
// §Ramps class (tension uses attack or release depending on direction) and
// lifting every target into its Tone unit (linear gains, Hz, dB, stereo
// pan). What it must not do: import Tone, keep state, or read events
// — the same inputs always produce the same plan, and apply.ts schedules it.

import type { SceneParams } from "@hearable/core";

import {
  clampSpatialPan,
  clampSpatialSend,
  clampSpatialWidth,
  type SpatialWander,
} from "../drift.js";
import { EXPONENTIAL_GAIN_FLOOR, type RampClass } from "../ramps.js";
import {
  AIR_BAND_HZ,
  LANE_PANS,
  LANE_REGISTER_ORDER,
  type LaneRegisterName,
  NATURE_BED,
  REVERB_SEND_BASE,
} from "../scenes/clearing/index.js";
import type {
  DroneDescriptor,
  FieldPingDescriptor,
  FieldVoiceDescriptor,
  GraphDescriptor,
  LaneDescriptor,
  RampedParameter,
} from "./types.js";

/**
 * A field slot whose planned gain sits at or below this is silent for
 * handover purposes: a pitch change lands as a direct retune on the
 * sounding bank instead of a crossfade nobody would hear.
 */
export const FIELD_SILENT_GAIN = 1e-3;

/** Base air cutoff in Hz: the centre of the 800–3000 Hz band. */
export const AIR_BASE_CUTOFF_HZ = (AIR_BAND_HZ.low + AIR_BAND_HZ.high) / 2;

/** Grain density in grains/s at density scale 1 (0.5–4 grains/s). */
export const GRAIN_DENSITY_RANGE = { min: 0.5, max: 4 } as const;

/** Seat register backing a lane index (low/mid/high/upper). */
export function registerForLane(index: number): LaneRegisterName {
  return LANE_REGISTER_ORDER[index % LANE_REGISTER_ORDER.length] ?? "low";
}

/** Pan of the seat backing a lane index (−0.6/0/+0.6, upper centre). */
export function panForLane(index: number): number {
  return LANE_PANS[registerForLane(index)] ?? 0;
}

/** Converts a dBFS bed target to the linear gain the bed Gain holds. */
export function dbToGain(db: number): number {
  return db <= -140 ? EXPONENTIAL_GAIN_FLOOR : 10 ** (db / 20);
}

/** Converts a swell period in seconds to the LFO rate in Hz that voices it. */
export function rateForPeriodS(periodS: number): number {
  return 1 / Math.max(0.5, periodS);
}

function param(path: string, ramp: RampClass, current: number, target: number): RampedParameter {
  return { path, ramp, current, target };
}

/** Plans one lane's moves, defaulting currents to targets on first apply. */
function planLane(
  laneIndex: number,
  voice: SceneParams["lanes"][number],
  prior: LaneDescriptor | undefined,
  masterTargetDb: number,
  wander?: SpatialWander,
): LaneDescriptor {
  const base = `lanes.${laneIndex}`;
  const tensionWasOn = prior !== undefined && prior.tensionGain.target > 0;
  const tensionRamp: RampClass = voice.tension.on
    ? "tensionAttack"
    : tensionWasOn
      ? "tensionRelease"
      : "tensionAttack";
  const targets = {
    airGain: voice.air.gain,
    airCutoff: AIR_BASE_CUTOFF_HZ * voice.air.cutoff,
    grainGain: voice.grain.gain,
    grainDensity:
      GRAIN_DENSITY_RANGE.min +
      (GRAIN_DENSITY_RANGE.max - GRAIN_DENSITY_RANGE.min) * voice.grain.density,
    grainStuck: voice.grain.stuckDepth,
    grainStuckRate: voice.grain.stuckRateHz,
    pulseGain: voice.pulse.gain,
    pulsePeriodS: voice.pulse.pulsePeriodS,
    tensionGain: voice.tension.gain,
    reverbSend: voice.proximity.reverbSend * REVERB_SEND_BASE,
    brightness: voice.proximity.brightnessDb,
    // Scene width (0.15 far … 0.35 near) maps onto the widener's mid/side
    // balance (0.5 = no change): 0.5 + width/2 keeps every lane near
    // unity, so prominence moves the region without multiplying level.
    width: 0.5 + voice.proximity.width / 2,
    pan: panForLane(laneIndex),
  };
  // Slow spatial movement (p3-t16, ADR 0017): the seeded macro wander
  // breathes each lane's pan/width/distance around its mapped static
  // target — never from lane state, never from agent events. The offsets
  // clamp inside per-lane safe windows, so the −0.6/0/+0.6 regions never
  // overlap and the foreground lane stays the driest, narrowest-in-image
  // voice by margin. No new ramp class: the drifted targets ride the
  // existing pan/width/reverbSend ramps in apply.ts.
  const wandered = spatialTargets(targets, laneIndex, wander);
  // `currentOf` reads the prior descriptor's currents by the same key the
  // targets use — except the pulse-period move (the target holds a period
  // in seconds, the descriptor holds an LFO rate) and the gesture-comp
  // move (planned from the master target, not from a lane field). Those
  // two read their matching descriptor currents explicitly below.
  const currentOf = (key: Exclude<keyof typeof targets, "pulsePeriodS">): number =>
    prior === undefined ? targets[key] : prior[key].current;
  return {
    laneId: voice.laneId,
    airGain: param(`${base}.air.gain`, "layerGain", currentOf("airGain"), targets.airGain),
    airCutoff: param(`${base}.air.cutoff`, "cutoff", currentOf("airCutoff"), targets.airCutoff),
    grainGain: param(`${base}.grain.gain`, "layerGain", currentOf("grainGain"), targets.grainGain),
    grainDensity: param(
      `${base}.grain.density`,
      "density",
      currentOf("grainDensity"),
      targets.grainDensity,
    ),
    grainStuck: param(
      `${base}.grain.stuck`,
      "regularity",
      currentOf("grainStuck"),
      targets.grainStuck,
    ),
    grainStuckRate: param(
      `${base}.grain.stuckRate`,
      "period",
      currentOf("grainStuckRate"),
      targets.grainStuckRate,
    ),
    // The pulse layer breathes on one contracted period per lane
    // (ADR 0019: the pattern contracts as one structure).
    pulseGain: param(`${base}.pulse.gain`, "layerGain", currentOf("pulseGain"), targets.pulseGain),
    pulsePeriodRate: param(
      `${base}.pulse.periodRate`,
      "period",
      prior === undefined
        ? rateForPeriodS(targets.pulsePeriodS)
        : (prior.pulsePeriodRate.current ?? rateForPeriodS(targets.pulsePeriodS)),
      rateForPeriodS(targets.pulsePeriodS),
    ),
    tensionGain: param(
      `${base}.tension.gain`,
      tensionRamp,
      currentOf("tensionGain"),
      targets.tensionGain,
    ),
    reverbSend: param(
      `${base}.reverb.send`,
      "reverbSend",
      currentOf("reverbSend"),
      wandered.reverbSend,
    ),
    brightness: param(
      `${base}.brightness`,
      "brightness",
      currentOf("brightness"),
      targets.brightness,
    ),
    width: param(`${base}.width`, "width", currentOf("width"), wandered.width),
    pan: param(`${base}.pan`, "pan", currentOf("pan"), wandered.pan),
    // Gesture calm-compensation (ADR 0018): the gesture trim inverts the
    // master Calm trim in linear gain, so hard gestures hold their level
    // at any Calm while routine presence falls. Planned from the scene
    // master target passed down from planGraph; ramps on the master class.
    gestureCalm: gestureCalmParam(base, masterTargetDb, prior),
  };
}

/**
 * Applies the seeded macro wander to the three static spatial targets.
 * Without a wander the static targets pass through untouched (first
 * apply holds; pre-spatial callers keep byte-identical plans). With one,
 * the per-lane offsets add to pan/width/send and clamp inside the
 * lane-safe windows — regions breathe, never overlap.
 */
function spatialTargets(
  targets: { pan: number; width: number; reverbSend: number },
  laneIndex: number,
  wander: SpatialWander | undefined,
): { pan: number; width: number; reverbSend: number } {
  if (wander === undefined) return targets;
  return {
    pan: clampSpatialPan(targets.pan + (wander.pan[laneIndex] ?? 0), laneIndex),
    width: clampSpatialWidth(targets.width + (wander.width[laneIndex] ?? 0), targets.width),
    reverbSend: clampSpatialSend(
      targets.reverbSend + (wander.reverbSend[laneIndex] ?? 0),
      REVERB_SEND_BASE,
    ),
  };
}

/**
 * Plans the gesture calm-compensation move: the linear gain that inverts
 * the scene's master Calm trim, so the per-lane gesture trim node restores
 * exactly what the master fader takes away. Pure function of the master
 * target — the unit proof in plan.test.ts pins the inversion at every
 * Calm. Exported for the apply-time compensation math and the tests.
 */
export function gestureCalmCompensation(masterTargetDb: number): number {
  return 10 ** (-masterTargetDb / 20);
}

function gestureCalmParam(
  base: string,
  masterTargetDb: number,
  prior: LaneDescriptor | undefined,
): RampedParameter {
  const target = gestureCalmCompensation(masterTargetDb);
  return param(
    `${base}.gesture.calm`,
    "master",
    prior === undefined ? target : (prior.gestureCalm.current ?? target),
    target,
  );
}

/**
 * Plans the full graph move for one `SceneParams`. Without a previous
 * descriptor every current equals its target (first apply holds, then
 * ramps on later applies). Tension ramps use attack when turning on and
 * release when turning off, tracked from the previous plan. The macro
 * world rides declared classes only: swell on the slow density approach
 * (4 s drift, never a switch), both cutoffs on the 2 s cutoff class,
 * the breathing rate on the 4 s period approach — so the world
 * re-voices on its own schedule inside one render, never steps.
 */
export function planGraph(
  params: SceneParams,
  previous?: GraphDescriptor,
  wander?: SpatialWander,
): GraphDescriptor {
  const masterTarget = params.masterGainDb;
  const masterCurrent = previous?.master.current ?? masterTarget;
  const bedTarget = dbToGain(params.bed.gainDbfs);
  const bedCurrent = previous?.bed.current ?? bedTarget;
  const swellTarget = params.macro.textureSwell;
  const swellCurrent = previous?.macroSwell.current ?? swellTarget;
  // The nature bed sits low and follows the scene density scale ONLY
  // (ADR 0017 macro independence — never lane state, never agent events):
  // the target is the density share of the −44 dBFS seat, so Calm thins
  // the bed exactly the way it thins routine density.
  const natureTarget = params.densityScale * 10 ** (NATURE_BED.gainDb / 20);
  const natureCurrent = previous?.nature.current ?? natureTarget;
  // The nature-bed crossfade tick (revp3t15): counts applies from the
  // previous tick, never from lane state — the alternation is lane-blind
  // by signature, and the descriptor carries it so Node proves it.
  const natureTickTarget = (previous?.natureTick.target ?? -1) + 1;
  const natureTickCurrent = natureTickTarget;
  const cutoffTarget = params.macro.swellCutoffHz;
  const cutoffCurrent = previous?.macroCutoff.current ?? cutoffTarget;
  const fieldTarget = params.macro.fieldCutoffHz;
  const fieldCurrent = previous?.macroField.current ?? fieldTarget;
  const pulseTarget = params.macro.pulseHz;
  const pulseCurrent = previous?.macroPulse.current ?? pulseTarget;
  const fieldGainTarget = params.macro.fieldGain;
  const fieldGainCurrent = previous?.macroFieldGain.current ?? fieldGainTarget;
  // Blooms are announced ahead of the clock by several consecutive
  // renders; the descriptor's high-water id schedules each exactly once.
  const throughId = previous?.fieldPingsThroughId ?? -1;
  const pingsToSchedule: FieldPingDescriptor[] = params.macro.pings
    .filter((ping) => ping.id > throughId)
    .map((ping) => ({ id: ping.id, inS: ping.inS, midi: ping.midi, level: ping.level }));
  return {
    master: param("master.gain", "master", masterCurrent, masterTarget),
    bed: param("bed.gain", "room", bedCurrent, bedTarget),
    nature: param("nature.bed", "density", natureCurrent, natureTarget),
    natureTick: param("nature.tick", "density", natureTickCurrent, natureTickTarget),
    macroSwell: param("macro.swell", "density", swellCurrent, swellTarget),
    macroCutoff: param("macro.cutoff", "cutoff", cutoffCurrent, cutoffTarget),
    macroField: param("macro.field", "cutoff", fieldCurrent, fieldTarget),
    macroPulse: param("macro.pulse", "period", pulseCurrent, pulseTarget),
    macroFieldGain: param("macro.field.gain", "density", fieldGainCurrent, fieldGainTarget),
    fieldVoices: params.macro.fieldVoices.map((voice, slot) =>
      planFieldVoice(slot, voice, previous?.fieldVoices[slot]),
    ),
    fieldPings: pingsToSchedule,
    fieldPingsThroughId: pingsToSchedule.reduce(
      (max, ping) => Math.max(max, ping.id),
      previous?.fieldPingsThroughId ?? -1,
    ),
    drone: planDrone(params.macro.bass, previous?.drone),
    lanes: params.lanes.map((voice, laneIndex) =>
      planLane(laneIndex, voice, previous?.lanes[laneIndex], masterTarget, wander),
    ),
  };
}

/**
 * Plans the drone's pitch class (owner direction 2026-10-29): the chord's
 * bass, so the floor walks with inversions and holds under pedals. A new
 * one is a handover between the two drone banks, counted like a field
 * slot's moves so apply.ts knows which bank sounds. The first apply only records
 * the pitch class: the drone is built on D and a scene starts on D.
 */
function planDrone(pitchClass: number, prior: DroneDescriptor | undefined): DroneDescriptor {
  const handover = pitchClass !== (prior?.pitchClass ?? 0);
  return { pitchClass, moves: (prior?.moves ?? 0) + (handover ? 1 : 0), handover };
}

/**
 * Plans one harmonic-field slot (ADR 0025). The level rides the 12 s
 * fieldVoice ramp. A pitch change while the slot sounds is a handover
 * (bank crossfade, moves + 1); a pitch change while it is silent, or the
 * first pitch it ever gets, is a retune of the sounding bank — a step
 * scheduled where nothing is audible. The last pitch is kept through
 * silence so the descriptor always knows what the sounding bank holds.
 */
function planFieldVoice(
  slot: number,
  voice: SceneParams["macro"]["fieldVoices"][number],
  prior: FieldVoiceDescriptor | undefined,
): FieldVoiceDescriptor {
  const path = `macro.field.voice${slot}.gain`;
  const target = voice.level;
  const current = prior?.gain.current ?? target;
  const heldMidi = prior?.midi ?? null;
  const nextMidi = voice.midi ?? heldMidi;
  const pitchChanged = nextMidi !== null && nextMidi !== heldMidi;
  const sounding = prior !== undefined && prior.gain.current > FIELD_SILENT_GAIN;
  const handover = pitchChanged && sounding;
  const retune = (pitchChanged && !sounding) || (prior === undefined && nextMidi !== null);
  return {
    midi: nextMidi,
    gain: param(path, "fieldVoice", current, target),
    moves: (prior?.moves ?? 0) + (handover ? 1 : 0),
    handover,
    retune,
  };
}
