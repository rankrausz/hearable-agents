// packages/core/src/scene/render.ts — the pure LaneRender[] →
// SceneParams mapping. What this is for: turning lane signals into the
// sound parameters `packages/audio` renders, exactly per
// docs/SOUND_DESIGN.md §Mapping (presence/layer gains, activityCurve,
// lifecycle gains, `other` split, tension on waiting, structural
// struggle-to-stuck-gate/rate/period/note-set per ADR 0019, prominence-
// to-reverb/brightness/width, waiting duck, Calm presence/density scaling
// per ADR 0018, progress brightening) with the loudness budget from
// docs/STATE_ENGINE.md §Attention model enforced here so it is testable.
// What it must not do: I/O, time, randomness, node:* or workspace imports,
// or branch on an agent's name — `LaneRender` carries no agent field, so
// identical renders always produce identical scenes.
//
// Engine/attention split: the input contract bundles two owners. The daemon
// (Phase 2 engine) owns the signal subset — lifecycle, mode weights,
// activity, progress, struggle. The attention model (Phase 4) will own
// `prominence`, `foreground` and gesture triggers, computed per
// docs/STATE_ENGINE.md §Attention model. This phase drives those fields
// synthetically (sandbox sliders, QA fixtures); this module reads them as
// data and never infers them.

import { createRng } from "../rng.js";
import {
  FIELD_ACTIVATION_ORDER,
  FIELD_VOICES_AT_ENERGY,
  type FieldVoice,
  fieldAt,
  fieldChordTones,
} from "./field.js";

/** The most field voices that ever sound. */
const FIELD_VOICES_MAX = Math.max(...FIELD_VOICES_AT_ENERGY);

import { type MacroState, macroAt } from "./macro.js";
import type { LaneRender, SceneParams } from "./schema.js";
import {
  ACTIVITY_CURVE_EXPONENT,
  ACTIVITY_CURVE_FLOOR,
  AIR_RANGE_NARROW,
  AIR_RANGE_WIDE,
  BED_GAIN_NEAR_SILENCE_DBFS,
  BED_GAIN_NORMAL_DBFS,
  BRIGHTNESS_MAX_DB,
  BRIGHTNESS_MIN_DB,
  CALM_DENSITY_SLOPE,
  CALM_MASTER_GAIN_SLOPE_DB,
  EMPTY_ROOM_BED_DBFS,
  EMPTY_ROOM_DENSITY_SCALE,
  EMPTY_ROOM_FIELD_SCALE,
  FIELD_CALM_SLOPE,
  FIELD_NEAR_SILENCE_SCALE,
  FIELD_PRESENCE_FLOOR,
  FIELD_VOICES_QUIET,
  FOREGROUND_GAIN_NUDGE_DB,
  LIFECYCLE_GAIN_ACTIVE,
  LIFECYCLE_GAIN_IDLE,
  LIFECYCLE_GAIN_QUIET,
  LIFECYCLE_GAIN_STALE,
  LIFECYCLE_GAIN_WAITING,
  LOUDNESS_BUDGET_LINEAR,
  LOUDNESS_KNEE_LINEAR,
  MACRO_PRESENCE_SEATS,
  NEAR_SILENCE_CALM_MIN,
  NEAR_SILENCE_STRUGGLE_MAX,
  OTHER_LAYER_SHARE,
  PROGRESS_CUTOFF_BRIGHTENING,
  PROGRESS_UPPER_REGISTER_THRESHOLD,
  PULSE_PERIOD_RELAXED_S,
  PULSE_PERIOD_STUCK_S,
  REVERB_SEND_MAX,
  REVERB_SEND_MIN,
  ROUTINE_CALM_SCALE,
  STRUGGLE_NARROW_NOTE_SET_THRESHOLD,
  STRUGGLE_STUCK_HI,
  STRUGGLE_STUCK_LO,
  STUCK_GATE_MAX,
  STUCK_GATE_MIN,
  STUCK_RATE_FULL_HZ,
  STUCK_RATE_NARROW_HZ,
  TEXTURE_NEAR_SILENCE_DBFS,
  TURN_COMPLETE_TARGET_GAIN,
  WAITING_DUCK_AT_CALM0,
  WIDTH_MAX,
  WIDTH_MIN,
} from "./tuning.js";

