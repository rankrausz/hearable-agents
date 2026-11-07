// packages/core/src/engine/mode.ts — what kind of work the lane is doing.
// What this is for: the docs/STATE_ENGINE.md §Mode blend — a per-category
// EMA (τ = 20 s, updated on every `tool.start`) plus the hysteresis that
// keeps `displayedMode` stable while agents interleave tool calls. What it
// must not do: I/O, time, randomness, or branching on an agent's name — it
// reads only the event's tool fields and the `toolKinds` capability, and
// capability gating beyond that weight read belongs to p2-t04.
// With `editEvents = false` the lane has no `editing` evidence: edit tools
// absorb into `other` so the blend keeps working but the edit share never
// rises. The redirect is annotated here (not on every caller) so mode.ts
// stays the single owner of the mode blend's evidence mapping.
//
// Edge readings chosen here (simplest reversible ones consistent with the
// flicker rationale): the very first tool event's Δt is 0, so the blend
// starts from the neutral weights instead of snapping to the first tool;
// an `exec` tool with no `execKind` counts as `other`; a subagent tool event
// is detected by the presence of `parentSessionId` and halves the blend
// factor; half-weight evidence (subagent, uncertain `other`) slows the blend
// instead of targeting 0.5, which keeps the weights summing to exactly 1.

import type { AdapterCapabilities, NormalizedEvent, ToolInfo } from "../events/schema.js";
import { editsVisible } from "./capabilities.js";
import { type DisplayedMode, type LaneState, type ModeWeights, withReason } from "./state.js";
import {
  MODE_SUBAGENT_WEIGHT,
  MODE_SWITCH_HOLD_MS,
  MODE_SWITCH_MARGIN,
  MODE_TAU_MS,
  MODE_UNCERTAIN_OTHER_WEIGHT,
} from "./tuning.js";

/** Fixed evaluation order so challenger ties resolve deterministically. */
const MODE_ORDER: readonly DisplayedMode[] = ["exploring", "editing", "testing", "other"];

/** Evidence an event contributes to the blend, if any. */
export type ModeEvidence = {
  readonly target: DisplayedMode;
  /** 0..1 multiplier on the EMA blend factor. */
  readonly weight: number;
};

/**
 * Maps a tool to its mode bucket per docs/STATE_ENGINE.md §Mode: read +
 * search + web read the world (exploring), edits change it (editing),
 * test/build/lint execs verify it (testing), everything else is other.
 */
export function mapToolToMode(tool: ToolInfo): DisplayedMode {
  switch (tool.category) {
    case "read":
    case "search":
    case "web":
      return "exploring";
    case "edit":
      return "editing";
    case "exec":
      return tool.execKind === "test" || tool.execKind === "build" || tool.execKind === "lint"
        ? "testing"
        : "other";
    case "other":
      return "other";
  }
}

/**
 * The blend evidence for an event, or null when the event carries no mode
 * information. Only `tool.start` moves the weights; every other kind leaves
 * them untouched (hysteresis still re-evaluates on its timestamp). With
 * `editEvents = false` edit tools redirect to `other` so `other` absorbs the
 * activity and the `editing` share decays toward 0 instead of rising.
 */
export function modeEvidence(
  event: NormalizedEvent,
  capabilities: AdapterCapabilities,
): ModeEvidence | null {
  if (event.kind !== "tool.start" || event.tool === undefined) return null;
  const target = mapToolToMode(event.tool);
  const effective =
    target === "editing" && !editsVisible(capabilities) ? ("other" as const) : target;
  // `typed` sources state the kind outright, so it counts fully; anything
  // else that lands in `other` is an uncertain guess and counts half
  // (docs/STATE_ENGINE.md §Capability-aware inference).
  const base =
    event.tool.category === "other" && capabilities.toolKinds !== "typed"
      ? MODE_UNCERTAIN_OTHER_WEIGHT
      : 1;
  // Subagent tool events fold into the parent lane at half weight.
  const subagent = event.parentSessionId !== undefined ? MODE_SUBAGENT_WEIGHT : 1;
  return { target: effective, weight: base * subagent };
}

/** The EMA blend factor for `dtMs` elapsed: 1 − exp(−Δt/τ), τ = 20 s. */
export function emaFactor(dtMs: number): number {
  if (dtMs <= 0) return 0;
  return 1 - Math.exp(-dtMs / MODE_TAU_MS);
}

/**
 * Blends the weights toward a one-hot target by `alpha`, then normalizes so
 * the weights sum to exactly 1 (invariant 3 holds up to float rounding).
 */
export function blendModeWeights(
  weights: ModeWeights,
  target: DisplayedMode,
  alpha: number,
): ModeWeights {
  const raw: ModeWeights = {
    exploring: weights.exploring + alpha * ((target === "exploring" ? 1 : 0) - weights.exploring),
    editing: weights.editing + alpha * ((target === "editing" ? 1 : 0) - weights.editing),
    testing: weights.testing + alpha * ((target === "testing" ? 1 : 0) - weights.testing),
    other: weights.other + alpha * ((target === "other" ? 1 : 0) - weights.other),
  };
  const sum = raw.exploring + raw.editing + raw.testing + raw.other;
  return {
    exploring: raw.exploring / sum,
    editing: raw.editing / sum,
    testing: raw.testing / sum,
    other: raw.other / sum,
  };
}

