// packages/core/src/engine/engine.ts — the deterministic lane state engine:
// `applyEvent` folds one normalized event into a lane, `advance` moves time
// forward with no events. What this is for: the lifecycle, activity and mode
// thirds of docs/STATE_ENGINE.md (§Lifecycle, §Activity, §Mode) as pure
// functions the daemon drives per event and every 500 ms, plus the
// §Capability-aware inference gates (p2-t04) that degrade every heuristic to
// the lane's declared capabilities. What it must not do: I/O, Date.now(),
// Math.random(), node:* or workspace imports, or branch on an agent's name —
// it reads the capabilities parameter only. Struggle, progress and mode gates
// live in struggle.ts, mode.ts and capabilities.ts; this module owns only the
// lifecycle rows (turnStart inference, turnEnd timeout, ?-message waiting,
// compaction visibility) and the per-event fidelity refresh. Subagent mode
// weighting is a half-weight EMA factor, not a separate lane.

import type { AdapterCapabilities, NormalizedEvent } from "../events/schema.js";
import {
  compactionVisible,
  fidelitySummary,
  finalMessageAsks,
  permissionVisible,
  promptsVisible,
  questionVisible,
} from "./capabilities.js";
import { applyModeEvent, refreshDisplayedMode } from "./mode.js";
import { type LaneState, type WaitingReason, withReason } from "./state.js";
import { advanceStruggleProgress, applyStruggleProgressEvent } from "./struggle.js";
import {
  ACTIVITY_SCALE_SECONDS,
  ACTIVITY_TAU_MS,
  INFERRED_TURN_COMPLETE_AFTER_MS,
  QUIET_AFTER_MS,
  STALE_AFTER_MS,
  TURN_COMPLETE_TO_IDLE_MS,
} from "./tuning.js";