/** Calm value with its three derived scales. */
type CalmFactors = {
  readonly routine: number;
  readonly densityScale: number;
  readonly masterGainDb: number;
  readonly calm01: number;
};

function calmFactors(calm: number): CalmFactors {
  const clamped = Math.min(1, Math.max(0, calm));
  return {
    routine: 1 - ROUTINE_CALM_SCALE * clamped,
    densityScale: 1 - CALM_DENSITY_SLOPE * clamped,
    masterGainDb: -CALM_MASTER_GAIN_SLOPE_DB * clamped,
    calm01: clamped,
  };
}

/**
 * The `activityCurve`: a quiet lane still exists at the floor, a busy lane
 * is fuller. Loudness normalization happens separately via the budget.
 */
export function activityCurve(activity: number): number {
  return ACTIVITY_CURVE_FLOOR + (1 - ACTIVITY_CURVE_FLOOR) * activity ** ACTIVITY_CURVE_EXPONENT;
}

/** Presence multiplier for a lifecycle state at a fade progress. */
export function lifecycleGain(lifecycle: LaneRender["lifecycle"], fadeProgress: number): number {
  switch (lifecycle) {
    case "idle":
      return LIFECYCLE_GAIN_IDLE;
    case "active":
      return LIFECYCLE_GAIN_ACTIVE;
    case "quiet":
      return LIFECYCLE_GAIN_QUIET;
    case "stale":
      return LIFECYCLE_GAIN_STALE;
    case "waiting":
      return LIFECYCLE_GAIN_WAITING;
    case "turn_complete":
      return TURN_COMPLETE_TARGET_GAIN + (1 - TURN_COMPLETE_TARGET_GAIN) * (1 - fadeProgress);
  }
}

/** Linear interpolation between two stops. */
function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * How far the stuck re-articulation has closed at a struggle: 0 below the
 * stick threshold (~0.15, the texture still sounds free), ramping to 1 at
 * full struggle. The same amount drives the gate depth and the pulse
 * contraction, so the stuck voice reads as one structure closing in.
 * Exported for the drift bounds and the Node trajectory proofs.
 */
export function stuckAmount(struggle: number): number {
  const t = Math.min(
    1,
    Math.max(0, (struggle - STRUGGLE_STUCK_LO) / (STRUGGLE_STUCK_HI - STRUGGLE_STUCK_LO)),
  );
  return t * t * (3 - 2 * t);
}

/**
 * Renders one lane's voice: presence, layer gains, struggle/progress texture
 * and prominence proximity. `fadeProgress` is the 0..1 progress through the
 * 4 s turn_complete release (0 at resolve, 1 silent); every other lifecycle
 * ignores it. Near-silence clamps texture gains to the −48 dBFS ceiling.
 */
