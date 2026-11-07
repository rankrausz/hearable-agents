// Checks visual identity allocation across session lifetimes; must not infer work or audio state.
import { describe, expect, it } from "vitest";
import type { SessionRefView } from "../protocol.js";
import { isDismissible, portraitColors, portraitKey, pruneDismissed } from "./portrait.js";

function session(sessionId: string, agent = "codex"): SessionRefView {
  return { agent, sessionId, name: "same-project", firstSeenAt: 1, lastActivityAt: 1 };
}

describe("portrait colors", () => {
  it("distinguishes sessions from the same harness, including queued sessions beyond the base palette", () => {
    const sessions = Array.from({ length: 10 }, (_, index) => session(`session-${index}`));
    const colors = portraitColors(sessions, new Map());
    expect(colors.size).toBe(10);
    expect(new Set(colors.values()).size).toBe(10);
  });

  it("keeps existing colors when sessions reorder, join, leave, and rejoin", () => {
    const a = session("a");
    const b = session("b");
    const c = session("c");
    const original = portraitColors([a, b], new Map());
    const joined = portraitColors([b, c, a], original);
    expect(joined.get(portraitKey(a))).toBe(original.get(portraitKey(a)));
    expect(joined.get(portraitKey(b))).toBe(original.get(portraitKey(b)));
    const departed = portraitColors([c, b], joined);
    expect(departed.has(portraitKey(a))).toBe(false);
    const rejoined = portraitColors([a, b, c], departed);
    expect(rejoined.get(portraitKey(b))).toBe(original.get(portraitKey(b)));
    expect(rejoined.get(portraitKey(c))).toBe(joined.get(portraitKey(c)));
    expect(new Set(rejoined.values()).size).toBe(3);
  });

  it("does not confuse equal session IDs from different harnesses", () => {
    const sessions = [session("shared"), session("shared", "claude-code")] as const;
    const colors = portraitColors(sessions, new Map());
    expect(colors.size).toBe(2);
    expect(colors.get(portraitKey(sessions[0]))).not.toBe(colors.get(portraitKey(sessions[1])));
  });

  it("chooses the same initial colors regardless of arrival order in a snapshot", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => session(String(index)));
    expect(portraitColors(sessions, new Map())).toEqual(
      portraitColors([...sessions].reverse(), new Map()),
    );
  });
});

describe("dismissing quiet portraits", () => {
  it("allows dismissal only for quiet, stale or finished agents", () => {
    expect(isDismissible("quiet")).toBe(true);
    expect(isDismissible("stale")).toBe(true);
    expect(isDismissible("done")).toBe(true);
    for (const expression of ["working", "waiting", "queued", "unavailable", "editing"]) {
      expect(isDismissible(expression)).toBe(false);
    }
  });

  it("brings a dismissed agent back when it starts working and forgets agents that left", () => {
    const dismissed = new Set(["a", "b", "gone"]);
    const next = pruneDismissed(dismissed, [
      { key: "a", expression: "quiet" },
      { key: "b", expression: "editing" },
    ]);
    expect([...next]).toEqual(["a"]);
  });

  it("keeps the same set when nothing changes", () => {
    const dismissed = new Set(["a"]);
    expect(pruneDismissed(dismissed, [{ key: "a", expression: "quiet" }])).toBe(dismissed);
  });
});
