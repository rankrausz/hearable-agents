// packages/core/test/index.test.ts — behaviour test for the package entry:
// the schema version constant is re-exported for consumers to pin against.
// Event and capabilities schema behaviour lives in test/events/. This file
// must not re-test schema behaviour or import anything outside packages/core.

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/index.js";

describe("SCHEMA_VERSION", () => {
  it("is exported from the package entry to pin against", () => {
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