function renderLane(
  lane: LaneRender,
  factors: CalmFactors,
  fadeProgress: number,
  nearSilence: boolean,
): SceneParams["lanes"][number] {
  const presence =
    activityCurve(lane.activity) * factors.routine * lifecycleGain(lane.lifecycle, fadeProgress);
  // While waiting, the lane's own routine path yields (WAITING_DUCK_DB) so
  // the question gesture's first note reads against a quiet floor. The
  // tension pad holds the band instead (Calm-invariant), so waiting stays
  // present while the gesture onset separates from the texture.
  //
  // The duck is itself Calm-invariant: at high Calm the routine path is
  // already quiet, so ducking deeper would push it toward silence without
  // helping the onset. The duck target is 3.5 dB at calm 0, easing to
  // 2 dB at calm 1 (the gesture then separates against the calm-thinned
  // floor).
  const duckDb = WAITING_DUCK_AT_CALM0 - (WAITING_DUCK_AT_CALM0 - 2) * factors.calm01;
  const waitingYield = lane.lifecycle === "waiting" ? 10 ** (-duckDb / 20) : 1;
  const otherShare = lane.mode.other * OTHER_LAYER_SHARE;
  const layers = {
    air: presence * (lane.mode.exploring + otherShare) * waitingYield,
    grain: presence * (lane.mode.editing + otherShare) * waitingYield,
    pulse: presence * lane.mode.testing * waitingYield,
    // Calm never touches the tension layer while waiting
    // (docs/STATE_ENGINE.md §Calm): the waiting base holds at full gain and
    // only the master gain scales with Calm.
    tension: lane.lifecycle === "waiting" ? LIFECYCLE_GAIN_WAITING : 0,
  };

  const air = {
    gain: layers.air,
    cutoff: 1 + PROGRESS_CUTOFF_BRIGHTENING * lane.progress,
    cutoffRange: lerp(AIR_RANGE_WIDE, AIR_RANGE_NARROW, lane.struggle),
  };
  const stuckNoteSet = (lane.struggle > STRUGGLE_NARROW_NOTE_SET_THRESHOLD ? "narrow" : "full") as
    | "narrow"
    | "full";
  const stuck = stuckAmount(lane.struggle);
  const grain = {
    gain: layers.grain,
    density: factors.densityScale,
    stuckDepth: STUCK_GATE_MIN + (STUCK_GATE_MAX - STUCK_GATE_MIN) * stuck,
    stuckRateHz: stuckNoteSet === "narrow" ? STUCK_RATE_NARROW_HZ : STUCK_RATE_FULL_HZ,
    pulsePeriodS: lerp(PULSE_PERIOD_RELAXED_S, PULSE_PERIOD_STUCK_S, stuck),
    noteSet: stuckNoteSet,
    upperRegister: lane.progress > PROGRESS_UPPER_REGISTER_THRESHOLD,
  };
  const pulse = {
    gain: layers.pulse,
    pulsePeriodS: lerp(PULSE_PERIOD_RELAXED_S, PULSE_PERIOD_STUCK_S, stuck),
  };
  const tension = {
    on: lane.lifecycle === "waiting",
    gain: layers.tension,
  };
  const proximity = {
    reverbSend: lerp(REVERB_SEND_MIN, REVERB_SEND_MAX, lane.prominence),
    brightnessDb: lerp(BRIGHTNESS_MIN_DB, BRIGHTNESS_MAX_DB, lane.prominence),
    width: lerp(WIDTH_MIN, WIDTH_MAX, lane.prominence),
    gainNudgeDb: lane.foreground ? FOREGROUND_GAIN_NUDGE_DB : 0,
    calmDuckDb:
      lane.lifecycle === "waiting"
        ? WAITING_DUCK_AT_CALM0 - (WAITING_DUCK_AT_CALM0 - 2) * factors.calm01
        : 0,
  };

  if (!nearSilence) {
    return { laneId: lane.laneId, presence, layers, air, grain, pulse, tension, proximity };
  }
  const ceiling = 10 ** (TEXTURE_NEAR_SILENCE_DBFS / 20);
  return {
    laneId: lane.laneId,
    presence,
    layers: {
      air: Math.min(layers.air, ceiling),
      grain: Math.min(layers.grain, ceiling),
      pulse: Math.min(layers.pulse, ceiling),
      tension: layers.tension,
    },
    air: { ...air, gain: Math.min(air.gain, ceiling) },
    grain: { ...grain, gain: Math.min(grain.gain, ceiling) },
    pulse: { ...pulse, gain: Math.min(pulse.gain, ceiling) },
    tension,
    proximity,
  };
}

