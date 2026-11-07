// packages/audio/src/gestures/index.ts - the gesture module barrel.
// What this is for: the single import surface for the four Clearing gestures -
// the pure trigger evaluator, the GesturePlayer, the event-plan types, the
// offline renderer and its analysis helpers, and the named scenario inputs
// p3-t05 drives. What it must not do: import Tone or touch time - construction
// and scheduling stay in apply.ts, which imports this surface.

export { dominantFrequency, estimatePitch, peakDb, rmsDb } from "./analysis.js";
export {
  ATTENTION_MIN_SPACING_S,
  GesturePlayer,
  gestureEvents,
  QUESTION_ONSET_ATTACK_S,
  QUESTION_ONSET_EMPHASIS_DB,
} from "./player.js";
export type { GestureRenderOptions, GestureRenderResult } from "./render.js";
export { renderGesturePlan } from "./render.js";
export type { GestureScenario } from "./scenarios.js";

export { baseLaneRender, driveScenario, GESTURE_SCENARIOS, scenarioFor } from "./scenarios.js";
export { evaluateGestureTriggers, REFRACTORY_S } from "./triggers.js";

export {
  ATTENTION_CALM_CUT_DB,
  ATTENTION_KNOCK_LOWPASS_HZ,
  ATTENTION_NOISE_SHARE,
  ATTENTION_REL_DB,
  ATTENTION_SUB_DETUNE_CENTS,
  ATTENTION_SUB_MIDI,
  attentionDb,
  CUT_RELEASE_S,
  GESTURE_BUS_ATTACK_S,
  GESTURE_LENGTH_S,
  GESTURE_PRIORITY,
  GESTURE_TAIL_S,
  type GestureBreathEvent,
  type GestureBusMoveEvent,
  type GestureName,
  type GestureNoiseEvent,
  type GestureNoteEvent,
  type GestureSubEvent,
  type GestureSwellEvent,
  type GestureTrigger,
  type GestureVoiceEvent,
  gestureBusyS,
  NOTE_GAIN,
  QUESTION_BUS_ATTACK_S,
  RESOLVE_SWELL_DB,
} from "./types.js";
