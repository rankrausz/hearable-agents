// packages/audio/src/apply.ts — the only module that touches Tone nodes.
// What this is for: owning the live Clearing graph (`createScene`), turning
// each `SceneParams` into a pure ramp plan (`planGraph`) and scheduling
// every parameter move through the single dispatch (`scheduleMove`), which
// runs the automation `automationForRamp` declares for the move's class —
// exponential for layer gains (through the shared floor, never 0), linear
// for cutoffs, pan, width, reverb, brightness and the master dB fader,
// the slow target approach for grain density, stuck, tension via the 3 s
// attack / 5 s release — so nothing audible ever steps. The stuck depth
// and rates schedule onto the grain path's depth LFO and the swell LFOs.
// Sample starts carry the ≥ 5 ms fade by construction in builder.ts. What
// it must not do: read events, signals or lifecycle; invent parameters
// outside the plan; bypass the dispatch with a direct ramp call; or call
// setValueAtTime without opening a ramp from the held value.

import type { SceneParams } from "@hearable/core";
import * as Tone from "tone";
import {
  SPATIAL_CORRELATION_SECONDS,
  type SpatialWander,
  spatialEpochAt,
  spatialWander,
} from "./drift.js";
import type { GestureVoiceEvent } from "./gestures/index.js";
import { ATTENTION_SUB_DETUNE_CENTS } from "./gestures/index.js";
import {
  beatLimitedCents,
  type ClearingGraph,
  createScene,
  type FieldSlotNodes,
  type LaneNodes,
  type LaneVoiceBank,
  midiToFrequency,
} from "./graph/builder.js";
import { natureCrossfadeParity, natureVoiceGains } from "./graph/nature.js";
import { dbToGain, planGraph } from "./graph/plan.js";
import type { FieldVoiceDescriptor, GraphDescriptor, RampedParameter } from "./graph/types.js";
import type { OverflowCuePlan } from "./overflow.js";
import { PIANO_ASSET_URLS } from "./piano/assets.js";
import { EXPONENTIAL_GAIN_FLOOR, RAMP_TIMES, type RampClass } from "./ramps.js";
import {
  DRONE_VOICE,
  HARMONIC_FIELD,
  MACRO_SWELL_GAIN_DB,
  SAMPLE_START_FADE_S,
} from "./scenes/clearing/index.js";

/** Smallest linear gain scheduled directly; below it the floor holds. */
const GAIN_EPSILON = EXPONENTIAL_GAIN_FLOOR;

/** Live scene handle: the surface p3-t03 and p3-t06 consume. */
export type SceneHandle = {
  /** Ramps every node parameter toward the SceneParams targets. */
  apply(params: SceneParams, space?: { readonly seed: number; readonly nowSeconds: number }): void;
  /** Tears down every node; the handle must not be used afterwards. */
  dispose(): void;
  /** Current planned descriptor (currents track the last apply). */
  readonly descriptor: GraphDescriptor | undefined;
};

/** Which Tone automation a ramp class schedules. Mirrors the dispatch below. */
export type RampAutomation = "linearRampTo" | "exponentialRampTo" | "targetRampTo";

/**
 * Maps a ramp class to the Tone automation its declared curve requires:
 * exponential for gains, linear for musical rates and master, the target
 * approach for drift classes. apply.ts schedules through this table, and
 * test/apply.test.ts asserts the table matches RAMP_TIMES, so a curve
 * mismatch fails in Node without needing a browser.
 */
export function automationForRamp(ramp: RampClass): RampAutomation {
  const curve = RAMP_TIMES[ramp].curve;
  if (curve === "exponential") return "exponentialRampTo";
  if (curve === "target") return "targetRampTo";
  return "linearRampTo";
}

/**
 * Creates the Clearing scene: builds the graph, awaits the shared reverb
 * IR (`Reverb.ready` regenerates async on decay/pre-delay changes in
 * Tone) and the nature-bed decode, and returns the apply/dispose
 * handle. The Tone import stays in this module so graph/scene code
 * remains import-safe in Node. The caller threads the bundler-resolved
 * nature asset URL (live: `?url` import in the sandbox view) — the one
 * fetch + decode path QA and live share.
 */
export async function createSceneHandle(
  laneCount: number,
  natureAssetUrl: string,
): Promise<SceneHandle> {
  const graph = createScene(Tone, { laneCount, natureAssetUrl, pianoAssetUrls: PIANO_ASSET_URLS });
  try {
    await Promise.all([graph.reverb.ready, graph.nature.ready, graph.piano?.ready]);
    return createHandle(graph);
  } catch (error) {
    await Promise.allSettled([graph.reverb.ready, graph.nature.ready, graph.piano?.ready]);
    graph.dispose();
    throw error;
  }
}

