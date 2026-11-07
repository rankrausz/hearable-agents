// packages/core/test/classify/classify.test.ts — behaviour tests for the
// name-based path of the classifier: the fixture-backed (agent, toolName)
// table with its lowercased fallback, the docs/EVENTS.md §Classification
// shell-command rules, and the three fingerprint rules (edit/read/search by
// normalized path, exec by normalized command). Fingerprint tests here prove
// the acceptance criterion that equal commands with different volatile flags
// fingerprint equal while genuinely different commands do not.

import { describe, expect, it } from "vitest";

import { classify } from "../../src/classify/classify.js";
import type { AgentId, ToolCategory } from "../../src/classify/schema.js";

const CWD = "/home/me/project";

const rowSamples: Array<[AgentId, string, ToolCategory]> = [
  ["claude-code", "Edit", "edit"],
  ["claude-code", "Write", "edit"],
  ["claude-code", "Read", "read"],
  ["claude-code", "Grep", "search"],
  ["claude-code", "Bash", "exec"],
  ["claude-code", "WebFetch", "web"],
  ["claude-code", "TodoWrite", "other"],
];

describe.each(rowSamples)("%s %s resolves to %s via a fixture row", (agent, toolName, category) => {
  it("classifies to the row's category", () => {
    expect(classify({ agent, toolName }).category).toBe(category);
  });
});

describe("lowercased-name fallback", () => {
  it("matches a row when the tool name is lowercased", () => {
    expect(classify({ agent: "claude-code", toolName: "edit" }).category).toBe("edit");
    expect(classify({ agent: "claude-code", toolName: "Read" }).category).toBe("read");
  });

  it("keys by (agent, toolName): an agent without a row for a name falls to other", () => {
    // Codex has no "Bash" row; per-agent keying must not borrow Claude's.
    expect(classify({ agent: "claude-code", toolName: "bash" }).category).toBe("exec");
    expect(classify({ agent: "codex", toolName: "Bash" }).category).toBe("other");
    // Codex's documented shell row still resolves for it.
    expect(classify({ agent: "codex", toolName: "shell" }).category).toBe("exec");
  });
});

describe("mcp__* and unknown names", () => {
  it("classifies mcp__* tools as other", () => {
    expect(classify({ agent: "claude-code", toolName: "mcp__github__get_issue" }).category).toBe(
      "other",
    );
  });

  it("classifies unrecorded names as other, never guessed", () => {
    expect(classify({ agent: "claude-code", toolName: "TotallyUnknownTool" }).category).toBe(
      "other",
    );
    expect(classify({ agent: "cursor", toolName: "Read" }).category).toBe("other");
  });
});

describe("shell-command rules on an exec tool", () => {
  const bash = (command: string) =>
    classify({ agent: "claude-code", toolName: "Bash", toolInput: { command }, cwd: CWD });

  it("refines cat to read with the operand as target", () => {
    const result = bash(`cat ${CWD}/src/app.ts`);
    expect(result.category).toBe("read");
    expect(result.target).toBe("src/app.ts");
  });

  it("refines rg to search", () => {
    const result = bash("rg TODO src/");
    expect(result.category).toBe("search");
  });

  it("refines `sed -i` to edit", () => {
    expect(bash("sed -i s/one/two/ src/app.ts").category).toBe("edit");
  });

  it("refines file-writing redirects to edit", () => {
    expect(bash("echo done > README.md").category).toBe("edit");
  });

  it("refines curl to web", () => {
    expect(bash("curl -sL https://example.com/x").category).toBe("web");
  });

  it("keeps other commands exec with an execKind", () => {
    const result = bash("pytest tests/unit --no-color");
    expect(result.category).toBe("exec");
    expect(result.execKind).toBe("test");
  });

  it("treats a command without a file operation as exec", () => {
    const result = bash("node server.js");
    expect(result.category).toBe("exec");
    expect(result.execKind).toBe("run");
  });
});

describe("fingerprints", () => {
  it("are always 16 hex chars", () => {
    for (const result of [
      classify({
        agent: "claude-code",
        toolName: "Edit",
        toolInput: { file_path: `${CWD}/a.ts` },
        cwd: CWD,
      }),
      classify({
        agent: "claude-code",
        toolName: "Bash",
        toolInput: { command: "vitest run" },
        cwd: CWD,
      }),
      classify({ agent: "claude-code", toolName: "WebFetch" }),
    ]) {
      expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("fingerprint edit-class tools by path relative to cwd", () => {
    const absolute = classify({
      agent: "claude-code",
      toolName: "Edit",
      toolInput: { file_path: `${CWD}/src/app.ts` },
      cwd: CWD,
    });
    const relative = classify({
      agent: "claude-code",
      toolName: "Edit",
      toolInput: { file_path: "src/app.ts" },
      cwd: CWD,
    });
    expect(absolute.fingerprint).toBe(relative.fingerprint);
    expect(absolute).toEqual(relative);
  });

  it("fingerprint read/search tools by path or pattern", () => {
    const read = classify({
      agent: "claude-code",
      toolName: "Read",
      toolInput: { file_path: `${CWD}/src/app.ts` },
      cwd: CWD,
    });
    const grep = classify({
      agent: "claude-code",
      toolName: "Grep",
      toolInput: { pattern: "TODO", path: "src/" },
      cwd: CWD,
    });
    expect(read.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(grep.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(read.fingerprint).not.toBe(
      classify({
        agent: "claude-code",
        toolName: "Read",
        toolInput: { file_path: "src/other.ts" },
        cwd: CWD,
      }).fingerprint,
    );
  });

  it("fingerprint the same exec command the same across volatile flags and whitespace", () => {
    const commands = [
      "vitest run",
      "  vitest  run   --no-color  ",
      "vitest run --color=never --timestamp=1712345678901",
    ];
    const fingerprints = commands.map(
      (command) =>
        classify({ agent: "claude-code", toolName: "Bash", toolInput: { command }, cwd: CWD })
          .fingerprint,
    );
    expect(new Set(fingerprints).size).toBe(1);
  });

  it("normalizes an absolute cwd prefix out of an exec command", () => {
    const absolute = classify({
      agent: "claude-code",
      toolName: "Bash",
      toolInput: { command: `node ${CWD}/src/server.js` },
      cwd: CWD,
    });
    const relative = classify({
      agent: "claude-code",
      toolName: "Bash",
      toolInput: { command: "node src/server.js" },
      cwd: CWD,
    });
    expect(absolute.fingerprint).toBe(relative.fingerprint);
  });

  it("fingerprint genuinely different commands different", () => {
    const run = classify({
      agent: "claude-code",
      toolName: "Bash",
      toolInput: { command: "vitest run" },
    });
    const watch = classify({
      agent: "claude-code",
      toolName: "Bash",
      toolInput: { command: "vitest watch" },
    });
    expect(run.fingerprint).not.toBe(watch.fingerprint);
  });

  it("give web/other a stable identity-based fingerprint", () => {
    expect(classify({ agent: "claude-code", toolName: "WebFetch" }).fingerprint).toBe(
      classify({ agent: "claude-code", toolName: "WebFetch" }).fingerprint,
    );
    expect(classify({ agent: "claude-code", toolName: "WebFetch" }).fingerprint).not.toBe(
      classify({ agent: "claude-code", toolName: "WebSearch" }).fingerprint,
    );
  });
});
