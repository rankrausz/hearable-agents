// packages/adapters/claude-code/src/capabilities.ts — what Claude Code can
// tell us, per docs/EVENTS.md §Capabilities. Claude Code is the reference
// adapter with the richest surface: every capability is observed/true and
// tool kinds resolve by tool name. This module must not branch on runtime
// state; `doctor` reports downgrades as diagnostics, it does not reshape
// these declared values.

import type { AdapterCapabilities } from "@hearable/core";

export const CLAUDE_CODE_CAPABILITIES: AdapterCapabilities = {
  sessionEvents: true,
  turnStart: "observed",
  turnEnd: "observed",
  toolEvents: true,
  toolFailures: true,
  editEvents: true,
  execEvents: true,
  permissionEvents: true,
  questionEvents: true,
  subagents: true,
  compaction: true,
  toolKinds: "byName",
  durations: true,
};