/**
 * Whether the whole mix targets near-silence: calm ≥ 0.8 with every
 * sounding lane routine (active or quiet) and every struggle below 0.3.
 * Idle lanes are silent seats, not voices, so they neither block nor
 * satisfy the rule: callers pad the frame to LANE_CAP with idle seats, and
 * a padded empty fourth seat must not take near-silence away from three
 * routine agents (p7b-t03). A frame with no sounding lane is not
 * near-silence; it is the empty room (isEmptyRoom), quieter still.
 */
function isNearSilence(lanes: readonly LaneRender[], calm: number): boolean {
  if (calm < NEAR_SILENCE_CALM_MIN) return false;
  const sounding = lanes.filter((lane) => lane.lifecycle !== "idle");
  return (
    sounding.length > 0 &&
    sounding.every(
      (lane) =>
        (lane.lifecycle === "active" || lane.lifecycle === "quiet") &&
        lane.struggle < NEAR_SILENCE_STRUGGLE_MAX,
    )
  );
}

/**
 * Whether nobody is working: every lane is an idle seat (or there are no
 * lanes). The scene then drops to the empty-room floor (owner direction
 * 2026-10-29) — drone, chord, swell and rain all but gone.
 */
export function isEmptyRoom(lanes: readonly Pick<LaneRender, "lifecycle">[]): boolean {
  return lanes.every((lane) => lane.lifecycle === "idle");
}

/** Sum of the three texture (non-tension) layer gains on one voice. */
function textureSum(voice: SceneParams["lanes"][number]): number {
  return voice.layers.air + voice.layers.grain + voice.layers.pulse;
}

/**
 * Soft-normalizes texture gains so their sum stays within the loudness
 * budget. Below the knee the mix is untouched; above it a cut grows
 * smoothly (`excess² / (excess + budget − knee)`) toward the full excess,
 * so the total approaches the budget from below without ever stepping.
 * Background (lower-prominence) lanes yield first: the cut is taken from
 * the least prominent lane's textures before touching nearer ones, so the
 * lane the user is closest to keeps its share longest.
 */
function applyLoudnessBudget(
  voices: readonly SceneParams["lanes"][number][],
  prominences: readonly number[],
): SceneParams["lanes"][number][] {
  const total = voices.reduce((sum, voice) => sum + textureSum(voice), 0);
  if (total <= LOUDNESS_KNEE_LINEAR) return [...voices];
  const excess = total - LOUDNESS_KNEE_LINEAR;
  const cut = (excess * excess) / (excess + (LOUDNESS_BUDGET_LINEAR - LOUDNESS_KNEE_LINEAR));
  let remainingCut = cut;
  // Per-lane texture scale, starting at 1; background lanes absorb the cut.
  const scales = voices.map(() => 1);
  const order = voices
    .map((_, index) => index)
    .sort((a, b) => (prominences[a] ?? 0) - (prominences[b] ?? 0));
  for (const index of order) {
    if (remainingCut <= 0) break;
    const voice = voices[index];
    if (voice === undefined) continue;
    const laneSum = textureSum(voice);
    if (laneSum <= 0) continue;
    const take = Math.min(laneSum, remainingCut);
    scales[index] = (laneSum - take) / laneSum;
    remainingCut -= take;
  }
  return voices.map((voice, index) => {
    const scale = scales[index] ?? 1;
    if (scale === 1) return voice;
    return {
      ...voice,
      layers: {
        ...voice.layers,
        air: voice.layers.air * scale,
        grain: voice.layers.grain * scale,
        pulse: voice.layers.pulse * scale,
      },
      air: { ...voice.air, gain: voice.air.gain * scale },
      grain: { ...voice.grain, gain: voice.grain.gain * scale },
      pulse: { ...voice.pulse, gain: voice.pulse.gain * scale },
    };
  });
}

/**
 * The scene clock and seed `render` reads when no explicit macro input
 * is supplied: engine second 0 under the QA seed, so every existing
 * caller (tests, QA, sandbox) keeps its exact pre-macro numbers until
 * it opts into the world. Live callers pass their own clock/seed via
 * renderWithMacro.
 */
export const DEFAULT_MACRO_SEED = 161;
export const DEFAULT_MACRO_NOW_SECONDS = 0;