/** Capabilities resolution: explicit parameter wins, else the lane's own. */
function effectiveCapabilities(
  state: LaneState,
  capabilities: AdapterCapabilities | undefined,
): AdapterCapabilities {
  return capabilities ?? state.capabilities;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Decays the raw activity rate over `dtMs` milliseconds. The EMA carries
 * events-per-second, so silence alone pulls `activity` toward 0.
 */
function decayRate(rate: number, dtMs: number): number {
  if (dtMs <= 0) return rate;
  return rate * Math.exp(-dtMs / ACTIVITY_TAU_MS);
}

// Allow fast automatic approval to resolve before showing or sounding a wait.
const INFERRED_PERMISSION_GRACE_MS = 1_500;

function isToolEvent(kind: NormalizedEvent["kind"]): boolean {
  return kind === "tool.start" || kind === "tool.end" || kind === "tool.fail";
}

/**
 * Folds one event into the lane and returns a new state; the input is never
 * mutated. Observed prompts enter waiting immediately. Unconfirmed permission
 * requests are checked by advance after a short grace period. Time comes
 * only from `event.ts`.
 */
export function applyEvent(
  state: LaneState,
  event: NormalizedEvent,
  capabilities?: AdapterCapabilities,
): LaneState {
  const caps = effectiveCapabilities(state, capabilities);
  const at = event.ts;

  // Activity: decay the rate EMA to the event time, then bump it once per
  // tool event. One tool event per 4 s settles at rate ≈ 0.28/s, which the
  // scale factor maps to ≈ 1.0 before clamping.
  const dtMs = Math.max(0, at - state.internal.activityUpdatedAt);
  const decayed = decayRate(state.internal.activityRate, dtMs);
  const rate = isToolEvent(event.kind) ? decayed + 1 / (ACTIVITY_TAU_MS / 1000) : decayed;
  const activity = clamp01(rate * ACTIVITY_SCALE_SECONDS);

  const next = transition(state, event, at, caps);
  // Struggle/progress fold before mode so a simultaneous displayed-mode
  // switch keeps its reason newest (p2-t02); on struggle-only events the
  // mode fold adds no reason, so struggle/progress still read newest.
  // Both folds read the lane's resolved capabilities; the lane also carries
  // the fidelity summary derived from them for the UI (p2-t04).
  const signals = applyStruggleProgressEvent(state, event, next.reasons, caps);
  const mode = applyModeEvent(state, event, caps, at, signals.reasons);
  return {
    ...state,
    ...next,
    capabilities: caps,
    fidelity: fidelitySummary(caps),
    activity,
    mode: mode.mode,
    displayedMode: mode.displayedMode,
    struggle: signals.struggle,
    progress: signals.progress,
    reasons: mode.reasons,
    // Opening a chat is presence evidence, not work or a reset of its silence clock.
    lastEventAt:
      event.kind === "session.start" ? state.lastEventAt : Math.max(state.lastEventAt, at),
    internal: {
      ...mode.internal,
      activityRate: rate,
      activityUpdatedAt: Math.max(state.internal.activityUpdatedAt, at),
      seenActivity: next.internal.seenActivity,
      struggleUpdatedAt: signals.internal.struggleUpdatedAt,
      progressUpdatedAt: signals.internal.progressUpdatedAt,
      struggleArmed: signals.internal.struggleArmed,
      failHistory: signals.internal.failHistory,
      editHistory: signals.internal.editHistory,
      readHistory: signals.internal.readHistory,
      lastExecAt: signals.internal.lastExecAt,
      lastEditAt: signals.internal.lastEditAt,
      turnEditFingerprints: signals.internal.turnEditFingerprints,
      turnExecFingerprints: signals.internal.turnExecFingerprints,
      turnFailedFingerprints: signals.internal.turnFailedFingerprints,
      turnGreenedFingerprints: signals.internal.turnGreenedFingerprints,
      lastTestFailures: signals.internal.lastTestFailures,
      recentActions: signals.internal.recentActions,
      lastFailKey: signals.internal.lastFailKey,
      permissionFingerprint: next.internal.permissionFingerprint,
      inferredPermission: next.internal.inferredPermission,
    },
  };
}

/**
 * Moves time forward with no events and returns a new state. Implements the
 * silence transitions (active → quiet → stale, turn_complete → idle) and —
 * only on `turnEnd = "none"` lanes — the inferred turn end after 120 s
 * without events following activity; `waiting` never expires here. Time
 * comes only from the injected `now`.
 */
export function advance(
  state: LaneState,
  now: number,
  capabilities?: AdapterCapabilities,
): LaneState {
  const caps = effectiveCapabilities(state, capabilities);

  const dtMs = Math.max(0, now - state.internal.activityUpdatedAt);
  const rate = decayRate(state.internal.activityRate, dtMs);
  const activity = clamp01(rate * ACTIVITY_SCALE_SECONDS);
  const base: LaneState = {
    ...state,
    capabilities: caps,
    fidelity: fidelitySummary(caps),
    activity,
    internal: {
      ...state.internal,
      activityRate: rate,
      activityUpdatedAt: Math.max(state.internal.activityUpdatedAt, now),
    },
  };

  const silenceMs = now - state.lastEventAt;
  // Struggle and progress decay on the same clock; the decayed lane feeds
  // every silence transition below so no path skips the half-life.
  const decayed = withSignals(base, advanceStruggleProgress(base, now));
  if (silenceMs < 0) return withMode(decayed, refreshDisplayedMode(decayed, state.lastEventAt));

  const request = base.internal.inferredPermission;
  if (
    request !== null &&
    base.lifecycle !== "waiting" &&
    now - request.at >= INFERRED_PERMISSION_GRACE_MS
  ) {
    const waiting = {
      ...decayed,
      lifecycle: "waiting" as const,
      lifecycleConfidence: "inferred" as const,
      waitingReason: "permission" as const,
      reasons: withReason(decayed.reasons, {
        at: now,
        signal: "lifecycle",
        text: "Lane may be waiting for approval (inferred).",
      }),
    };
    return withMode(waiting, refreshDisplayedMode(waiting, now));
  }

  // The 120 s inference fires only when the lane cannot observe turn ends
  // (`turnEnd = "none"`): silence after activity means the turn ended, not
  // that the lane hung. It wins over staleness for the same reason. Source
  // states are active/quiet only, per the invariant that turn_complete is
  // never entered from idle, waiting or stale; a stale lane with activity
  // behind it is unreachable here because this same inference fires at 120 s,
  // long before the 8 min stale mark. With `compaction = false` long
  // silences stay `quiet` only: the quiet leg below still runs, the stale
  // leg is skipped, and no compaction reason is ever attached (the event
  // path returns the lane untouched when compaction is invisible).
  if (
    caps.turnEnd === "none" &&
    (base.lifecycle === "active" || base.lifecycle === "quiet") &&
    base.internal.seenActivity &&
    silenceMs >= INFERRED_TURN_COMPLETE_AFTER_MS
  ) {
    const settled = {
      ...decayed,
      lifecycle: "turn_complete" as const,
      lifecycleConfidence: "inferred" as const,
      turnStartedAt: undefined,
      reasons: withReason(decayed.reasons, {
        at: now,
        signal: "lifecycle" as const,
        text: "Turn ended: no events for a while after activity.",
      }),
    };
    return withMode(settled, refreshDisplayedMode(settled, now));
  }

  if (base.lifecycle === "turn_complete" && silenceMs >= TURN_COMPLETE_TO_IDLE_MS) {
    const settled = {
      ...decayed,
      lifecycle: "idle" as const,
      lifecycleConfidence: "inferred" as const,
      turnStartedAt: undefined,
      internal: { ...decayed.internal, seenActivity: false },
      reasons: withReason(decayed.reasons, {
        at: now,
        signal: "lifecycle" as const,
        text: "Turn rest finished: lane is idle.",
      }),
    };
    return withMode(settled, refreshDisplayedMode(settled, now));
  }

  if (base.lifecycle === "quiet" && silenceMs >= STALE_AFTER_MS && compactionVisible(caps)) {
    const settled = {
      ...decayed,
      lifecycle: "stale" as const,
      lifecycleConfidence: "inferred" as const,
      reasons: withReason(decayed.reasons, {
        at: now,
        signal: "lifecycle" as const,
        text: "Lane went stale: no events for a long time.",
      }),
    };
    return withMode(settled, refreshDisplayedMode(settled, now));
  }

  if (base.lifecycle === "active" && silenceMs >= QUIET_AFTER_MS) {
    const settled = {
      ...decayed,
      lifecycle: "quiet" as const,
      lifecycleConfidence: "inferred" as const,
      reasons: withReason(decayed.reasons, {
        at: now,
        signal: "lifecycle" as const,
        text: "Lane went quiet: no events for a while.",
      }),
    };
    return withMode(settled, refreshDisplayedMode(settled, now));
  }

  return withMode(decayed, refreshDisplayedMode(decayed, now));
}

/**
 * Overlays a struggle/progress computation onto a lane. The result carries
 * the settled signal values, reasons and working memory.
 */
function withSignals(
  state: LaneState,
  signals: Pick<LaneState, "struggle" | "progress" | "reasons" | "internal">,
): LaneState {
  return {
    ...state,
    struggle: signals.struggle,
    progress: signals.progress,
    reasons: signals.reasons,
    internal: signals.internal,
  };
}

/**
 * Overlays a mode computation onto a lifecycle-settled lane. The mode
 * result already carries the settled lane's working memory (hysteresis
 * trackers) and reason list, so this only copies its four fields across.
 */
function withMode(
  state: LaneState,
  mode: Pick<LaneState, "displayedMode" | "internal" | "mode" | "reasons">,
): LaneState {
  return {
    ...state,
    mode: mode.mode,
    displayedMode: mode.displayedMode,
    reasons: mode.reasons,
    internal: mode.internal,
  };
}

type Transition = Pick<
  LaneState,
  "lifecycle" | "lifecycleConfidence" | "turnStartedAt" | "reasons" | "internal"
> &
  Partial<Pick<LaneState, "waitingReason">>;

/**
 * The lifecycle half of applyEvent, exactly per the docs/STATE_ENGINE.md
 * diagram plus §Capability-aware inference. `idle → waiting` never happens
 * directly; `waiting` exits only on `turn.start`, a `permission_replied`
 * notification, `session.end`, a completed turn resolving a permission wait,
 * or a tool event resolving the request. Unconfirmed requests can also
 * end on newer parent tool starts. `turn_complete` is entered from
 * `active`/`quiet` or permission waiting via `turn.end(completed)`,
 * or — with `turnEnd = "none"`
 * — after 120 s of post-activity silence in `advance` (waiting is never
 * inferred that way); `compaction` sets `quiet` unless waiting or invisible
 * (`compaction = false` leaves the lane untouched); with `turnStart = none`
 * the first tool event wakes `idle → active` as inferred; with both prompt
 * capabilities off, `waiting` may still be inferred from a `turn.end` whose
 * adapter could inspect the final response. Session openings preserve lifecycle;
 * other events revive `quiet`/`stale` to `active`. Subagent events fold into
 * this lane like any other activity
 * (subagent tool events blend the mode weights at half weight) and never
 * create a lane of their own — lane creation is the caller's decision, one
 * lane per parent session. Reads capabilities only, never the agent name.
 */
function transition(
  state: LaneState,
  event: NormalizedEvent,
  at: number,
  capabilities: AdapterCapabilities,
): Transition {
  const idle: Transition = {
    lifecycle: state.lifecycle,
    lifecycleConfidence: state.lifecycleConfidence,
    turnStartedAt: state.turnStartedAt,
    reasons: state.reasons,
    internal: state.internal,
  };

  const clearPermission = {
    ...state.internal,
    permissionFingerprint: null,
    inferredPermission: null,
  };

  // Every remaining kind below may set seenActivity when it observes work;
  // the switch body spells it out per case.
  switch (event.kind) {
    case "session.end":
      return {
        ...idle,
        lifecycle: "idle",
        lifecycleConfidence: "observed",
        turnStartedAt: undefined,
        waitingReason: undefined,
        internal: { ...clearPermission, seenActivity: false },
        reasons: withReason(state.reasons, {
          at,
          signal: "lifecycle",
          text: "Session ended: lane is idle.",
        }),
      };

    case "turn.start":
      // On a `turnStart = none` lane an explicit turn.start still counts
      // (adapters never emit what capabilities deny, so its presence means
      // the source did tell us), but an inferred marking is the norm there.
      if (capabilities.turnStart === "inferred" && state.lifecycle === "active") {
        return {
          ...idle,
          lifecycleConfidence: event.lifecycle?.confidence ?? state.lifecycleConfidence,
          turnStartedAt: at,
          internal: clearPermission,
        };
      }
      return {
        ...idle,
        lifecycle: "active",
        // An unmarked turn.start is an observed prompt submission: the
        // schema requires no lifecycle hint on this kind, so absence of a
        // marking means observed, not inheritance of a stale inferred
        // value from a prior engine timeout.
        lifecycleConfidence: event.lifecycle?.confidence ?? "observed",
        turnStartedAt: at,
        waitingReason: undefined,
        internal: { ...clearPermission, seenActivity: false },
        reasons: withReason(state.reasons, {
          at,
          signal: "lifecycle",
          text: "Turn started: lane is active.",
        }),
      };

    case "permission.request": {
      if (state.lifecycle === "idle") return idle;
      // Adapters never emit what capabilities deny, so an explicit prompt
      // event on a lane that cannot see it is stale or misrouted evidence:
      // note it and hold the lane instead of reporting confident waiting.
      if (!permissionVisible(capabilities)) {
        return {
          ...idle,
          reasons: withReason(state.reasons, {
            at,
            signal: "lifecycle",
            text: "Permission evidence ignored: permissions not visible for this agent.",
          }),
        };
      }
      const permissionFingerprint = event.tool?.fingerprint ?? null;
      if (event.lifecycle?.confidence === "inferred") {
        if (state.lifecycle === "turn_complete" || at < (state.turnStartedAt ?? at)) return idle;
        const pending = state.internal.inferredPermission;
        if (state.lifecycle === "waiting" && pending === null) return idle;
        if (pending !== null && at <= pending.at) return idle;
        return {
          ...idle,
          internal: {
            ...state.internal,
            permissionFingerprint,
            inferredPermission: {
              at,
              turnId: typeof event.meta?.turnId === "string" ? event.meta.turnId : null,
            },
          },
        };
      }
      return {
        ...idle,
        lifecycle: "waiting",
        lifecycleConfidence: eventConfidence(event, state.lifecycleConfidence),
        waitingReason: "permission",
        internal: { ...clearPermission, permissionFingerprint },
        reasons: withReason(state.reasons, {
          at,
          signal: "lifecycle",
          text: "Lane is waiting: permission requested.",
        }),
      };
    }

    case "question.asked":
      if (state.lifecycle === "idle") return idle;
      if (!questionVisible(capabilities)) {
        return {
          ...idle,
          reasons: withReason(state.reasons, {
            at,
            signal: "lifecycle",
            text: "Question evidence ignored: questions not visible for this agent.",
          }),
        };
      }
      return {
        ...idle,
        lifecycle: "waiting",
        lifecycleConfidence: eventConfidence(event, state.lifecycleConfidence),
        waitingReason: "question",
        internal: clearPermission,
        reasons: withReason(state.reasons, {
          at,
          signal: "lifecycle",
          text: "Lane is waiting: question asked.",
        }),
      };

    case "turn.end": {
      if (state.internal.inferredPermission === null) {
        return transitionTurnEnd(state, event, at, idle, capabilities);
      }
      const settled = { ...idle, internal: clearPermission };
      if (event.lifecycle.reason === "cancelled") {
        settled.lifecycle = "idle";
        settled.lifecycleConfidence = event.lifecycle.confidence;
        settled.waitingReason = undefined;
      } else if (state.lifecycle === "waiting") {
        settled.lifecycle = "active";
        settled.waitingReason = undefined;
      }
      return transitionTurnEnd({ ...state, ...settled }, event, at, settled, capabilities);
    }

    case "compaction":
      if (!compactionVisible(capabilities)) return idle;
      if (state.lifecycle === "waiting") return idle;
      if (state.lifecycle === "quiet") return idle;
      return {
        ...idle,
        lifecycle: "quiet",
        lifecycleConfidence: "observed",
        reasons: withReason(state.reasons, {
          at,
          signal: "lifecycle",
          text: "Context compacted: expect a lull.",
        }),
      };

    case "notification":
      if (
        event.meta?.kind === "permission_replied" &&
        (state.lifecycle === "waiting" || state.internal.inferredPermission !== null)
      ) {
        return {
          ...idle,
          lifecycle: "active",
          lifecycleConfidence: "observed",
          waitingReason: undefined,
          internal: clearPermission,
          reasons: withReason(state.reasons, {
            at,
            signal: "lifecycle",
            text: "Permission answered: lane is active.",
          }),
        };
      }
      return revive(state, at, idle);

    case "tool.start":
    case "tool.end":
    case "tool.fail":
    case "subagent.start":
    case "subagent.end": {
      const matchedObservedRequest = grantsPendingPermission(state, event);
      if (matchedObservedRequest || resolvesInferredPermission(state, event)) {
        const wasWaiting = state.lifecycle === "waiting";
        const text = matchedObservedRequest
          ? "Requested tool ran: permission answered, lane is active (inferred)."
          : "Tool activity continued: lane is active (inferred).";
        return {
          ...idle,
          lifecycle: "active",
          lifecycleConfidence: wasWaiting ? "inferred" : state.lifecycleConfidence,
          waitingReason: undefined,
          internal: { ...clearPermission, seenActivity: true },
          reasons: wasWaiting
            ? withReason(state.reasons, { at, signal: "lifecycle", text })
            : state.reasons,
        };
      }
      const memory = { ...state.internal, seenActivity: true };
      if (state.lifecycle === "waiting" || state.lifecycle === "turn_complete") {
        return { ...idle, internal: memory };
      }
      if (
        state.lifecycle === "idle" ||
        state.lifecycle === "quiet" ||
        state.lifecycle === "stale"
      ) {
        // On a `turnStart = none` lane the first tool event is the turn
        // signal itself, so the wake-up is inferred; anywhere else (or an
        // explicit turn.start lane) activity is observed. Quiet/stale
        // revivals keep their existing observed/inferred marking: the lane
        // already knew a turn was underway.
        const inferredWake = state.lifecycle === "idle" && capabilities.turnStart === "none";
        return {
          ...idle,
          lifecycle: "active",
          lifecycleConfidence: inferredWake ? "inferred" : "observed",
          internal: memory,
          reasons: withReason(state.reasons, {
            at,
            signal: "lifecycle",
            text: inferredWake
              ? "Activity seen with no turn signal: lane is active (inferred)."
              : "Activity seen: lane is active.",
          }),
        };
      }
      return { ...idle, internal: memory };
    }

    case "session.start":
      return idle;

    case "agent.report":
      return revive(state, at, idle);
  }
}

// A later start suggests continued work. A completion only counts for the
// requested tool: an unrelated tool may have been running before the request.
function resolvesInferredPermission(state: LaneState, event: NormalizedEvent): boolean {
  const request = state.internal.inferredPermission;
  if (
    request === null ||
    event.sessionId !== state.sessionId ||
    event.parentSessionId !== undefined ||
    (request.turnId !== null && request.turnId !== event.meta?.turnId) ||
    event.ts < request.at
  ) {
    return false;
  }
  const matches = event.tool?.fingerprint === state.internal.permissionFingerprint;
  return event.kind === "tool.start"
    ? !matches && event.ts > request.at
    : (event.kind === "tool.end" || event.kind === "tool.fail") && matches;
}

// Preserve fingerprint recovery for observed waits and existing recordings.
function grantsPendingPermission(state: LaneState, event: NormalizedEvent): boolean {
  return (
    state.lifecycle === "waiting" &&
    state.waitingReason === "permission" &&
    state.internal.inferredPermission === null &&
    state.internal.permissionFingerprint !== null &&
    event.tool?.fingerprint === state.internal.permissionFingerprint
  );
}

/**
 * The confidence a lifecycle transition carries: the event's own marking
 * wins (docs/STATE_ENGINE.md requires `inferred` whenever the transition
 * came from an inferred event), falling back to the lane's current value
 * for events that carry no lifecycle hint (turn.start, permission.request,
 * question.asked have no required lifecycle field in the schema).
 */
function eventConfidence(
  event: NormalizedEvent,
  fallback: LaneState["lifecycleConfidence"],
): LaneState["lifecycleConfidence"] {
  return event.lifecycle?.confidence ?? fallback;
}

function transitionTurnEnd(
  state: LaneState,
  event: NormalizedEvent,
  at: number,
  idle: Transition,
  capabilities: AdapterCapabilities,
): Transition {
  const reason = event.lifecycle?.reason;
  const confidence = event.lifecycle?.confidence ?? "observed";
  if (reason === "completed") {
    // A completed turn is explicit evidence that an earlier permission wait
    // is over, even when the source has no separate approval-reply event.
    const permissionWait = state.lifecycle === "waiting" && state.waitingReason === "permission";
    if (state.lifecycle !== "active" && state.lifecycle !== "quiet" && !permissionWait) {
      return idle;
    }
    // With both prompt capabilities off, a completed turn end can still mean
    // a question when the final message asks one; otherwise the lane rests
    // in turn_complete and never becomes waiting (conservative on purpose).
    if (!promptsVisible(capabilities) && finalMessageAsks(event.lifecycle?.message)) {
      return {
        ...idle,
        lifecycle: "waiting",
        lifecycleConfidence: "inferred",
        waitingReason: "question",
        turnStartedAt: undefined,
        reasons: withReason(state.reasons, {
          at,
          signal: "lifecycle",
          text: "Turn ended with a question: lane is waiting (inferred).",
        }),
      };
    }
    return {
      ...idle,
      lifecycle: "turn_complete",
      lifecycleConfidence: confidence,
      turnStartedAt: undefined,
      waitingReason: undefined,
      reasons: withReason(state.reasons, {
        at,
        signal: "lifecycle",
        text: "Turn completed.",
      }),
    };
  }
  if (reason === "question" || reason === "permission" || reason === "idle_prompt") {
    if (state.lifecycle === "idle" || state.lifecycle === "waiting") return idle;
    // An inferred question belongs to turn-end interpretation, not an
    // explicit question event: sources such as Codex can inspect their final
    // response even when they cannot emit question.asked. Observed prompt
    // reasons still require the matching declared capability.
    const inferredQuestion = reason === "question" && confidence === "inferred";
    const visible =
      reason === "question"
        ? inferredQuestion || questionVisible(capabilities)
        : reason === "permission"
          ? permissionVisible(capabilities)
          : promptsVisible(capabilities);
    if (!visible) {
      return {
        ...idle,
        turnStartedAt: undefined,
        reasons: withReason(state.reasons, {
          at,
          signal: "lifecycle",
          text: "Waiting evidence ignored: questions not visible for this agent.",
        }),
      };
    }
    const waitingReason: WaitingReason =
      reason === "question" ? "question" : reason === "permission" ? "permission" : "idle_prompt";
    return {
      ...idle,
      lifecycle: "waiting",
      lifecycleConfidence: confidence,
      waitingReason,
      turnStartedAt: undefined,
      reasons: withReason(state.reasons, {
        at,
        signal: "lifecycle",
        text: `Turn ended: lane is waiting (${waitingReason}).`,
      }),
    };
  }
  // Error, cancelled and unknown endings carry no lifecycle meaning yet;
  // the turn is over but the lane keeps its state.
  return { ...idle, turnStartedAt: undefined };
}

/** Activity evidence revives a quiet or stale lane; session openings do not call this. */
function revive(state: LaneState, at: number, idle: Transition): Transition {
  if (state.lifecycle !== "quiet" && state.lifecycle !== "stale") return idle;
  return {
    ...idle,
    lifecycle: "active",
    lifecycleConfidence: "observed",
    reasons: withReason(state.reasons, {
      at,
      signal: "lifecycle",
      text: "Activity seen: lane is active.",
    }),
  };
}
