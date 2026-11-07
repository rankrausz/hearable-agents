// packages/core/src/classify/table.ts — the (agent, toolName) -> category
// lookup over the fixture rows from fixtures/classify/tool-names.json (committed
// as table-data.ts). The table is data, not logic: a new observed tool becomes
// a row in the fixture, never a branch here. Lookup is exact (agent, toolName)
// first, then (agent, lowercased toolName) as docs/EVENTS.md §Classification
// specifies, so shared names that disagree across agents resolve by the
// (agent, toolName) key while casing differences still match. The agent is a
// data key, never a branch: no logic in this module depends on which agent it
// is. The lookups are derived once from immutable rows and never mutated, so
// the module stays free of mutable state.

import type { AgentId } from "../events/schema.js";
import type { ToolNameRow } from "./schema.js";
import { TOOL_NAME_ROWS } from "./table-data.js";

const rows: readonly ToolNameRow[] = TOOL_NAME_ROWS;

function keyOf(agent: AgentId, toolName: string): string {
  return `${agent}\u0000${toolName}`;
}

const byExactKey = new Map<string, ToolNameRow>();
for (const row of rows) {
  byExactKey.set(keyOf(row.agent, row.toolName), row);
}

const byLowercasedKey = new Map<string, ToolNameRow>();
for (const row of rows) {
  const key = keyOf(row.agent, row.toolName.toLowerCase());
  const previous = byLowercasedKey.get(key);
  if (previous !== undefined && previous !== row) {
    // Two rows for the same agent and name differing only in case would make
    // the lowercased-name fallback ambiguous. This is a fixture-data error:
    // fail at load rather than resolve it silently. The generator rejects it
    // too, so this is a guard against hand-editing table-data.ts.
    throw new Error(
      `classify table rows for ${key} disagree only in casing; make the fixture unambiguous`,
    );
  }
  byLowercasedKey.set(key, row);
}

// docs/EVENTS.md §Classification: MCP tool names (mcp__*) classify as `other`
// unless a fixture row says otherwise. classify/classify.ts implements this by
// the same default-as-other rule every unrecorded name gets; this comment is
// where the mcp__* rule lives as a named rule instead of being spread into
// logic.
export function findToolNameRow(agent: AgentId, toolName: string): ToolNameRow | undefined {
  return (
    byExactKey.get(keyOf(agent, toolName)) ??
    byLowercasedKey.get(keyOf(agent, toolName.toLowerCase()))
  );
}
