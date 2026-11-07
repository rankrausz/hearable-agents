// packages/core/src/attention/index.ts — the barrel later attention tasks
// extend. What this is for: the single import surface for the attention
// model (input and memory shapes, the pure transition, tuning constants).
// What it must not do: re-export anything impure or reach outside this
// directory — daemon wiring (p4-t02) and browser wiring (p4-t03) consume
// this surface but never add engine signals here.

export type { AttentionLaneRender } from "./attention.js";
export {
  attentionProminenceFor,
  attentionSelectForeground,
  attentionTurnCompleteBase,
  computeAttention,
} from "./attention.js";
export type {
  AttentionInput,
  AttentionLaneMemory,
  AttentionState,
  GestureName,
} from "./state.js";
export { initialAttentionState } from "./state.js";
export {
  ATTENTION_BASE_ACTIVE,
  ATTENTION_BASE_IDLE,
  ATTENTION_BASE_QUIET,
  ATTENTION_BASE_STALE,
  ATTENTION_BASE_TURN_COMPLETE_PEAK,
  ATTENTION_BASE_WAITING,
  ATTENTION_FOREGROUND_HOLD_MS,
  ATTENTION_FOREGROUND_THRESHOLD,
  ATTENTION_REFRACTORY_MS,
  ATTENTION_ROUTINE_CALM_SLOPE,
  ATTENTION_STRUGGLE_CALM_SLOPE,
  ATTENTION_STRUGGLE_WEIGHT,
  ATTENTION_TIE_EPSILON,
  ATTENTION_TRANSITION_BUMP,
  ATTENTION_TRANSITION_TAU_MS,
  ATTENTION_TURN_COMPLETE_DECAY_MS,
} from "./tuning.js";
