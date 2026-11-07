// packages/core/src/engine/struggle.ts — graded struggle and progress signals.
// What this is for: docs/STATE_ENGINE.md §Struggle and §Progress — the Tier-1
// struggle leaky integrator (half-life 10 min, clamped [0,1]) with all seven
// evidence rows, the novelty-rate progress integrator (τ = 3 min), progress
// counter-evidence (1.5× relief, turn-complete cap at 0.2) and the 0.6/0.4
// attention hysteresis. What it must not do: I/O, time, randomness, workspace
// or node:* imports, or branching on an agent's name — identity comes only
// from tool fingerprints. Capability gating (p2-t04) reads the lane's
// `capabilities`: with `editEvents = false` the edit-churn and edit→fail
// cycle rows are disabled (never incremented, never relieved), and with
// `toolFailures = false` every failure-based row is disabled; each disabled
// event appends a reason naming what is not visible instead of staying
// silent, and the exact-zero invariant follows by construction.
//
// Narrowest readings chosen here (noted for p2-t09 calibration): edits,
// exec runs and read/search loops are counted on `tool.start` only so a
// start/end pair never double-counts; exec failures are counted on
// `tool.fail` — the repeat-failure rows read "same exec fingerprint", so a
// failing edit/read never contributes to them; the 4th+ fail and 6th+ edit rows are additive on top of the
// base repeat rows; the identical-exec row needs two exec `tool.start`s with
// the same fingerprint within 3 min and no edit after the first; the
// edit→fail→edit→same-fail cycle needs the last four edit/fail actions to
// match consecutively (interleaved reads are ignored, interleaved
// edit/fail breaks the pattern); test-summary relief fires on `tool.end`
// or `tool.fail` carrying a numeric `outcome.testSummary.failed`.

import type { AdapterCapabilities, NormalizedEvent } from "../events/schema.js";
import { editsVisible, failuresVisible } from "./capabilities.js";
import { type LaneState, type Reason, withReason } from "./state.js";
import {
  MAX_REASONS,
  PROGRESS_FIRST_GREEN_WEIGHT,
  PROGRESS_NEW_COMMAND_WEIGHT,
  PROGRESS_NEW_FILE_WEIGHT,
  PROGRESS_STRUGGLE_RELIEF,
  PROGRESS_TAU_MS,
  PROGRESS_TEST_SUMMARY_WEIGHT,
  PROGRESS_TURN_COMPLETE_STRUGGLE_CAP,
  PROGRESS_TURN_COMPLETE_WEIGHT,
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
} from "./tuning.js";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Struggle decay for `dtMs`: halves every STRUGGLE_HALF_LIFE_MS. */
export function decayStruggleValue(value: number, dtMs: number): number {
  if (dtMs <= 0) return value;
  return value * 0.5 ** (dtMs / STRUGGLE_HALF_LIFE_MS);
}

/** Progress decay for `dtMs`: exponential with τ = PROGRESS_TAU_MS. */
export function decayProgressValue(value: number, dtMs: number): number {
  if (dtMs <= 0) return value;
  return value * Math.exp(-dtMs / PROGRESS_TAU_MS);
}

function countWithin(history: readonly number[], at: number, windowMs: number): number {
  let count = 0;
  for (const ts of history) {
    if (ts <= at && at - ts <= windowMs) count += 1;
  }
  return count;
}

function pruneHistory(
  history: { readonly [fingerprint: string]: readonly number[] },
  at: number,
): { readonly [fingerprint: string]: readonly number[] } {
  const cutoff = at - STRUGGLE_MEMORY_WINDOW_MS;
  const next: { [fingerprint: string]: readonly number[] } = {};
  for (const key of Object.keys(history)) {
    const kept = (history[key] as readonly number[]).filter((ts) => ts >= cutoff);
    if (kept.length > 0) next[key] = kept;
  }
  return next;
}

function label(event: NormalizedEvent): string {
  const target = event.tool?.target;
  if (typeof target === "string" && target.length > 0) return `"${target}"`;
  return `"${event.tool?.name ?? event.kind}"`;
}

