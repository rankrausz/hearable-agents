// packages/adapters/codex/src/adapter.ts — the Codex adapter: the pure
// `map` plus the installer plus `doctor`, wired into the Adapter contract
// with id "codex". What this is for: making Codex CLI sessions observable
// through the same normalized vocabulary as every other agent, honestly
// declaring what the installed Codex version can and cannot tell us. What
// it must not do: import anything from the workspace beyond @hearable/core
// and @hearable/adapter-kit, keep state, or influence the Codex session it
// observes.

import type { Adapter, InstallOptions, InstallResult } from "@hearable/adapter-kit";
import { CODEX_CAPABILITIES } from "./capabilities.js";
import { doctorCodex } from "./doctor.js";
import { installCodex, uninstallCodex } from "./install.js";
import { mapCodexPayload } from "./map.js";

/** The Codex CLI adapter: Claude-shaped hook payloads, Codex-owned extensions. */
export const codexAdapter: Adapter = {
  id: "codex",
  capabilities: CODEX_CAPABILITIES,
  map: mapCodexPayload,
  install: (opts: InstallOptions): Promise<InstallResult> => installCodex(opts),
  uninstall: (opts: InstallOptions): Promise<void> => uninstallCodex(opts),
  doctor: () => doctorCodex(),
};
