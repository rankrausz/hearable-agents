// packages/adapter-kit/test/capability-honesty.test.ts — behaviour tests for
// the "never emits what its capabilities deny" check: every capability rule in
// docs/EVENTS.md §Capabilities denies exactly the kinds it names,
// notifications are never denied, and every violating event is reported.

import type { AdapterCapabilities, EventKind } from "@hearable/core";
import { describe, expect, it } from "vitest";
import { findCapabilityViolations } from "../src/capability-honesty.js";
import { ALL_OBSERVED, minimalEventFor, NOTHING_OBSERVED } from "./doubles.js";

function expectViolation(
  capabilities: AdapterCapabilities,
  kind: EventKind,
  capability: keyof AdapterCapabilities,
  tool?: { name: string; category: "read" | "search" | "edit" | "exec" | "web" | "other" },
): void {
  const violations = findCapabilityViolations(capabilities, [minimalEventFor(kind, tool)]);
  expect(
    violations.map((found) => found.capability),
    `expected ${capability} to deny ${kind}`,
  ).toContain(capability);
}

describe("the capability honesty check", () => {
  it("permits every kind an all-observing adapter may emit", () => {
    const kinds: EventKind[] = [
      "session.start",
      "session.end",
      "turn.start",
      "turn.end",
      "tool.start",
      "tool.end",
      "tool.fail",
      "permission.request",
      "question.asked",
      "notification",
      "subagent.start",
      "subagent.end",
      "compaction",
    ];
    for (const kind of kinds) {
      expect(
        findCapabilityViolations(ALL_OBSERVED, [minimalEventFor(kind)]),
        `expected ${kind} to be permitted`,
      ).toEqual([]);
    }
  });

  it("denies session events when sessionEvents is false", () => {
    expectViolation({ ...ALL_OBSERVED, sessionEvents: false }, "session.start", "sessionEvents");
    expectViolation({ ...ALL_OBSERVED, sessionEvents: false }, "session.end", "sessionEvents");
  });

  it("denies turn starts when turnStart is none", () => {
    expectViolation({ ...ALL_OBSERVED, turnStart: "none" }, "turn.start", "turnStart");
  });

  it("denies turn ends when turnEnd is none", () => {
    expectViolation({ ...ALL_OBSERVED, turnEnd: "none" }, "turn.end", "turnEnd");
  });

  it("denies tool events when toolEvents is false", () => {
    expectViolation({ ...ALL_OBSERVED, toolEvents: false }, "tool.start", "toolEvents");
    expectViolation({ ...ALL_OBSERVED, toolEvents: false }, "tool.end", "toolEvents");
    expectViolation({ ...ALL_OBSERVED, toolEvents: false }, "tool.fail", "toolEvents");
  });

  it("denies tool failures when toolFailures is false", () => {
    expectViolation({ ...ALL_OBSERVED, toolFailures: false }, "tool.fail", "toolFailures");
  });

  it("denies edit-category tool events when editEvents is false", () => {
    expectViolation({ ...ALL_OBSERVED, editEvents: false }, "tool.start", "editEvents", {
      name: "Edit",
      category: "edit",
    });
  });

  it("denies exec-category tool events when execEvents is false", () => {
    expectViolation({ ...ALL_OBSERVED, execEvents: false }, "tool.end", "execEvents", {
      name: "Bash",
      category: "exec",
    });
  });

  it("denies permission requests when permissionEvents is false", () => {
    expectViolation(
      { ...ALL_OBSERVED, permissionEvents: false },
      "permission.request",
      "permissionEvents",
    );
  });

  it("denies questions when questionEvents is false", () => {
    expectViolation({ ...ALL_OBSERVED, questionEvents: false }, "question.asked", "questionEvents");
  });

  it("denies subagent events when subagents is false", () => {
    expectViolation({ ...ALL_OBSERVED, subagents: false }, "subagent.start", "subagents");
    expectViolation({ ...ALL_OBSERVED, subagents: false }, "subagent.end", "subagents");
  });

  it("denies compaction when compaction is false", () => {
    expectViolation({ ...ALL_OBSERVED, compaction: false }, "compaction", "compaction");
  });

  it("never denies a notification, even for a source that observes nothing", () => {
    expect(findCapabilityViolations(NOTHING_OBSERVED, [minimalEventFor("notification")])).toEqual(
      [],
    );
  });

  it("reports every violating event, not just the first", () => {
    const capabilities: AdapterCapabilities = { ...NOTHING_OBSERVED, toolEvents: true };
    const violations = findCapabilityViolations(capabilities, [
      minimalEventFor("session.start"),
      minimalEventFor("tool.fail"),
    ]);
    expect(violations.map((found) => found.capability)).toEqual(["sessionEvents", "toolFailures"]);
  });

  it("names the capability, the kind and the event id in the violation message", () => {
    const [violation] = findCapabilityViolations(NOTHING_OBSERVED, [
      minimalEventFor("session.start"),
    ]);
    expect(violation?.capability).toBe("sessionEvents");
    expect(violation?.kind).toBe("session.start");
    expect(violation?.eventId).toBe("e-session.start");
    expect(violation?.message).toContain("capabilities.sessionEvents denies");
  });
});