/** Wraps a built graph in the apply/dispose handle (sync, for tests). */
export function createHandle(graph: ClearingGraph): SceneHandle {
  let descriptor: GraphDescriptor | undefined;
  return {
    apply(
      params: SceneParams,
      space?: { readonly seed: number; readonly nowSeconds: number },
    ): void {
      descriptor = applyToGraph(graph, params, descriptor, undefined, space);
    },
    dispose(): void {
      graph.dispose();
    },
    get descriptor(): GraphDescriptor | undefined {
      return descriptor;
    },
  };
}

/**
 * Plans the move from the previous descriptor and schedules every ramp on
 * the live nodes. Returns the new descriptor whose currents are the
 * scheduled targets, so the next apply ramps from what was just planned.
 *
 * Slow spatial movement (p3-t16, ADR 0017): `spaceSeed` + `nowSeconds`
 * select the seeded macro wander (minute epochs, lane-blind — never lane
 * state, never agent events) that breathes each lane's pan/width/distance
 * around its mapped static region on the declared pan/width/reverbSend
 * ramps. Live callers pass their own seed and clock; QA passes the render
 * seed and render time. Omit both and the static regions hold exactly
 * (pre-spatial callers keep byte-identical plans).
 *
 * Inside Tone.Offline, Tone.now() stays 0, so every ramp would pile at t=0;
 * pass `at` (the transport callback time) to anchor the ramps when the
 * scenario says they happen. Live callers omit it and ramp from now.
 */
export function applyToGraph(
  graph: ClearingGraph,
  params: SceneParams,
  previous?: GraphDescriptor,
  at?: number,
  space?: { readonly seed: number; readonly nowSeconds: number },
): GraphDescriptor {
  const wander = spaceWanderFor(space, params.lanes.length);
  const next = planGraph(params, previous, wander);
  const anchor = at ?? Tone.now();
  scheduleMove(graph.master.gain.volume, next.master, anchor);
  scheduleMove(graph.bed.gain.gain, next.bed, anchor);
  scheduleMove(graph.nature.gain.gain, next.nature, anchor);
  rampNatureCrossfade(graph, next, anchor);
  rampMacro(graph, next, anchor);
  if (next.drone.handover)
    crossfadeDrone(graph, next.drone.pitchClass, anchor, next.drone.moves - 1);
  next.lanes.forEach((lane, laneIndex) => {
    const nodes = graph.lanes[laneIndex];
    if (nodes === undefined) return;
    rampLane(nodes, lane, anchor);
  });
  return advanceCurrents(next);
}

/**
 * Resolves the seeded macro wander for one apply: the epoch index from
 * the render clock (minute windows), the render seed as the stream. Pure
 * function of (seed, epoch) — agent traffic is not an input, so no agent
 * event can trigger, steer or synchronize the space. Exported so the
 * mono-identity unit proof can pin the lane-blind surface.
 */
export function spaceWanderFor(
  space: { readonly seed: number; readonly nowSeconds: number } | undefined,
  laneCount: number,
): SpatialWander | undefined {
  if (space === undefined) return undefined;
  return spatialWander(space.seed, spatialEpochAt(space.nowSeconds), laneCount);
}

/** Minute-epoch length the spatial wander steps on (macro-schedule cadence). */
export { SPATIAL_CORRELATION_SECONDS };

/**
 * Slow crossfade between the nature bed's two loop voices (p3-t15
 * revp3t15): the descriptor tick alternates which voice leads, on the
 * 6 s density-approach ramp, so a 12 s loop never repeats obviously
 * inside a long render. Both voices hold the same sampled buffer at
 * half-loop staggered offsets (seeded schedule); the crossfade only
 * re-balances the pair, it never moves the seat gain above its planned
 * target — the bed stays below the texture at every sample. The tick
 * comes from the descriptor's own apply count (planGraph), so the
 * alternation is lane-blind and Node-provable — no lane state, no agent
 * events, no clock.
 */
function rampNatureCrossfade(graph: ClearingGraph, next: GraphDescriptor, anchor: number): void {
  const [voiceA, voiceB] = graph.nature.voiceGains;
  if (voiceA === undefined || voiceB === undefined) return;
  // Equal-power slow crossfade: the pair always sums in power to unity
  // (cos² + sin² = 1 at either parity angle), so the SEAT gain — the one
  // density-planned level — is the only thing that sets the bed level.
  // Both ride the declared density approach, never steps.
  const [gainA, gainB] = natureVoiceGains(natureCrossfadeParity(next.natureTick.target));
  scheduleMove(
    voiceA.gain,
    { path: "nature.voiceA", ramp: "density", current: 0, target: gainA ?? 1 },
    anchor,
  );
  scheduleMove(
    voiceB.gain,
    { path: "nature.voiceB", ramp: "density", current: 0, target: gainB ?? 0 },
    anchor,
  );
}

/**
 * Ramps the macro world's own voice: the texture swell follows the
 * planned density-approach gain; the swell air-band centre and the field
 * low-pass follow the planned cutoff moves (checkpoint brightness as
 * audible cutoff/timbre); the breathing LFO rate follows the planned
 * period move; the harmonic field's seat gain follows the core field
 * scale (Calm, presence, near-silence) times the dB seat; and each field
 * slot ramps its level and hands its pitch over when the plan says so
 * (ADR 0025). All through the single dispatch; the world breathes with
 * the checkpoint, not with agent traffic.
 */
