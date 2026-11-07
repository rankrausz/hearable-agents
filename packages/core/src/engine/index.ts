// packages/core/src/engine/index.ts — the barrel later engine tasks extend.
// What this is for: the single import surface for the lane state engine
// (state shape, constructor, applyEvent, advance, mode helpers, capability
// predicates and fidelity summary, tuning constants). What it must not do:
// re-export anything impure or reach outside this directory — later tasks
// (attention in p2-t06+, daemon wiring in p2-t07) add their modules here
// without touching src/index.ts.

export type { FidelitySummary } from "./capabilities.js";
export {
  compactionVisible,
  editsVisible,
  failuresVisible,
  fidelitySummary,
  finalMessageAsks,
  permissionVisible,
  promptsVisible,
  questionVisible,
} from "./capabilities.js";
export { advance, applyEvent } from "./engine.js";
export { blendModeWeights, emaFactor, mapToolToMode, modeEvidence } from "./mode.js";
export type {
  CreateLaneArgs,
  DisplayedMode,
  LaneState,
  Lifecycle,
  LifecycleConfidence,
  ModeWeights,
  Reason,
  ReasonSignal,
  StruggleAction,
  WaitingReason,
  WorkingMemory,
} from "./state.js";
export { createLane, withReason } from "./state.js";
export {
  advanceStruggleProgress,
  applyStruggleProgressEvent,
  decayProgressValue,
  decayStruggleValue,
} from "./struggle.js";
export {
  ACTIVITY_SCALE_SECONDS,
  ACTIVITY_TAU_MS,
  INFERRED_TURN_COMPLETE_AFTER_MS,
  MAX_REASONS,
  MODE_SUBAGENT_WEIGHT,
  MODE_SWITCH_HOLD_MS,
  MODE_SWITCH_MARGIN,
  MODE_TAU_MS,
  MODE_UNCERTAIN_OTHER_WEIGHT,
  PROGRESS_FIRST_GREEN_WEIGHT,
  PROGRESS_NEW_COMMAND_WEIGHT,
  PROGRESS_NEW_FILE_WEIGHT,
  PROGRESS_STRUGGLE_RELIEF,
  PROGRESS_TAU_MS,
  PROGRESS_TEST_SUMMARY_WEIGHT,
  PROGRESS_TURN_COMPLETE_STRUGGLE_CAP,
  PROGRESS_TURN_COMPLETE_WEIGHT,
  QUIET_AFTER_MS,
  STALE_AFTER_MS,
  STRUGGLE_ATTENTION_THRESHOLD,
  STRUGGLE_EDIT_CHURN_WEIGHT,
  STRUGGLE_EDIT_CHURN_WINDOW_MS,
  STRUGGLE_EDIT_HEAVY_WEIGHT,
  STRUGGLE_FAIL_CYCLE_WEIGHT,
  STRUGGLE_FAIL_CYCLE_WINDOW_MS,
  STRUGGLE_FOURTH_FAIL_WEIGHT,
  STRUGGLE_HALF_LIFE_MS,
  STRUGGLE_MEMORY_WINDOW_MS,
  STRUGGLE_NO_EDIT_REPEAT_WEIGHT,
  STRUGGLE_NO_EDIT_REPEAT_WINDOW_MS,
  STRUGGLE_READ_LOOP_WEIGHT,
  STRUGGLE_READ_LOOP_WINDOW_MS,
  STRUGGLE_REARM_THRESHOLD,
  STRUGGLE_REPEAT_FAIL_WEIGHT,
  STRUGGLE_REPEAT_FAIL_WINDOW_MS,
  TURN_COMPLETE_TO_IDLE_MS,
} from "./tuning.js";
