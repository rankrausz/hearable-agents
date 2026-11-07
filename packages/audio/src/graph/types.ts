// packages/audio/src/graph/types.ts — the framework-free shape of the
// Clearing graph. What this is for: describing every rampable parameter,
// voice and bus as plain data (`GraphDescriptor`, `LaneNodes`, `BedNodes`,
// `MasterNodes`) so the pure ramp planner, tests and the QA harness can
// reason about the full parameter set without importing Tone. What it must
// not do: import Tone, create nodes, or schedule audio — construction lives
// in builder.ts and ramping in apply.ts.

import type { RampClass } from "../ramps.js";

/** One rampable parameter: its path, ramp class, current and target value. */
export type RampedParameter = {
  /** Stable path, e.g. "lanes.0.air.gain". */
  readonly path: string;
  /** Which ramp class governs the move. */
  readonly ramp: RampClass;
  /** Value the graph currently holds (same units as target). */
  readonly current: number;
  /** Value SceneParams maps to (same units as current). */
  readonly target: number;
};

/**
 * Every rampable parameter the Clearing graph exposes, grouped by bus.
 * Counts: 1 master + 1 bed + 1 nature bed + 1 nature tick + 1 macro swell + 1
 * macro swell cutoff + 1 macro field cutoff + 1 macro pulse + 1 field seat
 * gain + 6 field voice gains + lanes × (4 layer gains + air cutoff + grain
 * density/stuck depth/stuck rate + pulse gain + pulse period + tension gain
 * + reverb send + brightness + width + pan + gesture calm-compensation) =
 * 15 + 14 per lane.
 *
 * Every entry is independently scheduled in apply.ts (rampLane): no
 * duplicates, no dead entries. The grain path's own pulse rides the
 * single pulse-period move (one swell LFO per lane); the waiting duck
 * lives in core layer gains, not as a descriptor entry.
 */
export type GraphDescriptor = {
  readonly master: RampedParameter;
  readonly bed: RampedParameter;
  /**
   * The sampled nature bed seat (p3-t15): the density share of the
   * −44 dBFS bed level — planned from the scene density scale only
   * (never lane state), ramping on the slow density approach.
   */
  readonly nature: RampedParameter;
  /**
   * The nature-bed crossfade tick (p3-t15 revp3t15): counts applies, 0-based.
   * Planned from the previous tick only (never lane state), carried on the
   * density class so the alternation stays inside the declared ramp, so
   * tests prove the alternation without audio.
   */
  readonly natureTick: RampedParameter;
  /** The macro world's environmental texture swell (p3-t12). */
  readonly macroSwell: RampedParameter;
  /**
   * The macro swell air-band centre in Hz (checkpoint brightness as an
   * audible cutoff; cutoff class).
   */
  readonly macroCutoff: RampedParameter;
  /**
   * The macro field-pad low-pass in Hz (checkpoint brightness as timbre;
   * cutoff class) plus the breathing-LFO rate in Hz (checkpoint density
   * as a slow pulse; period class) — carried as one planned descriptor
   * move each, scheduled onto the filter and the LFO.
   */
  readonly macroField: RampedParameter;
  readonly macroPulse: RampedParameter;
  /**
   * The harmonic field's seat gain (ADR 0025): the core field-gain scale
   * (Calm, presence, near-silence) on the slow density approach; apply.ts
   * multiplies in the dB seat.
   */
  readonly macroFieldGain: RampedParameter;
  /** One entry per field slot, index-aligned with core FIELD_SLOTS. */
  readonly fieldVoices: readonly FieldVoiceDescriptor[];
  /** Blooms this apply schedules (ids above the last scheduled id). */
  readonly fieldPings: readonly FieldPingDescriptor[];
  /** Highest bloom id scheduled so far (−1 before any). */
  readonly fieldPingsThroughId: number;
  /** The drone's tonal centre and its bank handovers. */
  readonly drone: DroneDescriptor;
  readonly lanes: readonly LaneDescriptor[];
};

