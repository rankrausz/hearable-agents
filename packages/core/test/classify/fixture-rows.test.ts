// packages/core/test/classify/fixture-rows.test.ts — proves the committed core
// table (table-data.ts) is exactly the fixtures/classify/tool-names.json data
// and that every tool name docs/EVENTS.md §Classification documents resolves to
// its documented category. The fixture is the single source of truth for the
// (agent, toolName) table: a row added to the fixture but not to the committed
// table, or a documented tool with no row at all, fails here — which is the
// "adding a row" mechanism working as intended.

import { describe, expect, it } from "vitest";

import toolNamesJson from "../../../../fixtures/classify/tool-names.json" with { type: "json" };
import { classify } from "../../src/classify/classify.js";
import { type AgentId, type ToolCategory, ToolNameTableSchema } from "../../src/classify/schema.js";
import { TOOL_NAME_ROWS } from "../../src/classify/table-data.js";

describe("classifier fixture table", () => {
  it("the committed table-data.ts matches the fixture rows exactly", () => {
    const table = ToolNameTableSchema.parse(toolNamesJson);
    expect(table.schema).toBe(1);
    expect(table.rows).toEqual(TOOL_NAME_ROWS);
  });

  it("every unverified row explains what is still assumed", () => {
    const table = ToolNameTableSchema.parse(toolNamesJson);
    for (const row of table.rows.filter((row) => !row.verified)) {
      expect(row.note, `${row.agent} ${row.toolName} needs an assumption note`).toBeDefined();
    }
  });
});

// Every tool name docs/EVENTS.md §Classification records, with the category the
// doc gives it. The row set can only grow; a name listed here without a fixture
// row classifies as `other` and this test fails, telling the next implementer
// to add the row.
const DOCUMENTED_ROWS: Array<[AgentId, string, ToolCategory]> = [
  ["claude-code", "Read", "read"],
  ["claude-code", "NotebookRead", "read"],
  ["claude-code", "Grep", "search"],
  ["claude-code", "Glob", "search"],
  ["claude-code", "Edit", "edit"],
  ["claude-code", "MultiEdit", "edit"],
  ["claude-code", "Write", "edit"],
  ["claude-code", "NotebookEdit", "edit"],
  ["claude-code", "Bash", "exec"],
  ["claude-code", "WebFetch", "web"],
  ["claude-code", "WebSearch", "web"],
  ["claude-code", "TodoWrite", "other"],
  ["claude-code", "Task", "other"],
  ["codex", "shell", "exec"],
  ["cursor", "Write", "edit"],
];

describe.each(DOCUMENTED_ROWS)("%s %s", (agent, toolName, category) => {
  it(`classifies to its documented category ${category}`, () => {
    expect(classify({ agent, toolName }).category).toBe(category);
  });
});
