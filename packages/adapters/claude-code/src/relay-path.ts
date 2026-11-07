// packages/adapters/claude-code/src/relay-path.ts — where the installed
// hook command points. What this is for: resolving the hearable-hook relay
// file the installer embeds into the hook command, so the measured file is
// the executed file (ADR 0014). What it must not do: copy or build the relay
// — the committed .mjs file is referenced in place.

import { fileURLToPath } from "node:url";

/**
 * Resolves the relay file the installed hooks execute. The relay ships as a
 * single committed .mjs file in @hearable/adapter-kit; installers reference
 * it in place so what runs is what was reviewed.
 */
export function defaultRelayPath(): string {
  return fileURLToPath(import.meta.resolve("@hearable/adapter-kit/src/relay/hearable-hook.mjs"));
}

/** The default daemon URL the installed hooks post to. */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:4876";