/** Meso inputs that modulate the macro world without re-triggering it. */
export type MacroModulation = {
  /**
   * Engine-clock seconds the scene sounds at: the macro checkpoint is
   * read at this clock only. Agent activity never moves the clock, so
   * meso can scale the world but never re-trigger or re-synchronize it.
   */
  readonly nowSeconds: number;
  /** Seed for the macro stream (QA seed in tests/renders, live seed live). */
  readonly seed: number;
  /**
   * Mean agent presence 0..1 (average lane presence): scales how much
   * of the world sounds (voicing emphasis), never which checkpoint.
   */
  readonly presence: number;
  /** Calm 0..1: scales macro density/activity per ADR 0018. */
  readonly calm: number;
};

/**
 * Applies meso modulation to a macro checkpoint: presence and Calm
 * scale the world's density/brightness/bloom and the harmonic field's
 * level, never its timing or contents. The checkpoint stays the same
 * object it was — modulation is a separate scaled view, so an agent
 * burst cannot pull a new epoch forward or push one back.
 *
 * Audio-driving fields: pulseHz rate and both cutoffs come from the
 * checkpoint alone. Meso scales only levels and shares: swell gain,
 * density share, brightness offset, bed bloom, field level. Rate and
 * cutoffs never move with agent traffic, and the chord itself
 * (`fieldAt`) is read from the clock alone in renderWithMacro.
 */
export function modulateMacro(
  macro: MacroState,
  modulation: Pick<MacroModulation, "presence" | "calm"> & { readonly nearSilence?: boolean },
): {
  readonly densityScale: number;
  readonly brightnessDb: number;
  readonly bedBloomDb: number;
  readonly textureSwell: number;
  readonly atSeconds: number;
  readonly pulseHz: number;
  readonly swellCutoffHz: number;
  readonly fieldCutoffHz: number;
  readonly fieldGain: number;
} {
  const presence = Math.min(1, Math.max(0, modulation.presence));
  const calm = Math.min(1, Math.max(0, modulation.calm));
  return {
    atSeconds: macro.atSeconds,
    pulseHz: macroPulseHz(macro),
    swellCutoffHz: macroSwellCutoffHz(macro),
    fieldCutoffHz: macroFieldCutoffHz(macro),
    textureSwell: macro.textureSwell * (0.35 + 0.65 * presence),
    densityScale: macro.densityShare * (1 - CALM_DENSITY_SLOPE * calm) * (0.5 + 0.5 * presence),
    brightnessDb: macro.brightnessDb * (0.4 + 0.6 * presence),
    bedBloomDb: macro.bedBloomDb * (1 - 0.5 * calm),
    fieldGain: fieldGainScale(presence, calm, modulation.nearSilence ?? false),
  };
}

/**
 * How much of the harmonic field sounds (ADR 0025): Calm thins it on the
 * density slope, presence fills it from a high floor (a solo agent keeps
 * most of the chord), and near-silence drops it 20 dB under the texture
 * ceiling. Never which chord — only how much of it.
 */
export function fieldGainScale(presence: number, calm: number, nearSilence: boolean): number {
  const scale =
    (1 - FIELD_CALM_SLOPE * calm) * (FIELD_PRESENCE_FLOOR + (1 - FIELD_PRESENCE_FLOOR) * presence);
  return Math.min(1, Math.max(0, nearSilence ? scale * FIELD_NEAR_SILENCE_SCALE : scale));
}

/**
 * How many field voices may sound at a presence (owner direction
 * 2026-10-29: harmony that matches the agents' activity): three while the
 * agents are quiet, up to five when several are busy. The planned chord is never changed, only how
 * much of it sounds; the extension and shimmer voices are the ones busy
 * work brings in.
 */
export function fieldVoiceCap(presence: number): number {
  const clamped = Math.min(1, Math.max(0, presence));
  return FIELD_VOICES_QUIET + Math.round((FIELD_VOICES_MAX - FIELD_VOICES_QUIET) * clamped);
}

