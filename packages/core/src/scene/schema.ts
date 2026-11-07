// packages/core/src/scene/schema.ts — the zod-guarded scene-mapping
// boundary. What this is for: the `LaneRender` input contract the sandbox
// and QA drive synthetically (`docs/STATE_ENGINE.md` §Outputs signal subset
// plus the attention fields Phase 4 will compute, see the module header of
// render.ts) and the `SceneParams` output `packages/audio` renders without
// ever seeing events. Types are inferred from the schemas, never duplicated.
// What it must not do: compute anything, touch time or randomness, or branch
// on an agent's name — there is no agent field here at all by design.

import { z } from "zod";

import type { DisplayedMode, Lifecycle, WaitingReason } from "../engine/state.js";

const LifecycleSchema = z.enum([
  "idle",
  "active",
  "quiet",
  "stale",
  "waiting",
  "turn_complete",
]) satisfies z.ZodType<Lifecycle>;

const WaitingReasonSchema = z.enum([
  "question",
  "permission",
  "idle_prompt",
]) satisfies z.ZodType<WaitingReason>;

const ModeWeightsSchema = z.strictObject({
  exploring: z.number().min(0).max(1),
  editing: z.number().min(0).max(1),
  testing: z.number().min(0).max(1),
  other: z.number().min(0).max(1),
});

const DisplayedModeSchema = z.enum([
  "exploring",
  "editing",
  "testing",
  "other",
]) satisfies z.ZodType<DisplayedMode>;

const GestureNameSchema = z.enum(["arrive", "question", "resolve", "attention"]);

/**
 * The smoothed per-lane signals the harmonic planner (p5-t02, ADR 0022)
 * reads: the engine signal subset the planner is allowed to see. Lifecycle
 * gates routine eligibility (only active/quiet lanes may move); smoothed
 * mode weights and activity feed the sustained-change rule; progress feeds
 * the fresh-evidence rule. No agent field by design — core never branches
 * on an agent's name, it reads capabilities upstream and signals here.
 * Struggle is deliberately absent: struggle favors repeated/constrained
 * articulation, never a harmonic move (ADR 0021).
 */
export const LaneSignalSchema = z.strictObject({
  laneIndex: z.number().int().min(0),
  lifecycle: LifecycleSchema,
  mode: ModeWeightsSchema,
  activity: z.number().min(0).max(1),
  progress: z.number().min(0).max(1),
});
export type LaneSignal = z.infer<typeof LaneSignalSchema>;

/**
 * One planned lane-note movement: which lane moves, at which engine-clock
 * time, and from/to which pitches. Plain data the audio package voices;
 * every pitch is a D-pentatonic member inside the lane's register.
 */
export const HarmonicMoveSchema = z.strictObject({
  laneIndex: z.number().int().min(0),
  atS: z.number().min(0),
  pitch: z.number().int().min(0).max(127),
  fromPitch: z.number().int().min(0).max(127),
});
export type HarmonicMove = z.infer<typeof HarmonicMoveSchema>;

/**
 * A pending gesture trigger for one lane: plain data the sandbox and QA set
 * synthetically; Phase 4's attention layer will derive these from live
 * transitions with the 3 s refractory from `docs/STATE_ENGINE.md` §Gestures.
 */
export const LaneGestureSchema = z.strictObject({
  gesture: GestureNameSchema,
  /** Engine-clock time the trigger was requested. */
  at: z.number(),
});
export type LaneGesture = z.infer<typeof LaneGestureSchema>;

/**
 * The scene-mapping input contract: the engine signal subset (lifecycle,
 * mode weights, activity, progress, struggle) plus the attention fields
 * (`prominence`, `foreground`, gesture triggers) that this phase drives
 * synthetically and the Phase 4 attention model computes from live signals
 * (see the module header of render.ts for the split).
 */
