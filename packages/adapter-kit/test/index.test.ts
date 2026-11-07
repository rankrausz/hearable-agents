// packages/adapter-kit/test/index.test.ts — pins the public surface adapters
// build against: the contract version and the runtime exports of the kit's
// main entry. The Vitest registration layer is deliberately not part of this
// surface; it lives behind the @hearable/adapter-kit/conformance subpath.

import { describe, expect, it } from "vitest";

import {
  ADAPTER_KIT_VERSION,
  CATEGORY_TITLES,
  CONFORMANCE_CATEGORIES,
  findCapabilityViolations,
  findToolStart,
  forgetToolStart,
  parseClaudeShapedHook,
  planConformance,
  rememberToolStart,
} from "../src/index.js";

describe("the adapter-kit public surface", () => {
  it("declares the contract version adapters pin against", () => {
    expect(ADAPTER_KIT_VERSION).toBe(1);
  });

  it("names all seven non-negotiable conformance categories", () => {
    expect([...CONFORMANCE_CATEGORIES]).toEqual([
      "fixture-mapping",
      "installer-idempotence",
      "byte-exact-uninstall",
      "relay-timing",
      "unknown-event-preservation",
      "redaction",
      "capability-honesty",
    ]);
    for (const category of CONFORMANCE_CATEGORIES) {
      expect(CATEGORY_TITLES[category].length).toBeGreaterThan(0);
    }
  });

  it("exposes the shared pure helpers", () => {
    expect(typeof parseClaudeShapedHook).toBe("function");
    expect(typeof findCapabilityViolations).toBe("function");
    expect(typeof planConformance).toBe("function");
    expect(typeof rememberToolStart).toBe("function");
    expect(typeof findToolStart).toBe("function");
    expect(typeof forgetToolStart).toBe("function");
  });
});