/**
 * Silences the sounding voices beyond the presence cap, latest in the
 * activation order first. A silenced voice keeps its pitch, so the slot
 * fades out on its 12 s ramp and fades back on the same note.
 */
function voicesForPresence(
  voices: readonly FieldVoice[],
  presence: number,
): SceneParams["macro"]["fieldVoices"] {
  const cap = fieldVoiceCap(presence);
  const kept = new Set(
    FIELD_ACTIVATION_ORDER.filter((slot) => voices[slot]?.midi != null).slice(0, cap),
  );
  return voices.map((voice, slot) => ({
    midi: voice.midi,
    level: kept.has(slot) ? voice.level : 0,
  }));
}

/**
 * Breathing-LFO rate for a checkpoint: the density share as an audible
 * slow pulse, 0.05–0.45 Hz (a 2–20 s swell — never a rhythmic trigger
 * a lane could be mistaken for). The wider span lets consecutive epochs
 * differ in rate as well as pitch.
 */
export function macroPulseHz(macro: MacroState): number {
  return 0.05 + macro.densityShare * 0.4;
}

/** Swell air-band centre for a checkpoint: brightness as cutoff, 800–3000 Hz band. */
export function macroSwellCutoffHz(macro: MacroState): number {
  return 1900 * 2 ** (macro.brightnessDb / 6);
}

/**
 * Harmonic-field low-pass for a checkpoint: brightness as timbre, about
 * 1100–1700 Hz — dark enough that the field stays behind the lanes and the
 * top slot reads as shimmer, open enough that a C4–D6 chord is a chord.
 */
export function macroFieldCutoffHz(macro: MacroState): number {
  return 1400 * 2 ** (macro.brightnessDb / 6);
}

/**
 * Live macro presence 0..1 for a frame (p7b-t03): the summed lane activity
 * over MACRO_PRESENCE_SEATS, clamped to 1. Idle seats carry activity 0, so
 * a frame padded to LANE_CAP yields the same presence as the unpadded
 * three-seat frame.
 */
export function macroPresence(laneRenders: readonly Pick<LaneRender, "activity">[]): number {
  const total = laneRenders.reduce((sum, lane) => sum + Math.min(1, Math.max(0, lane.activity)), 0);
  return Math.min(1, total / MACRO_PRESENCE_SEATS);
}

/**
 * Renders lanes plus the macro world. `modulation` carries the only
 * clock and seed the world reads; when omitted the scene sounds the
 * default checkpoint (engine second 0 under the QA seed) scaled to
 * identity, so existing callers keep byte-identical numbers until they
 * opt into the world: presence override 1 reproduces densityScale
 * exactly, the bed bloom at the default checkpoint is added only when
 * the caller passes an explicit clock, and brightness offsets stay in
 * the macro field (audio reads them from `macro`, never from lanes).
 */