function rampMacro(graph: ClearingGraph, next: GraphDescriptor, anchor: number): void {
  const swell = next.macroSwell;
  const swellTarget = swell.target * 10 ** (MACRO_SWELL_GAIN_DB / 20);
  scheduleMove(graph.macro.swellGain.gain, { ...swell, target: swellTarget }, anchor);
  scheduleMove(graph.macro.swellFilter.frequency, next.macroCutoff, anchor);
  scheduleMove(graph.macro.fieldFilter.frequency, next.macroField, anchor);
  scheduleMove(graph.macro.pulseLfo.frequency, next.macroPulse, anchor);
  const seat = dbToGain(HARMONIC_FIELD.seatDb);
  scheduleMove(
    graph.macro.fieldGain.gain,
    { ...next.macroFieldGain, target: next.macroFieldGain.target * seat },
    anchor,
  );
  next.fieldVoices.forEach((voice, slot) => {
    const nodes = graph.macro.fieldSlots[slot];
    if (nodes === undefined) return;
    rampFieldSlot(nodes, voice, anchor, next.drone.pitchClass);
  });
  for (const ping of next.fieldPings) {
    scheduleFieldPing(graph, ping, anchor + ping.inS);
  }
}

/**
 * Sounds one bloom (ADR 0025) on the pool voice its id selects: the stack
 * is retuned as a step at `start`, where its envelope is exactly 0, then
 * swells over 0.5 s, holds briefly and releases over 6 s into the field's
 * bright low-pass — so it rides the field seat, Calm and the reverb share.
 * No node is created or disposed. Never articulated: the swell is what
 * keeps a bloom from reading as an agent gesture.
 */
export function scheduleFieldPing(
  graph: ClearingGraph,
  ping: { readonly id: number; readonly midi: number; readonly level: number },
  start: number,
): void {
  // Even ids bloom on the pad stack, odd ids on the glass stack.
  const glass = ping.id % 2 === 1;
  const spec = glass ? HARMONIC_FIELD.pingGlass : HARMONIC_FIELD.ping;
  const pool = glass ? graph.macro.glassVoices : graph.macro.pingVoices;
  const voice = pool[Math.floor(ping.id / 2) % Math.max(1, pool.length)];
  if (voice === undefined) return;
  const parts = [{ semitones: 0, share: 1 }, ...spec.partials];
  voice.oscillators.forEach((osc, index) => {
    const semitones = parts[index]?.semitones ?? 0;
    osc.frequency.setValueAtTime(midiToFrequency(ping.midi + semitones), start);
  });
  const peak = spec.peak * Math.min(1, Math.max(0, ping.level));
  voice.envelope.gain.linearRampTo(peak, spec.attackS, start);
  voice.envelope.gain.linearRampTo(0, spec.releaseS, start + spec.attackS + spec.holdS);
}

/**
 * One field slot per apply: a handover crossfades the banks to the new
 * pitch; a retune sets the sounding bank's pitch where it is inaudible
 * (the slot is silent, or nothing has faded in yet); the level rides the
 * fieldVoice ramp. Exported for the Node proof (test/field-voice.test.ts).
 */
export function rampFieldSlot(
  nodes: FieldSlotNodes,
  voice: FieldVoiceDescriptor,
  anchor: number,
  tonic = 0,
): void {
  if (voice.midi !== null) {
    if (voice.handover) {
      crossfadeFieldVoice(nodes, voice.midi, anchor, voice.moves - 1, tonic);
    } else if (voice.retune) {
      const bank = nodes.banks[voice.moves % 2];
      if (bank !== undefined) retuneFieldBank(bank, voice.midi, anchor, tonic);
    }
  }
  scheduleMove(nodes.gain.gain, voice.gain, anchor);
}

/**
 * Detune in cents for a field pitch, by its interval class above the
 * tonal centre: roots and fifths lock (±1.5 c), colour tones shimmer
 * (±4 c), the seventh and sharp eleventh shimmer most (±6 c) — the
 * emergent tuning of a choir, where octaves and fifths converge and
 * extensions keep beating — and no pair beats faster than maxBeatHz.
 * Pure; exported for the unit proof.
 */
export function fieldDetuneCents(midi: number, tonic = 0): number {
  const pc = (((midi - 2 - tonic) % 12) + 12) % 12;
  const cents =
    pc === 0 || pc === 7
      ? HARMONIC_FIELD.detuneCents.stable
      : pc === 6 || pc === 11
        ? HARMONIC_FIELD.detuneCents.extension
        : HARMONIC_FIELD.detuneCents.colour;
  return Math.min(cents, beatLimitedCents(midiToFrequency(midi), HARMONIC_FIELD.maxBeatHz));
}