/** Identity of a `tool.fail` for the invariant-1 repeat check. */
function failKeyOf(event: NormalizedEvent): string {
  return JSON.stringify({
    fingerprint: event.tool?.fingerprint,
    name: event.tool?.name,
    category: event.tool?.category,
    execKind: event.tool?.execKind,
    outcome: event.tool?.outcome,
  });
}

export type StruggleProgressResult = Pick<
  LaneState,
  "struggle" | "progress" | "reasons" | "internal"
>;

/**
 * Decays struggle and progress to `now` with no events: both converge toward
 * 0, and the hysteresis re-arms when struggle drops below 0.4. Histories are
 * pruned to the longest window. Pure; the input is never mutated.
 */
export function advanceStruggleProgress(state: LaneState, now: number): StruggleProgressResult {
  const struggleDt = Math.max(0, now - state.internal.struggleUpdatedAt);
  const progressDt = Math.max(0, now - state.internal.progressUpdatedAt);
  const struggle = clamp01(decayStruggleValue(state.struggle, struggleDt));
  const progress = clamp01(decayProgressValue(state.progress, progressDt));
  const armed = state.internal.struggleArmed || struggle < STRUGGLE_REARM_THRESHOLD;
  return {
    struggle,
    progress,
    reasons: state.reasons,
    internal: {
      ...state.internal,
      struggleUpdatedAt: Math.max(state.internal.struggleUpdatedAt, now),
      progressUpdatedAt: Math.max(state.internal.progressUpdatedAt, now),
      struggleArmed: armed,
      failHistory: pruneHistory(state.internal.failHistory, now),
      editHistory: pruneHistory(state.internal.editHistory, now),
      readHistory: pruneHistory(state.internal.readHistory, now),
      recentActions: state.internal.recentActions.filter(
        (action) => action.at >= now - STRUGGLE_MEMORY_WINDOW_MS,
      ),
    },
  };
}

function emptyTurnSets(internal: LaneState["internal"]): LaneState["internal"] {
  return {
    ...internal,
    turnEditFingerprints: [],
    turnExecFingerprints: [],
    turnGreenedFingerprints: [],
  };
}

function emptySessionSets(internal: LaneState["internal"]): LaneState["internal"] {
  return {
    ...internal,
    turnEditFingerprints: [],
    turnExecFingerprints: [],
    turnFailedFingerprints: [],
    turnGreenedFingerprints: [],
  };
}

/**
 * Folds one event's struggle and progress evidence into the lane. Decay runs
 * first, then struggle increments, then progress relief. `baseReasons` is the
 * caller-side reason list (lifecycle; the engine folds mode after), so
 * struggle/progress explanations sit above lifecycle with mode newest.
 * `capabilities` gates the evidence rows per docs/STATE_ENGINE.md §Capability
 * table: disabled rows never increment and never relieve, and each disabled
 * event appends a reason saying what is not visible (one plain sentence).
 * Every increment appends a reason; the 0.6 upward crossing appends one more and disarms until struggle drops
 * below 0.4.
 *
 * Invariant 1 holds by construction: identical `tool.fail` repeats add
 * non-negative weights, test-summary relief needs a strict improvement, and
 * the fold clamps an identical repeat with nothing in between to its
 * pre-event value so the intervening decay cannot net-decrease it.
 */
