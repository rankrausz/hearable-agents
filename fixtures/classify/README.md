# Classifier fixtures

`tool-names.json` is the single source of truth for the `(agent, toolName)`
category table that `packages/core/src/classify/` uses (see `docs/EVENTS.md`
§Classification). Core embeds it as the generated, committed
`packages/core/src/classify/table-data.ts`; the drift test
(`packages/core/test/classify/fixture-rows.test.ts`) fails whenever the two
disagree.

## Adding a tool

A new observed tool is added here as a row, never as a branch in classifier
logic:

1. Append a row: `{ "agent": <AgentId>, "toolName": <as-is>, "category": ...,
   "verified": <true|false>, "note": <optional> }`.
2. Regenerate the embedded table:
   `node scripts/generate-classify-table.mjs`.
3. Run the core tests so the drift test and the documented-row tests stay green.

`verified: true` means a live agent session confirmed the mapping. `verified:
false` rows are documented assumptions from `docs/EVENTS.md` that the adapter
tasks (`p1-t04`, Phase 1b) must re-check against a real agent before relying on
them; the note says what is still assumed. There is no live agent verification
inside task `p1-t01` itself.

Categories are exactly `read | search | edit | exec | web | other`. The
`execKind` for an `exec` row comes from the command head at classify time, not
from the row. ACP tools are never rows: ACP provides a typed kind that bypasses
name classification entirely.

Mcp tools (`mcp__*`) classify as `other` by the prefix rule, not by a row here.