/**
 * Sets one bank to a pitch as a step at `anchor`: each voice keeps its
 * construction offset from the bank root (the octave partial stays an
 * octave up), and the interval-class spread is folded into the frequency
 * (the pair at ∓cents, the partial between them). The detune param is left
 * to the per-oscillator drift LFO, which owns it.
 */
function retuneFieldBank(bank: LaneVoiceBank, midi: number, anchor: number, tonic = 0): void {
  const cents = fieldDetuneCents(midi, tonic);
  const root = bank.midi[0] ?? midi;
  bank.voices.forEach((voice, index) => {
    const offset = (bank.midi[index] ?? root) - root;
    const spread = index === 0 ? -cents : index === 1 ? cents : cents / 2;
    voice.frequency.setValueAtTime(midiToFrequency(midi + offset) * 2 ** (spread / 1200), anchor);
  });
}

/**
 * Hands a field slot's pitch from the sounding bank to the silent one
 * over the fieldCrossfade class (5 s): the silent bank is retuned at the
 * anchor, where its gain is exactly 0, then the two banks ride equal-power
 * half-ramps meeting at 1/√2 — the old note fades out as the new fades in,
 * and no pitch bends. `moveIndex` is the count of earlier handovers: even
 * hands bank 0 → 1, odd hands it back, exactly like a lane move.
 */
export function crossfadeFieldVoice(
  nodes: FieldSlotNodes,
  midi: number,
  anchor: number,
  moveIndex: number,
  tonic = 0,
): void {
  const outgoing = nodes.banks[moveIndex % 2];
  const incoming = nodes.banks[(moveIndex + 1) % 2];
  if (outgoing === undefined || incoming === undefined) return;
  retuneFieldBank(incoming, midi, anchor, tonic);
  const half = RAMP_TIMES.fieldCrossfade.seconds / 2;
  for (const gain of outgoing.gains) {
    gain.gain.linearRampTo(CROSSFADE_MID_GAIN, half, anchor);
    gain.gain.linearRampTo(0, half, anchor + half);
  }
  for (const gain of incoming.gains) {
    gain.gain.linearRampTo(CROSSFADE_MID_GAIN, half, anchor);
    gain.gain.linearRampTo(1, half, anchor + half);
  }
}

/**
 * Semitones the drone moves for a tonal centre (semitones above D): the
 * nearest transposition, −5…+6, so the floor stays between A1 and G#2
 * and never climbs out of the 400 Hz low-pass it lives under. Pure;
 * exported for the unit proof.
 */
export function droneShiftSemitones(tonic: number): number {
  const pc = ((tonic % 12) + 12) % 12;
  return pc <= 6 ? pc : pc - 12;
}

/**
 * Hands the drone to a new tonal centre (owner direction 2026-10-29): the
 * silent bank is retuned at the anchor, where its gain is exactly 0, each
 * oscillator keeping its construction spread, then the banks ride the
 * same equal-power half-ramps a field voice does, over the 10 s
 * droneCrossfade class. The old floor fades out as the new one fades in;
 * nothing bends. `moveIndex` counts earlier handovers.
 */
export function crossfadeDrone(
  graph: ClearingGraph,
  tonic: number,
  anchor: number,
  moveIndex: number,
): void {
  const outgoing = graph.bed.banks[moveIndex % 2];
  const incoming = graph.bed.banks[(moveIndex + 1) % 2];
  if (outgoing === undefined || incoming === undefined) return;
  const shift = droneShiftSemitones(tonic);
  incoming.voices.forEach((voice, index) => {
    const osc = DRONE_VOICE.oscillators[index];
    if (osc === undefined) return;
    voice.frequency.setValueAtTime(
      midiToFrequency(osc.midi + shift) * 2 ** (osc.detuneCents / 1200),
      anchor,
    );
  });
  const half = RAMP_TIMES.droneCrossfade.seconds / 2;
  for (const gain of outgoing.gains) {
    gain.gain.linearRampTo(CROSSFADE_MID_GAIN, half, anchor);
    gain.gain.linearRampTo(0, half, anchor + half);
  }
  for (const gain of incoming.gains) {
    gain.gain.linearRampTo(CROSSFADE_MID_GAIN, half, anchor);
    gain.gain.linearRampTo(1, half, anchor + half);
  }
}

/**
 * Level each bank holds at the midpoint of the crossfade. The two banks
 * sound different pitches, so they sum incoherently (power, not
 * amplitude): 1/√2 each puts the summed power at exactly the level one
 * bank alone holds, so the lane neither dips nor swells as the note
 * changes hands.
 */
export const CROSSFADE_MID_GAIN = Math.SQRT1_2;