export function applyStruggleProgressEvent(
  state: LaneState,
  event: NormalizedEvent,
  baseReasons: LaneState["reasons"] = state.reasons,
  capabilities: AdapterCapabilities = state.capabilities,
): StruggleProgressResult {
  const at = event.ts;
  const decayed = advanceStruggleProgress(state, at);
  let struggle = decayed.struggle;
  const before = decayed.struggle;
  let progress = decayed.progress;
  let reasons: readonly Reason[] = baseReasons;
  let internal = decayed.internal;

  const pushReason = (signal: Reason["signal"], delta: number | undefined, text: string): void => {
    const next =
      delta === undefined
        ? withReason(reasons, { at, signal, text })
        : withReason(reasons, { at, signal, delta, text });
    reasons = next.length > MAX_REASONS ? next.slice(0, MAX_REASONS) : next;
  };

  const addStruggle = (weight: number, text: string): void => {
    struggle = clamp01(struggle + weight);
    pushReason("struggle", weight, text);
  };

  const addProgressRelief = (weight: number, text: string): void => {
    progress = clamp01(progress + weight);
    pushReason("progress", weight, text);
    struggle = clamp01(struggle - PROGRESS_STRUGGLE_RELIEF * weight);
  };

  // Turn boundaries reset the novelty sets; the failure record behind
  // first-green survives turns (the doc has no turn restriction) and resets
  // only on session boundaries.
  if (event.kind === "turn.start") {
    internal = emptyTurnSets(internal);
  }
  if (event.kind === "session.start" || event.kind === "session.end") {
    internal = emptySessionSets(internal);
  }

  const tool = event.tool;
  const fingerprint = tool?.fingerprint;
  const category = tool?.category;
  const canSeeEdits = editsVisible(capabilities);
  const canSeeFailures = failuresVisible(capabilities);

  if (event.kind === "tool.start" && tool !== undefined && fingerprint !== undefined) {
    if (category === "edit") {
      if (!canSeeEdits) {
        pushReason(
          "struggle",
          undefined,
          "Edit evidence ignored: edits not visible for this agent.",
        );
      } else {
        const history = [...(internal.editHistory[fingerprint] ?? []), at];
        internal = {
          ...internal,
          editHistory: { ...internal.editHistory, [fingerprint]: history },
        };
        const inWindow = countWithin(history, at, STRUGGLE_EDIT_CHURN_WINDOW_MS);
        if (inWindow >= 3) {
          addStruggle(
            STRUGGLE_EDIT_CHURN_WEIGHT,
            `Same file ${label(event)} edited again (${inWindow} times in 5 min).`,
          );
        }
        if (inWindow >= 6) {
          addStruggle(
            STRUGGLE_EDIT_HEAVY_WEIGHT,
            `Same file ${label(event)} edited again (${inWindow} times in 5 min).`,
          );
        }
      }
      internal = {
        ...internal,
        lastEditAt: at,
        recentActions: [...internal.recentActions, { kind: "edit" as const, at }].filter(
          (action) => action.at >= at - STRUGGLE_MEMORY_WINDOW_MS,
        ),
      };
      if (!internal.turnEditFingerprints.includes(fingerprint)) {
        internal = {
          ...internal,
          turnEditFingerprints: [...internal.turnEditFingerprints, fingerprint],
        };
        addProgressRelief(PROGRESS_NEW_FILE_WEIGHT, `New file ${label(event)} edited this turn.`);
      }
    } else if (category === "exec") {
      const previousExecAt = internal.lastExecAt[fingerprint];
      internal = {
        ...internal,
        lastExecAt: { ...internal.lastExecAt, [fingerprint]: at },
      };
      if (
        previousExecAt !== undefined &&
        at - previousExecAt <= STRUGGLE_NO_EDIT_REPEAT_WINDOW_MS &&
        (internal.lastEditAt === null || internal.lastEditAt <= previousExecAt)
      ) {
        addStruggle(
          STRUGGLE_NO_EDIT_REPEAT_WEIGHT,
          `Same command ${label(event)} ran again with no edit in between.`,
        );
      }
      if (!internal.turnExecFingerprints.includes(fingerprint)) {
        internal = {
          ...internal,
          turnExecFingerprints: [...internal.turnExecFingerprints, fingerprint],
        };
        addProgressRelief(
          PROGRESS_NEW_COMMAND_WEIGHT,
          `New command ${label(event)} ran this turn.`,
        );
      }
    } else if (category === "read" || category === "search") {
      const history = [...(internal.readHistory[fingerprint] ?? []), at];
      internal = { ...internal, readHistory: { ...internal.readHistory, [fingerprint]: history } };
      const inWindow = countWithin(history, at, STRUGGLE_READ_LOOP_WINDOW_MS);
      if (inWindow >= 4) {
        addStruggle(
          STRUGGLE_READ_LOOP_WEIGHT,
          `Same ${category} ${label(event)} repeated (${inWindow} times in 5 min).`,
        );
      }
    }
  }

  if (event.kind === "tool.fail" && tool !== undefined && fingerprint !== undefined) {
    if (!canSeeFailures) {
      pushReason(
        "struggle",
        undefined,
        "Failure evidence ignored: failures not visible for this agent.",
      );
      internal = { ...internal, lastFailKey: null };
    } else {
      // The repeat-failure rows read "same exec fingerprint": only exec
      // failures contribute to failHistory and the +0.15/+0.25 rows. Failing
      // edits still advance the edit→fail cycle detector and the lastEditAt
      // clock below; failing reads/searches carry no struggle evidence.
      const isExecFail = category === "exec";
      if (isExecFail) {
        const history = [...(internal.failHistory[fingerprint] ?? []), at];
        internal = {
          ...internal,
          failHistory: { ...internal.failHistory, [fingerprint]: history },
        };
        const inWindow = countWithin(history, at, STRUGGLE_REPEAT_FAIL_WINDOW_MS);
        if (inWindow >= 2) {
          addStruggle(
            STRUGGLE_REPEAT_FAIL_WEIGHT,
            `Same command ${label(event)} failed again (${inWindow} times in 10 min).`,
          );
        }
        if (inWindow >= 4) {
          addStruggle(
            STRUGGLE_FOURTH_FAIL_WEIGHT,
            `Same command ${label(event)} failed a ${inWindow}th time in 10 min.`,
          );
        }
      }
      if (category === "exec" && (tool.execKind === "test" || tool.execKind === "build")) {
        const actions = [
          ...internal.recentActions,
          { kind: "fail" as const, fingerprint, at },
        ].filter((action) => action.at >= at - STRUGGLE_MEMORY_WINDOW_MS);
        internal = { ...internal, recentActions: actions };
        if (canSeeEdits && matchesFailCycle(actions)) {
          addStruggle(
            STRUGGLE_FAIL_CYCLE_WEIGHT,
            `Edit, fail, edit, same fail repeated for ${label(event)}.`,
          );
        }
      } else if (category === "edit") {
        if (!canSeeEdits) {
          pushReason(
            "struggle",
            undefined,
            "Edit evidence ignored: edits not visible for this agent.",
          );
        }
        internal = {
          ...internal,
          lastEditAt: at,
          recentActions: [...internal.recentActions, { kind: "edit" as const, at }].filter(
            (action) => action.at >= at - STRUGGLE_MEMORY_WINDOW_MS,
          ),
        };
      }
      // First-green evidence is "after ≥ 1 prior tool.fail of the same
      // fingerprint" with no turn restriction, so the failure record survives
      // turn boundaries while the novelty sets reset above.
      if (!internal.turnFailedFingerprints.includes(fingerprint)) {
        internal = {
          ...internal,
          turnFailedFingerprints: [...internal.turnFailedFingerprints, fingerprint],
        };
      }
      const failedCount = tool.outcome?.testSummary?.failed;
      if (typeof failedCount === "number") {
        internal = recordTestFailures(internal, fingerprint, failedCount, (weight, text) =>
          addProgressRelief(weight, text.replace("{}", label(event))),
        );
      }
      // Invariant 1: an identical repeat with nothing in between must never
      // decrease struggle. Test-summary relief needs a strict improvement, so
      // an identical event contributes nothing negative by construction — but
      // the intervening `advance` decay alone would still net-decrease it
      // (e.g. a 1 s gap halves nothing but shaves the 10 min EMA). Clamp to
      // the pre-event value so the repeat is exactly non-decreasing.
      const failKey = failKeyOf(event);
      if (state.internal.lastFailKey !== null && state.internal.lastFailKey === failKey) {
        struggle = Math.max(struggle, before);
      }
      internal = { ...internal, lastFailKey: failKey };
    }
  } else if (event.kind !== "tool.fail" && internal.lastFailKey !== null) {
    // Any non-fail event breaks the identical-repeat chain.
    internal = { ...internal, lastFailKey: null };
  }

  if (event.kind === "tool.end" && tool !== undefined && fingerprint !== undefined) {
    const failedCount = tool.outcome?.testSummary?.failed;
    if (typeof failedCount === "number") {
      internal = recordTestFailures(internal, fingerprint, failedCount, (weight, text) =>
        addProgressRelief(weight, text.replace("{}", label(event))),
      );
    }
    if (
      category === "exec" &&
      (tool.execKind === "test" || tool.execKind === "build") &&
      internal.turnFailedFingerprints.includes(fingerprint) &&
      !internal.turnGreenedFingerprints.includes(fingerprint)
    ) {
      internal = {
        ...internal,
        turnGreenedFingerprints: [...internal.turnGreenedFingerprints, fingerprint],
      };
      addProgressRelief(
        PROGRESS_FIRST_GREEN_WEIGHT,
        `First green for ${label(event)} after a failure.`,
      );
    }
  }

  if (event.kind === "turn.end" && event.lifecycle?.reason === "completed") {
    // Every unit of progress evidence relieves struggle, including the
    // completed-turn row: subtract 1.5 × 0.20, then cap at 0.2.
    addProgressRelief(PROGRESS_TURN_COMPLETE_WEIGHT, "Turn completed.");
    struggle = Math.min(struggle, PROGRESS_TURN_COMPLETE_STRUGGLE_CAP);
  }

  // Hysteresis: fire once on the upward crossing, re-arm below 0.4.
  let armed = internal.struggleArmed;
  if (armed && before < STRUGGLE_ATTENTION_THRESHOLD && struggle >= STRUGGLE_ATTENTION_THRESHOLD) {
    pushReason("struggle", undefined, "Struggle crossed 0.6: the agent looks stuck.");
    armed = false;
  } else if (!armed && struggle < STRUGGLE_REARM_THRESHOLD) {
    armed = true;
  }
  internal = { ...internal, struggleArmed: armed };

  return { struggle: clamp01(struggle), progress: clamp01(progress), reasons, internal };
}

