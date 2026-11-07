// packages/adapters/codex — Codex CLI sessions as normalized events.
// This entry module is the public surface: the adapter object, its
// declared capabilities, the pure payload mapping, the installer helpers
// and the doctor check. It must stay free of test-framework imports so
// runtime consumers (the daemon) never load Vitest.

export { codexAdapter } from "./adapter.js";
export { CODEX_CAPABILITIES } from "./capabilities.js";
export { doctorCodex } from "./doctor.js";
export {
  CODEX_HOOK_EVENTS,
  CODEX_HOOKS_BACKUP_FILE,
  CODEX_HOOKS_FILE,
  HEARABLE_HOOK_MARKER,
  hearableMatcherEntry,
  installCodex,
  readHooksFile,
  uninstallCodex,
} from "./install.js";
export { CODEX_AGENT_ID, mapCodexPayload } from "./map.js";
export type { CodexFields } from "./payloads.js";
export { parseCodexFields } from "./payloads.js";