/**
 * Moves one lane to a new note by CROSSFADING its two voice banks: the
 * silent bank is retuned to the new note and faded in while the sounding
 * bank fades out, over the `crossfade` class (3 s total). The old note
 * fades out and the new note fades in — no pitch ever bends, which is
 * what the owner asked for after hearing the glide ("the pitch shift
 * sounds too weird"): a sustained ambient voice that slides reads as a
 * tape effect rather than as a new note. The lane's reverb tail (~5 s)
 * carries the old note past its own fade, so the two notes share the
 * space instead of butting against each other.
 *
 * Which bank is which comes from `moveIndex` (0 for a lane's first move),
 * so the function stays pure and stateless: even moves hand bank 0 → 1,
 * odd moves hand it back. Each bank is retuned as a whole — every voice
 * keeps its own offset from the bank's root, so the octave relations
 * inside the voicing and the type/detune spread are untouched. Both banks
 * share the lane's filters, layer gains, pan and register, so nothing but
 * the sounding pitch can change.
 *
 * The retune itself is a step on the INCOMING bank's oscillators,
 * scheduled at the anchor where that bank's gain is exactly 0 — the one
 * place a step is inaudible by construction, and the reason bank 1 runs
 * silent from construction rather than being started per move.
 *
 * Live (the harmonic planner, ADR 0023) and the QA ensemble schedules both
 * call this; the harmonic field has its own copy over its slower class
 * (crossfadeFieldVoice below).
 */
export function crossfadeLaneVoices(
  graph: ClearingGraph,
  laneIndex: number,
  movePitch: number,
  anchor: number,
  moveIndex: number,
): void {
  const lane = graph.lanes[laneIndex];
  if (lane === undefined) return;
  const banks = lane.voiceBanks;
  if (banks.length < 2) return;
  const outgoing = banks[moveIndex % 2];
  const incoming = banks[(moveIndex + 1) % 2];
  if (outgoing === undefined || incoming === undefined) return;
  const root = incoming.midi[0] ?? movePitch;
  incoming.voices.forEach((voice, index) => {
    const construction = incoming.midi[index];
    if (construction === undefined) return;
    voice.frequency.setValueAtTime(midiToFrequency(movePitch + (construction - root)), anchor);
  });
  const half = RAMP_TIMES.crossfade.seconds / 2;
  for (const gain of outgoing.gains) {
    gain.gain.linearRampTo(CROSSFADE_MID_GAIN, half, anchor);
    gain.gain.linearRampTo(0, half, anchor + half);
  }
  for (const gain of incoming.gains) {
    gain.gain.linearRampTo(CROSSFADE_MID_GAIN, half, anchor);
    gain.gain.linearRampTo(1, half, anchor + half);
  }
}

/** Schedules every parameter of one lane chain through the single dispatch. */
function rampLane(nodes: LaneNodes, lane: GraphDescriptor["lanes"][number], anchor: number): void {
  scheduleMove(nodes.airGain.gain, lane.airGain, anchor);
  scheduleMove(nodes.airFilter.frequency, lane.airCutoff, anchor);
  scheduleMove(nodes.grainGain.gain, lane.grainGain, anchor);
  scheduleMove(nodes.grainDensity, lane.grainDensity, anchor);
  scheduleStuck(nodes, lane, anchor);
  scheduleMove(nodes.pulseGain.gain, lane.pulseGain, anchor);
  scheduleMove(nodes.pulseLfo.frequency, lane.pulsePeriodRate, anchor);
  scheduleMove(nodes.tensionGain.gain, lane.tensionGain, anchor);
  scheduleMove(nodes.reverbSend.gain, lane.reverbSend, anchor);
  scheduleMove(nodes.brightness.gain, lane.brightness, anchor);
  scheduleMove(nodes.widener.width, lane.width, anchor);
  scheduleMove(nodes.panner.pan, lane.pan, anchor);
  scheduleMove(nodes.gestureTrim.gain, lane.gestureCalm, anchor);
}

/**
 * The single dispatch every scheduled move flows through: opens the ramp
 * from the held value at `anchor`, then runs the automation
 * automationForRamp declares for the move's class. Exponential gain moves
 * lift zero endpoints to the shared floor so the Web Audio ramp never sees
 * 0; the drift approach likewise never targets 0.
 *
 * `anchor` is passed to the ramp itself as its explicit start time, and
 * that is load-bearing: Tone's `*RampTo(value, rampTime, startTime?)`
 * defaults startTime to `now()` AND opens with its own
 * `setRampPoint(startTime)` — whose `cancelAndHoldAtTime(now)` erases a
 * hold point the caller placed in the future. A bare
 * `setRampPoint(anchor)` therefore anchors nothing: the ramp runs at
 * `now()` instead. That is invisible when anchor ≈ now (live applies, and
 * offline applies from a transport callback) and total when a move is
 * scheduled ahead of the clock — every such ramp piles at the start of
 * the render, last writer winning. Exported for the Node proof that the
 * anchor reaches the automation (test/apply.test.ts).
 */