/** One bloom note to schedule: seconds from the apply anchor, pitch, level. */
export type FieldPingDescriptor = {
  readonly id: number;
  readonly inS: number;
  readonly midi: number;
  readonly level: number;
};

/**
 * The drone's pitch class (owner direction 2026-10-29): the chord bass the
 * sounding bank holds, how many handovers came before, and whether this
 * apply hands it over. Not a ramped parameter: the handover is a bank
 * crossfade apply.ts schedules.
 */
export type DroneDescriptor = {
  readonly pitchClass: number;
  readonly moves: number;
  readonly handover: boolean;
};

/**
 * One harmonic-field slot's plan (ADR 0025). `gain` is the slot's level on
 * the 12 s fieldVoice ramp (0 while silent). `midi` is the pitch the slot
 * holds or last held — kept while silent so a re-entry on the same note
 * needs no retune. `moves` counts pitch handovers (bank parity, like a
 * lane's move index); `handover` marks this plan as the one that opens a
 * 5 s bank crossfade to a new pitch while the slot is sounding, and
 * `retune` marks a pitch set on the sounding bank while the slot is silent
 * (or on first apply), where a step is inaudible by construction.
 */
export type FieldVoiceDescriptor = {
  readonly midi: number | null;
  readonly gain: RampedParameter;
  readonly moves: number;
  readonly handover: boolean;
  readonly retune: boolean;
};

/** One lane's rampable parameters. */
export type LaneDescriptor = {
  readonly laneId: number;
  readonly airGain: RampedParameter;
  readonly airCutoff: RampedParameter;
  readonly grainGain: RampedParameter;
  readonly grainDensity: RampedParameter;
  /**
   * Stuck-gate depth 0..1: planned onto the stuck LFO's amplitude
   * (NormalRange — the swing can never exceed the planned grain gain,
   * so struggle never raises loudness). The descriptor tracks it so
   * tests prove the trajectory without audio.
   */
  readonly grainStuck: RampedParameter;
  /**
   * Stuck-gate rate in Hz: planned onto the stuck LFO frequency (the
   * period class — a slow phrase circle, never a tremolo). Doubles when
   * the note set narrows, so noteSet reaches audio through the rate.
   */
  readonly grainStuckRate: RampedParameter;
  readonly pulseGain: RampedParameter;
  /** The lane swell period, planned as its LFO rate (period class). */
  readonly pulsePeriodRate: RampedParameter;
  readonly tensionGain: RampedParameter;
  readonly reverbSend: RampedParameter;
  readonly brightness: RampedParameter;
  readonly width: RampedParameter;
  readonly pan: RampedParameter;
  /**
   * Gesture calm-compensation: linear gain on the lane's gesture trim
   * that inverts the master Calm trim, so gestures stay audible at any
   * Calm (ADR 0018). Planned from the master target; scheduled onto the
   * per-lane gesture trim node in apply.ts.
   */
  readonly gestureCalm: RampedParameter;
};

/** Flat list of every parameter in a descriptor, master first. */
export function allParameters(descriptor: GraphDescriptor): readonly RampedParameter[] {
  return [
    descriptor.master,
    descriptor.bed,
    descriptor.nature,
    descriptor.natureTick,
    descriptor.macroSwell,
    descriptor.macroCutoff,
    descriptor.macroField,
    descriptor.macroPulse,
    descriptor.macroFieldGain,
    ...descriptor.fieldVoices.map((voice) => voice.gain),
    ...descriptor.lanes.flatMap((lane) => [
      lane.airGain,
      lane.airCutoff,
      lane.grainGain,
      lane.grainDensity,
      lane.grainStuck,
      lane.grainStuckRate,
      lane.pulseGain,
      lane.pulsePeriodRate,
      lane.tensionGain,
      lane.reverbSend,
      lane.brightness,
      lane.width,
      lane.pan,
      lane.gestureCalm,
    ]),
  ];
}