export function renderWithMacro(
  laneRenders: readonly LaneRender[],
  calm: number,
  modulation?: MacroModulation & { readonly applyWorld?: boolean },
  fadeProgress?: readonly number[],
): SceneParams {
  const clampedCalm = Math.min(1, Math.max(0, calm));
  const factors = calmFactors(clampedCalm);
  const nearSilence = isNearSilence(laneRenders, clampedCalm);
  const voices = laneRenders.map((lane, index) => {
    const progress = Math.min(1, Math.max(0, fadeProgress?.[index] ?? 0));
    return renderLane(clampLane(lane), factors, progress, nearSilence);
  });
  const prominences = laneRenders.map((lane) => Math.min(1, Math.max(0, lane.prominence)));
  const lanes = applyLoudnessBudget(voices, prominences);
  const nowSeconds = modulation?.nowSeconds ?? DEFAULT_MACRO_NOW_SECONDS;
  const seed = modulation?.seed ?? DEFAULT_MACRO_SEED;
  const macro = macroAt(nowSeconds, createRng(seed));
  // The chord reads the clock and seed only: the same call the checkpoint
  // makes, so agent traffic has no way into what sounds, only into how
  // much of it sounds (fieldGain).
  const field = fieldAt(nowSeconds, createRng(seed));
  const applyWorld = modulation?.applyWorld ?? false;
  const presence =
    modulation?.presence ??
    (voices.length === 0
      ? 0
      : voices.reduce((sum, voice) => sum + voice.presence, 0) / voices.length);
  const modulated = modulateMacro(macro, { presence, calm: clampedCalm, nearSilence });
  const empty = isEmptyRoom(laneRenders);
  const bedGain = empty
    ? EMPTY_ROOM_BED_DBFS
    : nearSilence
      ? BED_GAIN_NEAR_SILENCE_DBFS
      : BED_GAIN_NORMAL_DBFS;
  const densityScale = applyWorld
    ? Math.min(1, Math.max(0, factors.densityScale * (0.5 + 0.5 * modulated.densityScale)))
    : factors.densityScale;
  return {
    masterGainDb: factors.masterGainDb,
    densityScale: empty ? densityScale * EMPTY_ROOM_DENSITY_SCALE : densityScale,
    bed: {
      gainDbfs: applyWorld && !empty ? bedGain + modulated.bedBloomDb : bedGain,
    },
    macro: {
      textureSwell: empty ? 0 : modulated.textureSwell,
      pulseHz: modulated.pulseHz,
      swellCutoffHz: modulated.swellCutoffHz,
      fieldCutoffHz: modulated.fieldCutoffHz,
      energy: field.energy,
      root: field.root,
      world: field.minor ? "dorian" : "lydian",
      tonic: field.tonic,
      bass: field.bass,
      chord: field.chord,
      // Lanes sing the chord's root and guide tones (owner listen
      // 2026-10-29: clear, not messy): a lane on a ninth or eleventh
      // against the field's own colours is where the clutter came from.
      palette: [...new Set(fieldChordTones(field.chord, field.tonic).slice(0, 4))].sort(
        (a, b) => a - b,
      ),
      fieldGain: empty ? modulated.fieldGain * EMPTY_ROOM_FIELD_SCALE : modulated.fieldGain,
      fieldVoices: voicesForPresence(field.voices, presence),
      pings: field.pings.map((ping) => ({
        id: ping.id,
        inS: ping.inS,
        midi: ping.midi,
        level: ping.level,
      })),
    },
    lanes,
  };
}

/**
 * Maps lane renders plus Calm to the sound parameters `packages/audio`
 * renders. Pure and agent-blind: the same inputs always produce the same
 * outputs. `fadeProgress` maps each lane's 0..1 progress through the 4 s
 * turn_complete release; lanes in any other lifecycle ignore it.
 *
 * Clamp contract: `calm` is clamped to [0, 1] and every signal field is
 * clamped to its documented range, so out-of-range sandbox sliders degrade
 * to the nearest edge instead of producing NaN or inverted gains.
 *
 * Macro contract: the world sounds at its default checkpoint (engine
 * second 0 under the QA seed). Callers that want the evolving world
 * pass clock+seed through renderWithMacro; this entry keeps every
 * pre-macro caller byte-identical.
 */
export function render(
  laneRenders: readonly LaneRender[],
  calm: number,
  fadeProgress?: readonly number[],
): SceneParams {
  return renderWithMacro(laneRenders, calm, undefined, fadeProgress);
}

/** Clamps every numeric signal to its documented range. */
function clampLane(lane: LaneRender): LaneRender {
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  return {
    ...lane,
    mode: {
      exploring: clamp01(lane.mode.exploring),
      editing: clamp01(lane.mode.editing),
      testing: clamp01(lane.mode.testing),
      other: clamp01(lane.mode.other),
    },
    activity: clamp01(lane.activity),
    progress: clamp01(lane.progress),
    struggle: clamp01(lane.struggle),
    prominence: clamp01(lane.prominence),
  };
}