export function scheduleMove(
  param:
    | Tone.Param<"gain">
    | Tone.Param<"decibels">
    | Tone.Param<"audioRange">
    | Tone.Signal<"frequency">
    | Tone.Signal<"decibels">
    | Tone.Signal<"normalRange">
    | Tone.Signal<"audioRange">,
  move: RampedParameter,
  anchor: number,
): void {
  const ramp = RAMP_TIMES[move.ramp];
  const automation = automationForRamp(move.ramp);
  if (automation === "exponentialRampTo") {
    const target = move.target <= GAIN_EPSILON ? GAIN_EPSILON : move.target;
    (param as Tone.Param<"gain">).exponentialRampTo(target, ramp.seconds, anchor);
  } else if (automation === "targetRampTo") {
    const target = move.target <= 0 ? GAIN_EPSILON : move.target;
    (param as Tone.Signal<"frequency">).targetRampTo(target, ramp.seconds, anchor);
  } else {
    (param as Tone.Signal<"audioRange">).linearRampTo(move.target, ramp.seconds, anchor);
  }
}

/**
 * Pure schedule math for the stuck voice: the Tremolo depth target that
 * voices a SceneParams stuck depth without ever exceeding unity. The
 * Tremolo multiplies the grain path by its LFO output (1→0 swing), so
 * depth IS the peak close — capping it at 1 caps the path at the planned
 * grain gain. Exported for the unit proof (struggle never raises gain by
 * construction) and the Node trajectory tests.
 */
export function stuckAmplitudeTarget(stuckDepth: number): number {
  return Math.min(1, Math.max(0, stuckDepth));
}

/**
 * Pure schedule math for one gesture note: the compensated peak the
 * gesture bus must voice so the note holds its level through the master
 * Calm trim. The gesture trim inverts the master trim exactly
 * (gestureCalmCompensation), so the product is 1 at every Calm — except
 * the documented attention taper, which voices through the event gain,
 * not the trim. Exported for the invariance proof in Node.
 */
export function compensatedGesturePeak(eventGain: number, masterTargetDb: number): number {
  return eventGain * 10 ** (-masterTargetDb / 20);
}

/**
 * Stuck re-articulation and the pulse contraction (p3-t14 revp3t14,
 * ADR 0019): the stuck depth plans onto the Tremolo DEPTH (NormalRange —
 * the effect multiplies the path by its 1→0 LFO output, so the swing can
 * only close toward silence, never above the planned grain gain), the
 * rate plans onto the Tremolo frequency, and the pulse period plans onto
 * the swell LFO rate. All three ride the declared regularity/period
 * ramps, never steps.
 */
function scheduleStuck(
  nodes: LaneNodes,
  lane: GraphDescriptor["lanes"][number],
  anchor: number,
): void {
  scheduleMove(
    nodes.stuckTremolo.depth as unknown as Tone.Param<"gain">,
    { ...lane.grainStuck, target: stuckAmplitudeTarget(lane.grainStuck.target) },
    anchor,
  );
  scheduleMove(nodes.stuckTremolo.frequency, lane.grainStuckRate, anchor);
}

/**
 * Advances every descriptor current to its scheduled target, so the next
 * plan ramps from what was just scheduled rather than re-planning the past.
 */
function advanceCurrents(next: GraphDescriptor): GraphDescriptor {
  const advance = (move: RampedParameter): RampedParameter => ({
    ...move,
    current: move.target,
  });
  return {
    master: advance(next.master),
    bed: advance(next.bed),
    nature: advance(next.nature),
    natureTick: advance(next.natureTick),
    macroSwell: advance(next.macroSwell),
    macroCutoff: advance(next.macroCutoff),
    macroField: advance(next.macroField),
    macroPulse: advance(next.macroPulse),
    macroFieldGain: advance(next.macroFieldGain),
    fieldVoices: next.fieldVoices.map((voice) => ({
      midi: voice.midi,
      gain: advance(voice.gain),
      moves: voice.moves,
      handover: false,
      retune: false,
    })),
    fieldPings: [],
    fieldPingsThroughId: next.fieldPingsThroughId,
    drone: { ...next.drone, handover: false },
    lanes: next.lanes.map((lane) => ({
      laneId: lane.laneId,
      airGain: advance(lane.airGain),
      airCutoff: advance(lane.airCutoff),
      grainGain: advance(lane.grainGain),
      grainDensity: advance(lane.grainDensity),
      grainStuck: advance(lane.grainStuck),
      grainStuckRate: advance(lane.grainStuckRate),
      pulseGain: advance(lane.pulseGain),
      pulsePeriodRate: advance(lane.pulsePeriodRate),
      tensionGain: advance(lane.tensionGain),
      reverbSend: advance(lane.reverbSend),
      brightness: advance(lane.brightness),
      width: advance(lane.width),
      pan: advance(lane.pan),
      gestureCalm: advance(lane.gestureCalm),
    })),
  };
}

