// packages/core/test/events/capabilities.test.ts — behaviour tests for the
// adapter capability declaration in src/events/schema.ts: a complete
// declaration parses, every key is required, and unknown keys are rejected
// with an error distinguishable from a missing key. These tests must stay
// inside core and rely on no adapter.

import { describe, expect, it } from "vitest";

import { type AdapterCapabilities, AdapterCapabilitiesSchema } from "../../src/events/schema.js";

// A complete declaration in the shape docs/EVENTS.md §Capabilities expects of
// a reference adapter; the rejection cases below break it one key at a time.
const fullCapabilities: AdapterCapabilities = {
  sessionEvents: true,
  turnStart: "observed",
  turnEnd: "observed",
  toolEvents: true,
  toolFailures: true,
  editEvents: true,
  execEvents: true,
  permissionEvents: true,
  questionEvents: true,
  subagents: true,
  compaction: true,
  toolKinds: "byName",
  durations: true,
};

function omit(value: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  Object.assign(copy, value);
  delete copy[key];
  return copy;
}

describe("AdapterCapabilities", () => {
  it("accepts a complete declaration unchanged", () => {
    expect(AdapterCapabilitiesSchema.parse(fullCapabilities)).toEqual(fullCapabilities);
  });

  it("requires every key: omitting any one key fails", () => {
    for (const key of Object.keys(fullCapabilities)) {
      const result = AdapterCapabilitiesSchema.safeParse(omit(fullCapabilities, key));
      expect(result.success, `expected rejection when ${key} is missing`).toBe(false);
    }
  });

  it("rejects an unknown key", () => {
    const result = AdapterCapabilitiesSchema.safeParse({ ...fullCapabilities, telemetry: true });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected the declaration to be rejected");
    const codes = result.error.issues.map((issue) => issue.code);
    expect(codes).toContain("unrecognized_keys");
    expect(result.error.issues.some((issue) => issue.message.includes("telemetry"))).toBe(true);
  });

  it("rejects a missing key", () => {
    const result = AdapterCapabilitiesSchema.safeParse(omit(fullCapabilities, "turnStart"));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected the declaration to be rejected");
    expect(result.error.issues.some((issue) => issue.path[0] === "turnStart")).toBe(true);
  });

  it("distinguishes a missing key from an extra key", () => {
    const missing = AdapterCapabilitiesSchema.safeParse(omit(fullCapabilities, "turnStart"));
    const extra = AdapterCapabilitiesSchema.safeParse({ ...fullCapabilities, telemetry: true });
    if (missing.success || extra.success)
      throw new Error("expected both declarations to be rejected");

    const missingCodes = missing.error.issues.map((issue) => issue.code);
    const extraCodes = extra.error.issues.map((issue) => issue.code);
    expect(extraCodes).toContain("unrecognized_keys");
    expect(missingCodes).not.toContain("unrecognized_keys");
    expect(missing.error.issues.some((issue) => issue.path[0] === "turnStart")).toBe(true);
    expect(missing.error.message).not.toBe(extra.error.message);
  });

  it("rejects wrong value types", () => {
    expect(
      AdapterCapabilitiesSchema.safeParse({ ...fullCapabilities, sessionEvents: "yes" }).success,
    ).toBe(false);
    expect(
      AdapterCapabilitiesSchema.safeParse({ ...fullCapabilities, turnStart: "sometimes" }).success,
    ).toBe(false);
    expect(
      AdapterCapabilitiesSchema.safeParse({ ...fullCapabilities, toolKinds: "guessed" }).success,
    ).toBe(false);
  });
});
