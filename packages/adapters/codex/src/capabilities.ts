// packages/adapters/codex/src/capabilities.ts — the Codex adapter's
// declared capabilities. What this is for: stating honestly what the
// installed Codex version can tell us, per docs/EVENTS.md §Capabilities.
// What it must not do: claim Codex can see file-edit events or turn-end
// reasons without `doctor` proving it. Codex has no SessionEnd (the
// SessionEnd hook is advisory and must not become session.end), and its
// Stop payload carries only a final message, so emissions from those
// payloads stay `inferred`. Edit events default to denied: live probing of
// codex-cli 0.152.1 showed PreToolUse/PostToolUse fire for Bash (and
// apply_patch per docs), and whether file edits are visible is unverified
// until `doctor` observes edit-class tool traffic on the build machine.
// Stop reasons, tool events and failures, subagents and compaction rest on
// documented shapes only — no live payload of those kinds was captured
// (usage limit) — so those defaults are assumptions `doctor` labels, owned
// for verification by the first live Codex session with tool traffic
// (Phase 1b, per ADR 0015).

import type { AdapterCapabilities } from "@hearable/core";

export const CODEX_CAPABILITIES: AdapterCapabilities = {
  sessionEvents: true,
  turnStart: "observed",
  turnEnd: "observed",
  toolEvents: true,
  toolFailures: true,
  editEvents: false,
  execEvents: true,
  permissionEvents: true,
  questionEvents: false,
  subagents: true,
  compaction: true,
  toolKinds: "byName",
  durations: true,
};