/**
 * Schedules a gesture event plan onto the live graph, through each lane's
 * gesture bus, so the lane's timbre/pan/brightness/reverb identity applies
 * intrinsically. Transient voices start at their envelope time and stop at
 * their envelope end; every gain move is a ramp, never a step. Returns a
 * handle that disposes every transient node — the caller calls it once the
 * gesture has finished sounding (all envelopes have reached zero).
 *
 * Scheduling uses absolute transport seconds (`now` + the plan's relative
 * offsets) carried as each ramp's own start time (see scheduleMove: a bare
 * setRampPoint would let a plan's later window cancel its own opening), so
 * the plan must be scheduled from the context that sounds it:
 * live callers pass Tone.now() directly; offline QA schedules the plan
 * from the main Offline callback (same context), never from a nested
 * transport callback, whose nodes belong to a different audio context.
 */

export type GesturePlaybackHandle = {
  readonly dispose: () => void;
};

export function scheduleGesturePlan(
  graph: ClearingGraph,
  events: readonly GestureVoiceEvent[],
  now: number,
): GesturePlaybackHandle {
  const transient: { dispose: () => void; stop?: () => void }[] = [];
  const disposeAll = (): void => {
    for (const node of transient) {
      node.stop?.();
      node.dispose();
    }
  };
  for (const event of events) {
    switch (event.kind) {
      case "bus":
        if (event.from === 1 && event.to === 0 && event.startS === 0) {
          const sampler = graph.piano?.lanes[event.laneIndex];
          if (sampler) {
            sampler.releaseAll(now, event.endS);
          }
        }
        scheduleBusMove(graph.lanes[event.laneIndex]?.gestureBus, event, now);
        break;
      case "note":
        scheduleGestureNote(graph, event, now, transient);
        break;
      case "noise":
        scheduleGestureNoise(graph, event, now, transient);
        break;
      case "sub":
        scheduleGestureSub(graph, event, now, transient);
        break;
      case "swell":
        scheduleSwell(graph, event, now);
        break;
      case "breath":
        scheduleGestureBreath(graph, event, now, transient);
        break;
    }
  }
  return { dispose: disposeAll };
}

/** Exported for the Node proof that a bus window lands at its own time. */
export function scheduleBusMove(
  bus: Tone.Gain | undefined,
  event: Extract<GestureVoiceEvent, { kind: "bus" }>,
  now: number,
): void {
  if (bus === undefined) return;
  const t0 = now + event.startS;
  const t1 = now + event.endS;
  const duration = Math.max(1e-3, t1 - t0);
  const safeTo = Math.max(event.to, EXPONENTIAL_GAIN_FLOOR);

  // t0 is the ramp's explicit start time, not just a hold point: a bare
  // setRampPoint would be erased by the ramp's own setRampPoint(now), so
  // every window of a plan would collapse onto now — a plan's later close
  // cancelling its own open. See scheduleMove for the full note.
  if (event.curve === "exponential") {
    bus.gain.exponentialRampTo(safeTo, duration, t0);
  } else {
    bus.gain.linearRampTo(safeTo, duration, t0);
  }
}

function scheduleGestureNote(
  graph: ClearingGraph,
  event: Extract<GestureVoiceEvent, { kind: "note" }>,
  now: number,
  transient: { dispose: () => void; stop?: () => void }[],
): void {
  const lane = graph.lanes[event.laneIndex];
  if (!lane) return;
  const start = now + event.startS;
  if (event.instrument === "piano") {
    const sampler = graph.piano?.lanes[event.laneIndex];
    if (!sampler) throw new Error("Piano samples are not ready. Restart audio to try again.");
    sampler.triggerAttackRelease(
      midiToFrequency(event.midi),
      event.holdUntilS - event.startS,
      start,
      event.gain,
    );
    return;
  }
  const gain = new Tone.Gain(0);
  transient.push(gain);
  gain.connect(lane.gestureBus);
  const nOsc = Math.max(1, event.timbre.oscillators.length);
  for (const osc of event.timbre.oscillators) {
    const freq = midiToFrequency(event.midi) * 2 ** (osc.detuneCents / 1200);
    const voice =
      osc.fm !== undefined
        ? new Tone.FMOscillator({
            frequency: freq,
            type: osc.type,
            detune: osc.detuneCents,
            harmonicity: osc.fm.harmonicity,
            modulationIndex: osc.fm.modulationIndex,
            modulationType: "sine",
          })
        : new Tone.Oscillator({ frequency: freq, type: osc.type, detune: osc.detuneCents });
    transient.push(voice);
    voice.connect(gain);
    voice.start(start);
    voice.stop(now + event.holdUntilS + event.releaseS + 0.05);
  }
  const peak = event.gain / nOsc;
  scheduleEnvelope(
    gain.gain,
    start,
    event.startS,
    peak,
    event.attackS,
    event.holdUntilS,
    event.releaseS,
  );
}

