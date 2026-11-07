// packages/core/test/classify/samples.test.ts — the task's verification
// sample: one tool per agent (Claude Code Edit, Codex shell pytest, Cursor
// Write, ACP kind: edit) classified through the public entry point and printed
// for a human to read, kept as an assertion test. The report goes to vitest
// stdout; the assertions pin the categories so the sample cannot silently
// regress.

import { describe, expect, it } from "vitest";

import { type ClassifyInput, classify, type ExecKind, type ToolCategory } from "../../src/index.js";

const CWD = "/home/me/project";

// Core runs under the ES2022 lib with no DOM or Node globals, but the test
// runner always provides a real console; route through globalThis so the
// report can print without widening the project's ambient types.
function print(message: string): void {
  (globalThis as unknown as { console: { log: (message: string) => void } }).console.log(message);
}

const samples: Array<{
  label: string;
  input: ClassifyInput;
  expected: { category: ToolCategory; execKind?: ExecKind };
}> = [
  {
    label: "Claude Code Edit",
    input: {
      agent: "claude-code",
      toolName: "Edit",
      toolInput: { file_path: `${CWD}/src/app.ts` },
      cwd: CWD,
    },
    expected: { category: "edit" },
  },
  {
    label: "Codex shell pytest",
    input: {
      agent: "codex",
      toolName: "shell",
      toolInput: { command: "pytest tests/unit --no-color" },
      cwd: CWD,
    },
    expected: { category: "exec", execKind: "test" },
  },
  {
    label: "Cursor Write",
    input: {
      agent: "cursor",
      toolName: "Write",
      toolInput: { file_path: `${CWD}/README.md` },
      cwd: CWD,
    },
    expected: { category: "edit" },
  },
  {
    label: "ACP kind edit",
    input: {
      agent: "acp",
      toolName: "",
      kind: "edit",
      toolInput: { path: `${CWD}/src/app.ts` },
      cwd: CWD,
    },
    expected: { category: "edit" },
  },
];

describe("per-agent sample classifications", () => {
  it("prints one classification per agent for the human", () => {
    const report = samples
      .map(({ label, input }) => `${label} -> ${JSON.stringify(classify(input))}`)
      .join("\n");
    print(`sample classifications\n${report}`);
  });

  it.each(samples)("$label classifies to the expected category", ({ input, expected }) => {
    const result = classify(input);
    expect(result.category).toBe(expected.category);
    expect(result.execKind).toBe(expected.execKind);
  });
});
