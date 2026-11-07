// packages/core/src/engine/tuning.ts — every numeric constant the engine
// foundation uses, in one place. Numbers are the starting values from
// docs/STATE_ENGINE.md §Lifecycle and §Activity; any change must be justified
// against the annotated fixtures with before/after numbers, never by feel.
// Later engine tasks add their own constants here; no magic numbers may live
// in engine.ts or state.ts. This module must not import anything: constants
// only, so the values stay trivially portable between daemon and browser.

/** Silence after the last event before an active lane goes quiet (90 s). */
export const QUIET_AFTER_MS = 90_000;

/** Silence after the last event before a quiet lane goes stale (8 min). */
export const STALE_AFTER_MS = 8 * 60_000;

/** Time a turn_complete lane rests before decaying back to idle (20 s). */
export const TURN_COMPLETE_TO_IDLE_MS = 20_000;

/**
 * Silence after activity before the engine infers a missing turn end
 * (120 s). The inference fires only on `turnEnd = "none"` lanes (p2-t04);
 * lanes whose source reports turn ends go quiet, then stale, instead.
 */
export const INFERRED_TURN_COMPLETE_AFTER_MS = 120_000;

/** Time constant of the normalized event-rate activity EMA (15 s). */
export const ACTIVITY_TAU_MS = 15_000;

/**
 * Activity scale in seconds: activity = clamp(ratePerSecond * scale).
 * One tool event per 4 s settles just above 1.0 and clamps there, so the
 * documented cadence reads as full activity.
 */
export const ACTIVITY_SCALE_SECONDS = 4;

/** Time constant of the per-category mode EMA (20 s, docs/STATE_ENGINE.md §Mode). */
export const MODE_TAU_MS = 20_000;

/**
 * Displayed-mode hysteresis margin: a challenger must exceed the current
 * mode weight by at least this much to become a switch candidate.
 */
export const MODE_SWITCH_MARGIN = 0.15;

/**
 * Displayed-mode hold: a challenger must lead by the margin for at least
 * this long, and switches happen at most once per this interval. The spec
 * names a single 5 s value for both the hold and the rate limit, so one
 * constant serves both checks.
 */
export const MODE_SWITCH_HOLD_MS = 5_000;

/**
 * Subagent tool events fold into the parent lane's mode at this fraction of
 * the normal blend factor (docs/STATE_ENGINE.md §Mode).
 */
export const MODE_SUBAGENT_WEIGHT = 0.5;

/**
 * A tool that lands in `other` without a typed kind is an uncertain guess,
 * so it blends at this fraction of the normal factor (docs/STATE_ENGINE.md
 * §Capability-aware inference: weight 0.5 for `other` under `byName`).
 */
export const MODE_UNCERTAIN_OTHER_WEIGHT = 0.5;

/** Recent explanations kept per lane, newest first. */
export const MAX_REASONS = 20;

/** Half-life of the struggle leaky integrator absent evidence (10 min). */
export const STRUGGLE_HALF_LIFE_MS = 600_000;

/** Struggle per repeat of the same exec failure after the first (10 min window). */
export const STRUGGLE_REPEAT_FAIL_WEIGHT = 0.15;

/** Detection window for exec-failure repeats (10 min). */
export const STRUGGLE_REPEAT_FAIL_WINDOW_MS = 600_000;

/** Extra struggle per repeat once the same exec failure reaches its 4th time. */
export const STRUGGLE_FOURTH_FAIL_WEIGHT = 0.25;

/** Struggle per edit beyond the 2nd of the same file (5 min window). */
export const STRUGGLE_EDIT_CHURN_WEIGHT = 0.1;

/** Detection window for same-file edit churn (5 min). */
export const STRUGGLE_EDIT_CHURN_WINDOW_MS = 300_000;

/** Extra struggle per edit beyond the 5th of the same file. */
export const STRUGGLE_EDIT_HEAVY_WEIGHT = 0.2;

/** Struggle for re-running an identical exec with no edit in between (3 min). */
export const STRUGGLE_NO_EDIT_REPEAT_WEIGHT = 0.1;

/** Detection window for the identical-exec repeat (3 min). */
export const STRUGGLE_NO_EDIT_REPEAT_WINDOW_MS = 180_000;

/** Struggle per completed edit → fail → edit → same-fail cycle (15 min). */
export const STRUGGLE_FAIL_CYCLE_WEIGHT = 0.2;

/** Detection window for the edit/fail cycle (15 min, the longest window). */
export const STRUGGLE_FAIL_CYCLE_WINDOW_MS = 900_000;

/** Struggle per read/search repeat beyond the 3rd of the same target (5 min). */
export const STRUGGLE_READ_LOOP_WEIGHT = 0.05;

/** Detection window for read/search loops (5 min). */
export const STRUGGLE_READ_LOOP_WINDOW_MS = 300_000;

/** Upward crossing that appends the attention reason. */
export const STRUGGLE_ATTENTION_THRESHOLD = 0.6;

/** Struggle must drop below this before the crossing can fire again. */
export const STRUGGLE_REARM_THRESHOLD = 0.4;

/** Time constant of the progress novelty-rate leaky integrator (3 min). */
export const PROGRESS_TAU_MS = 180_000;

/** Progress for the first edit of a file fingerprint this turn. */
export const PROGRESS_NEW_FILE_WEIGHT = 0.1;

/** Progress for the first run of a command fingerprint this turn. */
export const PROGRESS_NEW_COMMAND_WEIGHT = 0.05;

/** Progress for the first green test/build after a red of the same fingerprint. */
export const PROGRESS_FIRST_GREEN_WEIGHT = 0.3;

/** Progress when a test summary shows fewer failures than the previous run. */
export const PROGRESS_TEST_SUMMARY_WEIGHT = 0.2;

/** Progress for a completed turn. */
export const PROGRESS_TURN_COMPLETE_WEIGHT = 0.2;

/** Each unit of progress evidence subtracts this multiple of its weight. */
export const PROGRESS_STRUGGLE_RELIEF = 1.5;

/** turn.end(completed) caps struggle at this value. */
export const PROGRESS_TURN_COMPLETE_STRUGGLE_CAP = 0.2;

/** Histories older than the longest struggle window are dropped. */
export const STRUGGLE_MEMORY_WINDOW_MS = 900_000;
