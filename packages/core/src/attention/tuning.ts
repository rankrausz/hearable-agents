// packages/core/src/attention/tuning.ts — every numeric constant the
// attention model uses, in one place. Values are transcribed verbatim from
// docs/STATE_ENGINE.md §Attention model (§Prominence, §Foreground,
// §Gestures); any change must be justified against the annotated fixtures
// with before/after numbers, never by feel. The struggle 0.6/0.4 hysteresis
// thresholds live in engine/tuning.ts and are imported by attention.ts so
// the gesture table can never drift from the signal that arms it. This
// module must not import anything: constants only, so the values stay
// trivially portable between daemon and browser.

/** Prominence base while a lane waits: never scaled by Calm. */
export const ATTENTION_BASE_WAITING = 0.9;

/** Prominence base while a lane is stale. */
export const ATTENTION_BASE_STALE = 0.55;

/** Prominence base while a lane is active: scaled by Calm (routine). */
export const ATTENTION_BASE_ACTIVE = 0.25;

/** Prominence base while a lane is quiet: scaled by Calm (routine). */
export const ATTENTION_BASE_QUIET = 0.15;

/** Prominence peak when a lane enters turn_complete, fading to 0. */
export const ATTENTION_BASE_TURN_COMPLETE_PEAK = 0.5;

/** Prominence base while a lane is idle (silent). */
export const ATTENTION_BASE_IDLE = 0;

/** Seconds a turn_complete lane takes to fade from peak to silence. */
export const ATTENTION_TURN_COMPLETE_DECAY_MS = 6_000;

/** Struggle weight in prominence: `0.6 × struggle × (1 − 0.5 × calm)`. */
export const ATTENTION_STRUGGLE_WEIGHT = 0.6;

/** Calm slope of struggle sensitivity: struggle scales by `(1 − 0.5 × calm)`. */
export const ATTENTION_STRUGGLE_CALM_SLOPE = 0.5;

/** Calm slope of routine presence: active/quiet bases scale by `(1 − 0.6 × calm)`. */
export const ATTENTION_ROUTINE_CALM_SLOPE = 0.6;

/** Fresh-transition prominence bump: `0.30 × exp(−Δt / 8 s)`. */
export const ATTENTION_TRANSITION_BUMP = 0.3;

/** Time constant of the transition bump decay (8 s). */
export const ATTENTION_TRANSITION_TAU_MS = 8_000;

/** Minimum prominence for foreground candidacy. */
export const ATTENTION_FOREGROUND_THRESHOLD = 0.5;

/** How long a lane holds foreground once acquired (15 s). */
export const ATTENTION_FOREGROUND_HOLD_MS = 15_000;

/** Per-lane gesture refractory: at most one non-question gesture per 3 s. */
export const ATTENTION_REFRACTORY_MS = 3_000;

/** Prominence equality band for the most-recent-transition tiebreak. */
export const ATTENTION_TIE_EPSILON = 1e-9;
