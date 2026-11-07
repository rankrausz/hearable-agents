// packages/core/src/engine/capabilities.ts — the capability gate readings the
// lane engine applies. What this is for: the docs/STATE_ENGINE.md §Capability
// table turned into named predicates plus the UI-bound `fidelity` summary
// listing every disabled heuristic in plain words. What it must not do: I/O,
// time, randomness, node:* or workspace imports, or branch on an agent's name
// — every predicate reads the `AdapterCapabilities` value only.
// The narrowest conservative readings chosen here: `turnStart = none` sends
// `idle → active` on the first tool event with confidence `inferred`; a lane
// that goes `turn_complete` on a non-capable lane stays there forever (only a
// `turn.start` event exits it, per the §Lifecycle diagram), never `waiting`;
// with permission and question prompts both invisible, a completed `turn.end`
// whose final message ends in `?` enters `waiting` as inferred, else nothing.

import type { AdapterCapabilities } from "../events/schema.js";

/** Edit churn evidence (struggle) and `editing` mode evidence are visible. */
export function editsVisible(capabilities: AdapterCapabilities): boolean {
  return capabilities.editEvents;
}

/** Tool failures are distinguishable, so failure-based struggle rows can run. */
export function failuresVisible(capabilities: AdapterCapabilities): boolean {
  return capabilities.toolFailures;
}

/** A completed `turn.end` whose final message ends in `?` means waiting. */
export function finalMessageAsks(message: string | undefined): boolean {
  return message?.trimEnd().endsWith("?") === true;
}

/** Permission or question prompts are observable at all. */
export function promptsVisible(capabilities: AdapterCapabilities): boolean {
  return capabilities.permissionEvents || capabilities.questionEvents;
}

/** Explicit permission prompts are observable, so `permission.request` counts. */
export function permissionVisible(capabilities: AdapterCapabilities): boolean {
  return capabilities.permissionEvents;
}

/** Explicit user-directed questions are observable, so `question.asked` counts. */
export function questionVisible(capabilities: AdapterCapabilities): boolean {
  return capabilities.questionEvents;
}

/** Context-compaction prompts are observable, so `compaction` quiets the lane. */
export function compactionVisible(capabilities: AdapterCapabilities): boolean {
  return capabilities.compaction;
}

/** The UI-bound disabled-heuristic summary: null at full fidelity. */
export type FidelitySummary = string | null;

/**
 * The plain-words fidelity summary the UI shows per lane, derived from
 * capabilities only. `null` means full fidelity (nothing hidden). Later tasks
 * (p2-t07 wire-up, p2-t08 rendering) consume but do not reshape this string.
 */
export function fidelitySummary(capabilities: AdapterCapabilities): FidelitySummary {
  const hidden: string[] = [];
  if (!capabilities.editEvents) hidden.push("edits");
  if (!capabilities.toolFailures) hidden.push("failures");
  if (!capabilities.permissionEvents && !capabilities.questionEvents) {
    hidden.push("questions");
  } else {
    if (!capabilities.permissionEvents) hidden.push("permissions");
    if (!capabilities.questionEvents) hidden.push("questions");
  }
  if (!capabilities.compaction) hidden.push("compaction");
  // Only `none` means the evidence is unavailable: `inferred` turn starts
  // and ends are still real evidence the engine accepts (the confidence
  // label, not the fidelity line, carries the difference).
  if (capabilities.turnStart === "none") hidden.push("turn starts");
  if (capabilities.turnEnd === "none") hidden.push("turn ends");
  if (hidden.length === 0) return null;
  if (hidden.length === 1 && hidden[0] !== undefined) return `${hidden[0]} not visible`;
  const last = hidden[hidden.length - 1] as string;
  return `${hidden.slice(0, -1).join(", ")} and ${last} not visible`;
}
