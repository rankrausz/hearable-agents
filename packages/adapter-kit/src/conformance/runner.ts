// packages/adapter-kit/src/conformance/runner.ts — the thin Vitest side of
// the conformance kit: registers the planned cases as real Vitest cases for
// one adapter. What this is for: giving every adapter the same one-line
// conformance entry — `registerConformance(myAdapter, mySuites)` at the top of
// a test file. What it must not do: contain any checking logic of its own
// (the pure plan in plan.ts decides and checks; this module only registers),
// or be importable from the package's main entry — it depends on Vitest,
// which runtime consumers of the kit (the daemon, via adapters) must never
// have to load, which is why it is exported only through the
// `@hearable/adapter-kit/conformance` subpath.

import { describe, it } from "vitest";
import type { Adapter } from "../adapter.js";
import { planConformance } from "./plan.js";
import type { ConformanceSuites } from "./suites.js";

/**
 * Registers the adapter's conformance cases with Vitest: every category
 * produces at least one case. Covered cases run the real checks; a category
 * with no suite registers a passing case titled NOT COVERED that also warns,
 * because a suite that is absent must be visible as absent, never silently
 * skipped.
 */
export function registerConformance(adapter: Adapter, suites: ConformanceSuites = {}): void {
  const planned = planConformance(adapter, suites);
  describe(`adapter conformance: ${adapter.id}`, () => {
    for (const testCase of planned) {
      if (testCase.status === "covered") {
        it(testCase.title, testCase.run);
      } else {
        it(`${testCase.title} — NOT COVERED (${testCase.absentReason})`, () => {
          // The warn makes the absent category impossible to miss in the
          // run output, not just in the test list.
          console.warn(
            `[hearable conformance] ${testCase.category}: not covered for adapter "${adapter.id}" — ${testCase.absentReason}`,
          );
        });
      }
    }
  });
}
