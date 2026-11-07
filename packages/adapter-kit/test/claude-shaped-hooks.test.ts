// packages/adapter-kit/test/claude-shaped-hooks.test.ts — behaviour tests for
// the shared claude-shaped hook parser: it reads the five common fields, is
// total over any input, and never invents a field the payload did not carry.

import { describe, expect, it } from "vitest";

import { parseClaudeShapedHook } from "../src/claude-shaped-hooks.js";

describe("the claude-shaped hooks helper", () => {
  it("reads the five common fields from a well-formed payload", () => {
    const hook = parseClaudeShapedHook({
      session_id: "abc123",
      hook_event_name: "PreToolUse",
      cwd: "/home/user/my-project",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      // Fields the helper must not care about one way or the other.
      permission_mode: "default",
      tool_use_id: "toolu_01",
    });
    expect(hook).toEqual({
      sessionId: "abc123",
      hookEventName: "PreToolUse",
      cwd: "/home/user/my-project",
      toolName: "Bash",
      toolInput: { command: "npm test" },
    });
  });

  it("returns null for every field a payload does not carry", () => {
    expect(parseClaudeShapedHook({})).toEqual({
      sessionId: null,
      hookEventName: null,
      cwd: null,
      toolName: null,
      toolInput: null,
    });
  });

  it("returns null for a field with the wrong type", () => {
    const hook = parseClaudeShapedHook({
      session_id: 42,
      hook_event_name: ["SessionStart"],
      cwd: null,
      tool_name: { name: "Bash" },
      tool_input: "npm test",
    });
    expect(hook).toEqual({
      sessionId: null,
      hookEventName: null,
      cwd: null,
      toolName: null,
      toolInput: null,
    });
  });

  it("returns a null tool_input when it is an array or a primitive", () => {
    expect(parseClaudeShapedHook({ tool_input: ["npm", "test"] }).toolInput).toBeNull();
    expect(parseClaudeShapedHook({ tool_input: 7 }).toolInput).toBeNull();
  });

  it("never throws on malformed input", () => {
    for (const raw of [null, undefined, 7, "SessionStart", [], [{ session_id: "x" }]]) {
      expect(() => parseClaudeShapedHook(raw)).not.toThrow();
      expect(parseClaudeShapedHook(raw).sessionId).toBeNull();
    }
  });
});