export const LaneRenderSchema = z.strictObject({
  laneId: z.number().int().min(0),
  lifecycle: LifecycleSchema,
  waitingReason: WaitingReasonSchema.optional(),
  mode: ModeWeightsSchema,
  displayedMode: DisplayedModeSchema,
  activity: z.number().min(0).max(1),
  progress: z.number().min(0).max(1),
  struggle: z.number().min(0).max(1),
  prominence: z.number().min(0).max(1),
  foreground: z.boolean(),
  gestures: z.array(LaneGestureSchema).readonly(),
});
export type LaneRender = z.infer<typeof LaneRenderSchema>;

const LayerGainsSchema = z.strictObject({
  air: z.number().min(0),
  grain: z.number().min(0),
  pulse: z.number().min(0),
  tension: z.number().min(0),
});

const AirParamsSchema = z.strictObject({
  /** Linear gain, post loudness budget. */
  gain: z.number().min(0),
  /** Cutoff multiplier relative to the scene's base band. */
  cutoff: z.number().min(0),
  /** Drift-range share: 1 is wide/free, shrinking as struggle rises. */
  cutoffRange: z.number().min(0).max(1),
});

const GrainParamsSchema = z.strictObject({
  gain: z.number().min(0),
  /** Relative texture density after the Calm density scale. */
  density: z.number().min(0),
  /**
   * Re-articulation depth 0..1: how far the slow stuck gate closes the
   * grain path (ADR 0019 — phrases repeat and restart instead of detuning).
   * 0 is a free phrase, 1 is the full chop.
   */
  stuckDepth: z.number().min(0).max(1),
  /**
   * Re-articulation rate in Hz: the stuck gate's chop rate — the full set
   * circles slowly, the narrowed two-note set twice as fast (pattern
   * contracts instead of detuning).
   */
  stuckRateHz: z.number().min(0.01).max(4),
  /** Pulse swell period in seconds: free and slow, stuck and contracted. */
  pulsePeriodS: z.number().min(0.5).max(8),
  /** Full pentatonic set or the stuck two-note alternation. */
  noteSet: z.enum(["full", "narrow"]),
  /** Whether grain picks from the upper half of the lane register. */
  upperRegister: z.boolean(),
});

const PulseParamsSchema = z.strictObject({
  gain: z.number().min(0),
  /** Pulse swell period in seconds: free and slow, stuck and contracted. */
  pulsePeriodS: z.number().min(0.5).max(8),
});

const TensionParamsSchema = z.strictObject({
  /** Whether the tension layer sounds at all. */
  on: z.boolean(),
  gain: z.number().min(0),
});

const ProximityParamsSchema = z.strictObject({
  /** Shared-reverb send: far lanes are wet, near lanes are dry. */
  reverbSend: z.number().min(0).max(1),
  /** Lane-bus high-shelf gain at 2.5 kHz, in dB. */
  brightnessDb: z.number(),
  /** Stereo width of the lane region. */
  width: z.number().min(0),
  /** Small level nudge for the foreground lane only, in dB. */
  gainNudgeDb: z.number().min(0),
  /**
   * Waiting duck in dB: how far the lane's own routine air/grain/pulse path
   * yields while waiting (the tension pad owns the band instead, so the
   * question's first flux edge reads against a quiet floor).
   */
  calmDuckDb: z.number().min(0).max(12),
});

const LaneVoiceSchema = z.strictObject({
  laneId: z.number().int().min(0),
  /** Pre-budget lane presence (activity curve × routine × lifecycle). */
  presence: z.number().min(0),
  layers: LayerGainsSchema,
  air: AirParamsSchema,
  grain: GrainParamsSchema,
  pulse: PulseParamsSchema,
  tension: TensionParamsSchema,
  proximity: ProximityParamsSchema,
});

const BedParamsSchema = z.strictObject({
  /** Drone level in dBFS. */
  gainDbfs: z.number(),
});