function scheduleGestureNoise(
  graph: ClearingGraph,
  event: Extract<GestureVoiceEvent, { kind: "noise" }>,
  now: number,
  transient: { dispose: () => void; stop?: () => void }[],
): void {
  const lane = graph.lanes[event.laneIndex];
  if (!lane) return;
  const start = now + event.startS;
  const noise = new Tone.Noise({
    type: "white",
    fadeIn: SAMPLE_START_FADE_S,
    fadeOut: SAMPLE_START_FADE_S,
  });
  const filter = new Tone.Filter(event.lowpassHz, "lowpass");
  const gain = new Tone.Gain(0);
  transient.push(noise, filter, gain);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(lane.gestureBus);
  noise.start(start);
  noise.stop(now + event.holdUntilS + event.releaseS + 0.05);
  scheduleEnvelope(
    gain.gain,
    start,
    event.startS,
    event.gain,
    event.attackS,
    event.holdUntilS,
    event.releaseS,
  );
}

/**
 * High-lane flute breath (p3-t13): a filtered noise transient through the
 * voice low-pass into the lane's gesture bus — the same envelope path as
 * every gesture note, so the breath articulation ramps, never steps.
 */
function scheduleGestureBreath(
  graph: ClearingGraph,
  event: Extract<GestureVoiceEvent, { kind: "breath" }>,
  now: number,
  transient: { dispose: () => void; stop?: () => void }[],
): void {
  const lane = graph.lanes[event.laneIndex];
  if (!lane) return;
  const start = now + event.startS;
  const noise = new Tone.Noise({
    type: "pink",
    fadeIn: SAMPLE_START_FADE_S,
    fadeOut: SAMPLE_START_FADE_S,
  });
  const filter = new Tone.Filter(event.lowpassHz, "lowpass");
  const gain = new Tone.Gain(0);
  transient.push(noise, filter, gain);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(lane.gestureBus);
  noise.start(start);
  noise.stop(now + event.holdUntilS + event.releaseS + 0.05);
  scheduleEnvelope(
    gain.gain,
    start,
    event.startS,
    event.gain,
    event.attackS,
    event.holdUntilS,
    event.releaseS,
  );
}

function scheduleGestureSub(
  graph: ClearingGraph,
  event: Extract<GestureVoiceEvent, { kind: "sub" }>,
  now: number,
  transient: { dispose: () => void; stop?: () => void }[],
): void {
  const lane = graph.lanes[event.laneIndex];
  if (!lane) return;
  const start = now + event.startS;
  const gain = new Tone.Gain(0);
  transient.push(gain);
  gain.connect(lane.gestureBus);
  for (const detune of [-ATTENTION_SUB_DETUNE_CENTS, ATTENTION_SUB_DETUNE_CENTS]) {
    const voice = new Tone.Oscillator({
      frequency: midiToFrequency(event.midi) * 2 ** (detune / 1200),
      type: "sine",
      detune: 0,
    });
    transient.push(voice);
    voice.connect(gain);
    voice.start(start);
    voice.stop(now + event.holdUntilS + event.releaseS + 0.05);
  }
  scheduleEnvelope(
    gain.gain,
    start,
    event.startS,
    event.gain,
    event.attackS,
    event.holdUntilS,
    event.releaseS,
  );
}

function scheduleSwell(
  graph: ClearingGraph,
  event: Extract<GestureVoiceEvent, { kind: "swell" }>,
  now: number,
): void {
  const bedGain = graph.bed.gain.gain;
  const base = bedGain.value;
  const target = base * 10 ** (event.gainDb / 20);
  const t0 = now + event.startS;
  const holdAbs = t0 + (event.holdUntilS - event.startS);
  // Both ramps carry their own explicit start time (see scheduleMove):
  // otherwise the release cancels the attack at now and the swell never
  // rises.
  bedGain.linearRampTo(target, event.attackS, t0);
  bedGain.linearRampTo(base, event.releaseS, holdAbs);
}

/** Plays the sampled overflow roll through the owned room sampler, limiter and reverb. */
export function scheduleOverflowCue(
  graph: ClearingGraph,
  plan: OverflowCuePlan,
  now: number,
): GesturePlaybackHandle {
  const sampler = graph.piano?.overflow;
  if (!sampler) throw new Error("Piano samples are not ready. Restart audio to try again.");
  for (const voice of plan.voices) {
    sampler.triggerAttackRelease(
      midiToFrequency(voice.midi),
      plan.holdUntilS - voice.startS,
      now + voice.startS,
      plan.peakGain * voice.touch,
    );
  }
  return { dispose() {} };
}

/**
 * Attack → hold → release on one gain param, in absolute seconds. Both
 * ramps pass their own start time (`start`, then `holdAbs`) — a bare
 * setRampPoint is erased by the next ramp's own setRampPoint(now), which
 * would land the release on top of the attack and silence the note. See
 * scheduleMove. Exported for the Node proof (test/apply.test.ts).
 */
export function scheduleEnvelope(
  param: Tone.Param<"gain">,
  start: number,
  eventStartS: number,
  peak: number,

  attackS: number,

  holdUntilS: number,

  releaseS: number,
): void {
  const holdAbs = start + (holdUntilS - eventStartS);
  param.linearRampTo(peak, attackS, start);
  param.linearRampTo(0, releaseS, holdAbs);
}
