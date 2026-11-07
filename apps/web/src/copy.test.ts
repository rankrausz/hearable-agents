// apps/web/src/copy.test.ts — the queued-session statement (p7b-t03): the
// console says why a session beyond the cap is silent.

import { describe, expect, it } from "vitest";
import { queuedExplanation } from "./copy.js";

describe("queued explanation", () => {
  it("says all lanes are taken and the agent is not heard", () => {
    expect(queuedExplanation(4, 1)).toBe(
      "All four lanes are in use, so this agent is tracked but not heard. It takes the next lane that frees.",
    );
  });

  it("speaks for several queued agents", () => {
    expect(queuedExplanation(4, 2)).toBe(
      "All four lanes are in use, so these agents are tracked but not heard. Each takes the next lane that frees.",
    );
  });

  it("names the configured lane count, including one lane", () => {
    expect(queuedExplanation(3, 1)).toContain("All three lanes are in use");
    expect(queuedExplanation(1, 1)).toContain("The one lane is in use");
  });
});
