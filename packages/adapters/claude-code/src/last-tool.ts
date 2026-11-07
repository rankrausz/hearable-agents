// packages/adapters/claude-code/src/last-tool.ts — the adapter's view of the
// kit's bounded last-tool contract. What this is for: giving this package one
// import site for the context type Stop reads (the kit owns the record, the
// fold and the reader — see packages/adapter-kit/src/last-tool.ts). What it
// must not do: duplicate the fold, the bound or the reader — every name here
// re-exports the kit's, so the daemon and the adapter can never drift apart.

export type {
  LastToolContext as ClaudeCodeMapContext,
  LastToolRecord,
  LastToolRecords,
} from "@hearable/adapter-kit";
export {
  LAST_TOOL_RECORD_BOUND,
  nextLastToolRecords,
  readLastToolName,
} from "@hearable/adapter-kit";
