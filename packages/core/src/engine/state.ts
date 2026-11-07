// packages/core/src/engine/state.ts — the lane state shape and its
// constructor. What this is for: the UI-bound `LaneState` exactly per
// docs/STATE_ENGINE.md §Outputs (lifecycle, activity, lastEventAt,
// turnStartedAt, reasons capped at 20, `fidelity` naming every disabled
// heuristic in plain words) plus the `internal` working memory the
// UI never sees. What it must not do: compute anything, touch time or I/O,
// or branch on an agent's name — it only holds what the engine derives.
// Mode memory (EMA clock, hysteresis timers) is owned by p2-t02 here;
// struggle, progress and attention-hysteresis memory are owned by p2-t03;
// confidence labelling and capability gating are owned by p2-t04
// (capabilities.ts predicates, fidelity derived from capabilities only).

import type { AdapterCapabilities, AgentId } from "../events/schema.js";
import { fidelitySummary } from "./capabilities.js";
import { MAX_REASONS } from "./tuning.js";

export type Lifecycle = "idle" | "active" | "quiet" | "stale" | "waiting" | "turn_complete";

export type WaitingReason = "question" | "permission" | "idle_prompt";

export type LifecycleConfidence = "observed" | "inferred";

export type ModeWeights = {
  readonly exploring: number;
  readonly editing: number;
  readonly testing: number;
  readonly other: number;
};

export type DisplayedMode = "exploring" | "editing" | "testing" | "other";

export type ReasonSignal = "struggle" | "progress" | "lifecycle" | "mode";

export type Reason = {
  readonly at: number;
  readonly signal: ReasonSignal;
  readonly delta?: number;
  readonly text: string;
};

/**
 * One ordered marker for the edit → fail cycle detector: an edit (any file)
 * or an exec test/build failure with its fingerprint, kept for 15 min.
 */
export type StruggleAction = {
  readonly kind: "edit" | "fail";
  readonly fingerprint?: string;
  readonly at: number;
};

/**
 * Working memory the engine needs across calls but the UI never receives
 * (`LaneRender` drops this key). `activityRate` is the raw events-per-second
 * EMA behind `activity`; `activityUpdatedAt` is the clock it was last
 * decayed to; `seenActivity` records tool events since the turn started so
 * `advance` only infers a missing turn end after a period of activity.
 * `modeUpdatedAt` is the clock the mode EMAs were last decayed to; the mode
 * blend itself lives on the public `mode` weights. The hysteresis trackers
 * (`modeSwitchedAt`, `modeChallenger`, `modeChallengerSince`) implement the
 * docs/STATE_ENGINE.md §Mode displayed-mode hold: who leads besides the
 * current display, and since when. Struggle/progress memory (owned by p2-t03)
 * holds per-fingerprint timestamp histories pruned to the longest detection
 * window (15 min), the turn-scoped fingerprint sets behind both novelty
 * progress and the no-edit-between check (one shared store), the failure
 * state for first-green/test-summary evidence, and the 0.6/0.4 attention
 * hysteresis arm.
 */
export type WorkingMemory = {
  readonly activityRate: number;
  readonly activityUpdatedAt: number;
  readonly seenActivity: boolean;
  readonly modeUpdatedAt: number;
  readonly modeSwitchedAt: number;
  readonly modeChallenger: DisplayedMode | null;
  readonly modeChallengerSince: number | null;
  readonly struggleUpdatedAt: number;
  readonly progressUpdatedAt: number;
  readonly struggleArmed: boolean;
  readonly failHistory: { readonly [fingerprint: string]: readonly number[] };
  readonly editHistory: { readonly [fingerprint: string]: readonly number[] };
  readonly readHistory: { readonly [fingerprint: string]: readonly number[] };
  readonly lastExecAt: { readonly [fingerprint: string]: number };
  readonly lastEditAt: number | null;
  readonly turnEditFingerprints: readonly string[];
  readonly turnExecFingerprints: readonly string[];
  readonly turnFailedFingerprints: readonly string[];
  readonly turnGreenedFingerprints: readonly string[];
  readonly lastTestFailures: { readonly [fingerprint: string]: number };
  readonly recentActions: readonly StruggleAction[];
  /**
   * Identity key (fingerprint plus outcome) of the immediately preceding
   * event when it was a `tool.fail`, else null. Any non-fail event clears
   * it, so equality with the current fail means an identical repeat with
   * nothing in between: the fold then clamps struggle to its pre-event
   * value so decay can never net-decrease it (invariant 1).
   */
  readonly lastFailKey: string | null;
  /**
   * Fingerprint of the tool a pending permission request named, else null.
   * Sources without an approval-reply event still show the grant: the very
   * tool that was asked about runs. Only that tool may end the wait.
   */
  readonly permissionFingerprint: string | null;
};

export type LaneState = {
  readonly laneId: number;
  readonly sessionId: string;
  readonly agent: AgentId;
  readonly via?: string;
  readonly capabilities: AdapterCapabilities;
  readonly lifecycleConfidence: LifecycleConfidence;
  readonly lifecycle: Lifecycle;
  readonly waitingReason?: WaitingReason;
  /** Plain-words disabled-heuristic summary for the UI, null at full fidelity. */
  readonly fidelity: string | null;
  readonly mode: ModeWeights;
  readonly displayedMode: DisplayedMode;
  readonly activity: number;
  readonly progress: number;
  readonly struggle: number;
  readonly lastEventAt: number;
  readonly turnStartedAt?: number;
  readonly reasons: readonly Reason[];
  readonly internal: WorkingMemory;
};

export type CreateLaneArgs = {
  readonly laneId: number;
  readonly sessionId: string;
  readonly agent: AgentId;
  readonly capabilities: AdapterCapabilities;
  readonly via?: string;
  /** Creation time: an event timestamp or the engine clock, never Date.now(). */
  readonly now: number;
};

/**
 * A fresh lane: idle, silent, with neutral mode weights that sum to exactly
 * 1 and empty reasons. One lane per parent session; subagent events fold
 * into it via applyEvent and never create a lane of their own.
 */
export function createLane(args: CreateLaneArgs): LaneState {
  return {
    laneId: args.laneId,
    sessionId: args.sessionId,
    agent: args.agent,
    ...(args.via === undefined ? {} : { via: args.via }),
    capabilities: args.capabilities,
    lifecycleConfidence: "observed",
    lifecycle: "idle",
    fidelity: fidelitySummary(args.capabilities),
    mode: { exploring: 0.25, editing: 0.25, testing: 0.25, other: 0.25 },
    displayedMode: "other",
    activity: 0,
    progress: 0,
    struggle: 0,
    lastEventAt: args.now,
    reasons: [],
    internal: {
      activityRate: 0,
      activityUpdatedAt: args.now,
      seenActivity: false,
      modeUpdatedAt: args.now,
      modeSwitchedAt: args.now,
      modeChallenger: null,
      modeChallengerSince: null,
      struggleUpdatedAt: args.now,
      progressUpdatedAt: args.now,
      struggleArmed: true,
      failHistory: {},
      editHistory: {},
      readHistory: {},
      lastExecAt: {},
      lastEditAt: null,
      turnEditFingerprints: [],
      turnExecFingerprints: [],
      turnFailedFingerprints: [],
      turnGreenedFingerprints: [],
      lastTestFailures: {},
      recentActions: [],
      lastFailKey: null,
      permissionFingerprint: null,
    },
  };
}

/** Prepends a reason, newest first, capped at MAX_REASONS. */
export function withReason(reasons: readonly Reason[], reason: Reason): readonly Reason[] {
  return [reason, ...reasons].slice(0, MAX_REASONS);
}