/**
 * One harmonic-field voice slot (ADR 0025): its pitch, or null while the
 * slot is silent, and its target level. Audio hands a slot's pitch change
 * over between two voice banks and ramps its level; it never bends pitch.
 */
const FieldVoiceSchema = z.strictObject({
  midi: z.number().int().min(0).max(127).nullable(),
  level: z.number().min(0).max(1),
});

const MacroFieldSchema = z.strictObject({
  /** Texture-swell level 0..1 (the one evolving environmental texture). */
  textureSwell: z.number().min(0).max(1),
  /**
   * Pulse-repetition rate in Hz for the checkpoint's breathing LFO
   * (slow, 0.05–0.45 Hz): densityShare as an audible rate, not a silent
   * number.
   */
  pulseHz: z.number().min(0.01).max(1),
  /** Swell air-band centre in Hz (brightness as an audible cutoff). */
  swellCutoffHz: z.number().min(100).max(8000),
  /** Harmonic-field low-pass cutoff in Hz (brightness as timbre). */
  fieldCutoffHz: z.number().min(100).max(4000),
  /** Harmonic-field energy level 1..5 of the current epoch (reported). */
  energy: z.number().int().min(1).max(5),
  /** Harmonic-field root region of the current epoch, semitones above D (reported). */
  root: z.number().int().min(0).max(11),
  /** Whether the current chord's third is major ("lydian") or minor ("dorian"); gestures read it. */
  world: z.enum(["lydian", "dorian"]),
  /**
   * Tonal centre of the current epoch, semitones above D (owner direction
   * 2026-10-29): the field, the drone and the gestures are all heard from
   * it. `root` and `palette` are absolute (above D), not relative to it.
   */
  tonic: z.number().int().min(0).max(11),
  /**
   * Bass of the current chord, semitones above D (ADR 0027 amendment): the
   * drone follows it, so the floor walks with inversions and holds under
   * pedal chords.
   */
  bass: z.number().int().min(0).max(11),
  /** Name of the chord the field is moving to, relative to the centre (reported). */
  chord: z.string(),
  /**
   * The chord as pitch classes above D: every sounding field voice plus
   * the root. Lanes pick their notes from this set (ADR 0025 amendment);
   * gestures read the world's third from it.
   */
  palette: z.array(z.number().int().min(0).max(11)).readonly(),
  /**
   * Bloom notes starting within the field's lookahead window (ADR 0025):
   * monotonic id, seconds from this render's clock, pitch and level. Audio
   * schedules each id once; the same bloom may be announced by several
   * consecutive renders.
   */
  pings: z
    .array(
      z.strictObject({
        id: z.number().int().min(0),
        inS: z.number().min(0),
        midi: z.number().int().min(0).max(127),
        level: z.number().min(0).max(1),
      }),
    )
    .readonly(),
  /**
   * Harmonic-field level scale 0..1 from Calm, presence and near-silence:
   * meso scales how much of the chord sounds, never which chord.
   */
  fieldGain: z.number().min(0).max(1),
  /** The chord: one entry per field slot, index-aligned with FIELD_SLOTS. */
  fieldVoices: z.array(FieldVoiceSchema).readonly(),
});
export type FieldVoiceParams = z.infer<typeof FieldVoiceSchema>;

export const SceneParamsSchema = z.strictObject({
  /** Master gain offset from the default level, in dB. */
  masterGainDb: z.number(),
  /** Relative texture density scale from Calm and the macro epoch. */
  densityScale: z.number().min(0).max(1),
  bed: BedParamsSchema,
  /**
   * The macro checkpoint the scene sounds under (p3-t12): pure
   * clock+RNG content that meso scales but never re-triggers. The
   * audio package renders it as the evolving world bed; QA proves
   * its timing against nextBoundaryAfter.
   */
  macro: MacroFieldSchema,
  lanes: z.array(LaneVoiceSchema).readonly(),
});
export type SceneParams = z.infer<typeof SceneParamsSchema>;
