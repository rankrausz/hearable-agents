// packages/audio/src/ensemble/index.ts — the p5-t01 ensemble A/B barrel.
// What this is for: the single import surface the sandbox A/B slice and
// the unit tests consume — the curated palette, the shared timeline, the
// independent/hybrid schedulers and the offline voicing. What it must not
// do: sound anything or touch the production render path — the two slice
// versions stay an explicit comparison surface; the hybrid direction is the
// adopted production default (p5-t06 verdict A).

export type { HarmonicVoicePlan, HarmonicVoicing } from "./harmonic.js";
export {
  HARMONIC_VOICE_MAX_STEP,
  harmonicMoveIsVoiceable,
  harmonicSliceSignals,
  harmonicVoiceIsInWindow,
  harmonicVoicePlan,
} from "./harmonic.js";
export type { HardCueLifecycle } from "./lifecycle.js";
export {
  compatiblePartForLane,
  isHardCueLifecycle,
  isRoutineLifecycle,
  lanesTouchedByLeave,
  routeEnsembleFrame,
} from "./lifecycle.js";
export {
  ENSEMBLE_LIVE_TICK_S,
  ENSEMBLE_OPT_IN_DEFAULT,
  ensembleNeedsRestart,
  ensemblePruneDeparted,
  ensembleShouldTick,
} from "./live.js";
export {
  candidatesForLane,
  isInKey,
  isInRegister,
  pitchClassRelativeToD,
  ROUTINE_SUSTAIN_GAIN,
  registerForEnsembleLane,
  startIndexForLane,
  startPitchForLane,
  stepPitch,
  sustainedVoiceEventsForPitch,
  voiceFreqsForMove,
} from "./palette.js";
export type { EnsemblePlaybackPlan } from "./playback.js";
export { ensemblePlaybackPlan, playEnsemblePlan, qaScenarioForVersion } from "./playback.js";
export type { EnsembleLaneReading } from "./schedule.js";
export {
  ENSEMBLE_COOLDOWN_S,
  ENSEMBLE_ELIGIBILITY_WINDOW_S,
  ENSEMBLE_MIN_HOLD_S,
  ENSEMBLE_PROGRESS_EVIDENCE_MOVES,
  ENSEMBLE_SEED,
  ENSEMBLE_SLICE_S,
  ENSEMBLE_SUSTAINED_DELTA,
  type EnsembleMode,
  type EnsembleMove,
  type EnsembleVersion,
  hybridEligibility,
  hybridSchedule,
  independentMoves,
} from "./schedule.js";
export type { AbTimelineStep } from "./timeline.js";
export { AB_CALM, AB_SEED, AB_SLICE_S, abFadeProgress, abTimeline, lanesAt } from "./timeline.js";
export { AB_CUE_LANE, AB_RESOLVE_AT_S, AB_WAITING_AT_S, abCueEvents } from "./voice.js";
