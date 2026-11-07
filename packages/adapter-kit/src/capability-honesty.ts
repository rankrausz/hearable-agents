// packages/adapter-kit/src/capability-honesty.ts — the "never emits what its
// capabilities deny" check, implemented for real and pure so the conformance
// runner, the daemon and any adapter can all use it. What this is for:
// enforcing the rule of docs/EVENTS.md §Capabilities — a capability that is
// false or "none" forbids the event kinds it describes, including the
// category-gated tool kinds (an adapter that declares editEvents false must
// not emit tool events with category "edit"). What it must not do: judge
// field-level honesty (an invented durationMs, a made-up target) — that is
// the fixture suite's job, because this check only sees kinds; nor deny
// `notification`, which every adapter may emit because unknown events are
// preserved, never dropped. `agent.report` is MVP-reserved with no capability
// governing it, so it is not judged here either.

import type { AdapterCapabilities, EventKind, NormalizedEvent } from "@hearable/core";

/** One emission that contradicts the adapter's declared capabilities. */
export type CapabilityViolation = {
  /** The capability whose declaration this emission contradicts. */
  readonly capability: keyof AdapterCapabilities;

  /** The denied event kind that was emitted anyway. */
  readonly kind: EventKind;

  /** The id of the offending event, so the report names the exact event. */
  readonly eventId: string;

  /** Plain-language statement of the violation for the conformance report. */
  readonly message: string;
};

function violation(
  capability: keyof AdapterCapabilities,
  kind: EventKind,
  eventId: string,
  detail: string,
): CapabilityViolation {
  return {
    capability,
    kind,
    eventId,
    message: `event "${eventId}" emits "${kind}"${detail}, which capabilities.${capability} denies`,
  };
}

function violationsForEvent(
  capabilities: AdapterCapabilities,
  event: NormalizedEvent,
): readonly CapabilityViolation[] {
  const found: CapabilityViolation[] = [];
  const { kind } = event;

  const deny = (capability: keyof AdapterCapabilities, detail = "") => {
    found.push(violation(capability, kind, event.id, detail));
  };

  if (!capabilities.sessionEvents && (kind === "session.start" || kind === "session.end")) {
    deny("sessionEvents");
  }
  if (capabilities.turnStart === "none" && kind === "turn.start") {
    deny("turnStart");
  }
  if (capabilities.turnEnd === "none" && kind === "turn.end") {
    deny("turnEnd");
  }
  if (
    !capabilities.toolEvents &&
    (kind === "tool.start" || kind === "tool.end" || kind === "tool.fail")
  ) {
    deny("toolEvents");
  }
  if (!capabilities.toolFailures && kind === "tool.fail") {
    deny("toolFailures");
  }
  if (!capabilities.editEvents && event.tool?.category === "edit") {
    deny("editEvents", ' with category "edit"');
  }
  if (!capabilities.execEvents && event.tool?.category === "exec") {
    deny("execEvents", ' with category "exec"');
  }
  if (!capabilities.permissionEvents && kind === "permission.request") {
    deny("permissionEvents");
  }
  if (!capabilities.questionEvents && kind === "question.asked") {
    deny("questionEvents");
  }
  if (!capabilities.subagents && (kind === "subagent.start" || kind === "subagent.end")) {
    deny("subagents");
  }
  if (!capabilities.compaction && kind === "compaction") {
    deny("compaction");
  }

  return found;
}

/**
 * Finds every event whose kind the given capabilities deny. Pure and
 * total: it judges data against data, needs no fixtures, and returns every
 * violation it finds rather than failing on the first.
 */
export function findCapabilityViolations(
  capabilities: AdapterCapabilities,
  events: readonly NormalizedEvent[],
): readonly CapabilityViolation[] {
  return events.flatMap((event) => violationsForEvent(capabilities, event));
}
