// packages/adapter-kit/test/tool-starts.test.ts — behaviour tests for the
// pending-tool-start bookkeeping helpers: exact matching by the agent's tool
// call id where both sides carry one, FIFO per session and tool name
// otherwise, and purity throughout (the docs/EVENTS.md §Claude Code mapping
// rule, shared by the claude-shaped family).

import { describe, expect, it } from "vitest";

import type { PendingToolStart, PendingToolStarts } from "../src/adapter.js";
import { findToolStart, forgetToolStart, rememberToolStart } from "../src/tool-starts.js";

const bashStart: PendingToolStart = {
  sessionId: "s1",
  toolName: "Bash",
  toolUseId: "toolu_1",
  startedAt: 100,
};

const bashStartNoId: PendingToolStart = { sessionId: "s1", toolName: "Bash", startedAt: 150 };

const editStart: PendingToolStart = { sessionId: "s1", toolName: "Edit", startedAt: 200 };

const otherSessionBash: PendingToolStart = {
  sessionId: "s2",
  toolName: "Bash",
  startedAt: 250,
};

const twoStarts: PendingToolStarts = [bashStartNoId, editStart];

describe("pending tool start bookkeeping", () => {
  it("finds a start by the agent's tool call id when both carry one", () => {
    const pending = [bashStartNoId, { ...bashStart, startedAt: 125 }];
    expect(
      findToolStart(pending, { sessionId: "s1", toolName: "Bash", toolUseId: "toolu_1" }),
    ).toMatchObject({ startedAt: 125 });
  });

  it("falls back to the oldest start per session and tool name", () => {
    const pending = [bashStartNoId, { ...bashStartNoId, startedAt: 175 }];
    expect(findToolStart(pending, { sessionId: "s1", toolName: "Bash" })).toMatchObject({
      startedAt: 150,
    });
  });

  it("does not match a different session or tool name", () => {
    expect(findToolStart(twoStarts, { sessionId: "s1", toolName: "WebSearch" })).toBeUndefined();
    expect(findToolStart(twoStarts, { sessionId: "s9", toolName: "Bash" })).toBeUndefined();
  });

  it("remembers a new start without mutating the existing list", () => {
    const next = rememberToolStart(twoStarts, otherSessionBash);
    expect(next.length).toBe(3);
    expect(twoStarts.length).toBe(2);
    expect(findToolStart(next, { sessionId: "s2", toolName: "Bash" })).toBeDefined();
  });

  it("forgets the matched start and keeps the others", () => {
    const next = forgetToolStart([...twoStarts, otherSessionBash], {
      sessionId: "s1",
      toolName: "Edit",
    });
    expect(next).toEqual([bashStartNoId, otherSessionBash]);
  });

  it("leaves the list unchanged when nothing matches to forget", () => {
    const same = forgetToolStart(twoStarts, { sessionId: "s1", toolName: "Grep" });
    expect(same).toBe(twoStarts);
  });
});