/** Records a test-summary failure count, relieving on a strict improvement. */
function recordTestFailures(
  internal: LaneState["internal"],
  fingerprint: string,
  failedCount: number,
  relieve: (weight: number, text: string) => void,
): LaneState["internal"] {
  const previous = internal.lastTestFailures[fingerprint];
  if (previous !== undefined && failedCount < previous) {
    relieve(PROGRESS_TEST_SUMMARY_WEIGHT, "Fewer test failures for {} than the previous run.");
  }
  return {
    ...internal,
    lastTestFailures: { ...internal.lastTestFailures, [fingerprint]: failedCount },
  };
}

type StruggleActionLike = {
  readonly kind: "edit" | "fail";
  readonly fingerprint?: string;
  readonly at: number;
};

/** True when the last four edit/fail actions form edit → fail(F) → edit → fail(F). */
function matchesFailCycle(actions: readonly StruggleActionLike[]): boolean {
  if (actions.length < 4) return false;
  const [first, second, third, fourth] = actions.slice(-4) as [
    StruggleActionLike,
    StruggleActionLike,
    StruggleActionLike,
    StruggleActionLike,
  ];
  if (first.kind !== "edit" || second.kind !== "fail") return false;
  if (third.kind !== "edit" || fourth.kind !== "fail") return false;
  if (second.fingerprint === undefined || fourth.fingerprint === undefined) return false;
  if (second.fingerprint !== fourth.fingerprint) return false;
  if (fourth.at - first.at > STRUGGLE_FAIL_CYCLE_WINDOW_MS) return false;
  return true;
}