export type HysteresisInput = {
  readonly weights: ModeWeights;
  readonly displayed: DisplayedMode;
  readonly challenger: DisplayedMode | null;
  readonly challengerSince: number | null;
  readonly switchedAt: number;
  readonly now: number;
};

export type HysteresisOutput = {
  readonly displayed: DisplayedMode;
  readonly challenger: DisplayedMode | null;
  readonly challengerSince: number | null;
  readonly switched: boolean;
};

/**
 * The displayed-mode hold: the leading non-displayed category becomes the
 * challenger, and the display switches only once it has led the current
 * mode by ≥ 0.15 for ≥ 5 s, and only if the last switch is itself ≥ 5 s
 * back (invariant 4). The timer resets whenever the lead changes hands or
 * the margin lapses.
 */
export function nextDisplayedMode(input: HysteresisInput): HysteresisOutput {
  let leader: DisplayedMode = input.displayed;
  let leaderWeight = input.weights[input.displayed];
  for (const mode of MODE_ORDER) {
    if (mode === input.displayed) continue;
    if (input.weights[mode] > leaderWeight) {
      leader = mode;
      leaderWeight = input.weights[mode];
    }
  }
  if (
    leader === input.displayed ||
    leaderWeight - input.weights[input.displayed] < MODE_SWITCH_MARGIN
  ) {
    return {
      displayed: input.displayed,
      challenger: null,
      challengerSince: null,
      switched: false,
    };
  }
  if (leader !== input.challenger || input.challengerSince === null) {
    return {
      displayed: input.displayed,
      challenger: leader,
      challengerSince: input.now,
      switched: false,
    };
  }
  if (
    input.now - input.challengerSince >= MODE_SWITCH_HOLD_MS &&
    input.now - input.switchedAt >= MODE_SWITCH_HOLD_MS
  ) {
    return { displayed: leader, challenger: null, challengerSince: null, switched: true };
  }
  return {
    displayed: input.displayed,
    challenger: leader,
    challengerSince: input.challengerSince,
    switched: false,
  };
}

export type ModeResult = Pick<LaneState, "displayedMode" | "internal" | "mode" | "reasons">;

/**
 * Folds one event's mode evidence into the lane: EMA update on `tool.start`,
 * hysteresis re-evaluation on every event. `baseReasons` is the caller-side
 * reason list (lifecycle first), so a simultaneous lifecycle transition and
 * mode switch keep both explanations, newest first.
 */
export function applyModeEvent(
  state: LaneState,
  event: NormalizedEvent,
  capabilities: AdapterCapabilities,
  at: number,
  baseReasons: LaneState["reasons"] = state.reasons,
): ModeResult {
  const evidence = modeEvidence(event, capabilities);
  let weights = state.mode;
  let modeUpdatedAt = state.internal.modeUpdatedAt;
  let reasons = baseReasons;
  if (
    evidence !== null &&
    event.kind === "tool.start" &&
    event.tool !== undefined &&
    mapToolToMode(event.tool) === "editing" &&
    !editsVisible(capabilities)
  ) {
    reasons = withReason(reasons, {
      at,
      signal: "mode",
      text: "Edit activity absorbed: edits not visible for this agent.",
    });
  }
  if (evidence !== null) {
    const alpha = emaFactor(Math.max(0, at - state.internal.modeUpdatedAt)) * evidence.weight;
    weights = blendModeWeights(weights, evidence.target, alpha);
    modeUpdatedAt = Math.max(state.internal.modeUpdatedAt, at);
  }
  return settleDisplayed(state, weights, modeUpdatedAt, at, reasons);
}

/**
 * Re-evaluates the hysteresis at `now` without moving the weights: the
 * 5 s hold can mature while no tool events arrive, so `advance` calls this.
 * The returned working memory keeps the caller's latest `activityUpdatedAt`
 * and `seenActivity` (this runs after the lifecycle settled them); only the
 * mode clock and the hysteresis trackers come from the evaluation.
 */
export function refreshDisplayedMode(
  state: LaneState,
  now: number,
  baseReasons: LaneState["reasons"] = state.reasons,
): ModeResult {
  return settleDisplayed(state, state.mode, state.internal.modeUpdatedAt, now, baseReasons);
}

function settleDisplayed(
  state: LaneState,
  weights: ModeWeights,
  modeUpdatedAt: number,
  now: number,
  baseReasons: LaneState["reasons"],
): ModeResult {
  const next = nextDisplayedMode({
    weights,
    displayed: state.displayedMode,
    challenger: state.internal.modeChallenger,
    challengerSince: state.internal.modeChallengerSince,
    switchedAt: state.internal.modeSwitchedAt,
    now,
  });
  const switched = next.switched && next.displayed !== state.displayedMode;
  const reasons = switched
    ? withReason(baseReasons, {
        at: now,
        signal: "mode",
        text: `Mode changed to ${next.displayed}: ${next.displayed} work dominates.`,
      })
    : baseReasons;
  return {
    mode: weights,
    displayedMode: next.displayed,
    reasons,
    internal: {
      ...state.internal,
      modeUpdatedAt,
      modeSwitchedAt: switched ? now : state.internal.modeSwitchedAt,
      modeChallenger: switched ? null : next.challenger,
      modeChallengerSince: switched ? null : next.challengerSince,
    },
  };
}
