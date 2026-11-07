// packages/adapters/claude-code — the reference adapter: turns Claude Code
// hook events into normalized events, installs the hook configuration, and
// reports installed reality. This entry module is the public surface: the
// Adapter implementation plus the documented pieces install, uninstall and
// doctor are built from. It must import only @hearable/core and
// @hearable/adapter-kit from the workspace, and must add no classification
// logic — tool classification belongs to the p1-t01 classifier in core.

import type { Adapter, InstallOptions, InstallResult, MapContext } from "@hearable/adapter-kit";
import type { NormalizedEvent } from "@hearable/core";
import { CLAUDE_CODE_CAPABILITIES } from "./capabilities.js";
import { doctorClaudeCode } from "./doctor.js";
import { installClaudeCode, uninstallClaudeCode } from "./install.js";
import { mapClaudeCode } from "./map.js";
import { defaultRelayPath } from "./relay-path.js";

/** Options install accepts beyond the kit's InstallOptions. */
export type ClaudeCodeInstallOptions = InstallOptions & {
  /** Relay file the hook command executes; defaults to the kit's committed file. */
  readonly relayPath?: string;
};

/** The reference adapter for Claude Code hook events. */
export const claudeCodeAdapter: Adapter = {
  id: "claude-code",
  capabilities: CLAUDE_CODE_CAPABILITIES,
  map(raw: unknown, ctx: MapContext): readonly NormalizedEvent[] {
    return mapClaudeCode(raw, ctx);
  },
  async install(opts: InstallOptions): Promise<InstallResult> {
    const relayPath = (opts as ClaudeCodeInstallOptions).relayPath ?? defaultRelayPath();
    return installClaudeCode({ ...opts, relayPath });
  },
  async uninstall(opts: InstallOptions): Promise<void> {
    await uninstallClaudeCode(opts);
  },
  async doctor() {
    return doctorClaudeCode();
  },
};

export type { Diagnostic } from "@hearable/adapter-kit";
export { CLAUDE_CODE_CAPABILITIES } from "./capabilities.js";
export { doctorClaudeCode } from "./doctor.js";
export type { ClaudeCodeMapContext, LastToolRecord, LastToolRecords } from "./last-tool.js";
export { LAST_TOOL_RECORD_BOUND, nextLastToolRecords, readLastToolName } from "./last-tool.js";
