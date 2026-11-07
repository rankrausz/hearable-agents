// packages/adapters/codex/src/install.ts — the Codex hook installer.
// What this is for: writing the hearable-hook relay command into
// `~/.codex/hooks.json` (events at the root, per docs/EVENTS.md §Codex CLI
// mapping) so every mapped Codex hook event reaches the daemon, and
// removing exactly what was added on uninstall. What it must not do:
// touch any other file, reformat or reorder user content, or leave the
// config unparseable: install merges one matcher entry per event and saves
// the exact pre-install bytes to a sidecar backup, and uninstall restores
// those bytes verbatim so the config returns byte-for-byte no matter how
// the user formatted it.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstallOptions, InstallResult } from "@hearable/adapter-kit";

/** The config file the installer owns entries in, relative to configDir. */
export const CODEX_HOOKS_FILE = "hooks.json";

/**
 * The sidecar file, next to the hooks file, holding the exact pre-install
 * bytes. Uninstall restores them verbatim and deletes the sidecar, so a
 * user config with any formatting (compact, key order, indentation,
 * trailing whitespace) returns byte-for-byte.
 */
export const CODEX_HOOKS_BACKUP_FILE = "hooks.json.hearable-backup";

/** Every Codex hook event this adapter listens to. */
export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "Interrupt",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
] as const;

export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

/** Marker every entry this installer writes carries, so uninstall finds it. */
export const HEARABLE_HOOK_MARKER = "hearable";

function hooksFilePath(configDir: string): string {
  return join(configDir, CODEX_HOOKS_FILE);
}

function backupFilePath(configDir: string): string {
  return join(configDir, CODEX_HOOKS_BACKUP_FILE);
}

function relayCommand(daemonUrl: string): string {
  return `hearable-hook --agent codex --url ${daemonUrl}`;
}

/**
 * One matcher entry the installer writes per event: no matcher (match
 * every occurrence) with a single command hook pointing at the relay.
 * The marker lives in a field Codex ignores so hook semantics are
 * untouched.
 */
export function hearableMatcherEntry(daemonUrl: string): Record<string, unknown> {
  return {
    hooks: [
      {
        type: "command",
        command: relayCommand(daemonUrl),
        timeout: 10,
      },
    ],
    hearable: HEARABLE_HOOK_MARKER,
  };
}

function isHearableEntry(entry: unknown, daemonUrl?: string): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  if (record.hearable !== HEARABLE_HOOK_MARKER) {
    return false;
  }
  if (daemonUrl === undefined) {
    return true;
  }
  const hooks = record.hooks;
  if (!Array.isArray(hooks)) {
    return false;
  }
  return hooks.some((hook) => {
    if (hook === null || typeof hook !== "object" || Array.isArray(hook)) {
      return false;
    }
    return (hook as Record<string, unknown>).command === relayCommand(daemonUrl);
  });
}

function parseConfig(text: string): Record<string, unknown> {
  if (text.trim().length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "The Codex hooks file does not hold a JSON object. Move it aside or fix it, then install again.",
    );
  }
  return parsed as Record<string, unknown>;
}

function serializeConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function hooksOf(config: Record<string, unknown>): Record<string, unknown> {
  const hooks = config.hooks;
  if (hooks === undefined) {
    return {};
  }
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(
      "The Codex hooks file holds hooks that are not an object. Move it aside or fix it, then install again.",
    );
  }
  return hooks as Record<string, unknown>;
}

/**
 * Installs the hearable-hook relay into the Codex user-scope hooks file.
 * Idempotent: a second install with the same daemon URL changes nothing
 * and reports `changed: false`. The first install saves the exact
 * pre-install bytes (or the knowledge that the file did not exist) to a
 * sidecar backup, so uninstall restores them verbatim. When the file is
 * missing it is created.
 */
export async function installCodex(opts: InstallOptions): Promise<InstallResult> {
  const path = hooksFilePath(opts.configDir);
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Could not read the Codex hooks file. Check the directory exists and try again. (${path})`,
      );
    }
  }
  const config = existing === null ? {} : parseConfig(existing);
  const hooks = hooksOf(config);
  const entry = hearableMatcherEntry(opts.daemonUrl);
  let changed = false;
  for (const event of CODEX_HOOK_EVENTS) {
    const current = hooks[event];
    const entries = current === undefined ? [] : Array.isArray(current) ? current : null;
    if (entries === null) {
      throw new Error(
        "The Codex hooks file holds a hook event that is not a list. Move it aside or fix it, then install again.",
      );
    }
    if (entries.some((candidate) => isHearableEntry(candidate, opts.daemonUrl))) {
      continue;
    }
    hooks[event] = [...entries, entry];
    changed = true;
  }
  if (existing !== null && !changed) {
    return { changed: false, summary: "Codex hooks are already installed." };
  }
  if (existing === null && !changed) {
    changed = true;
  }
  await mkdir(opts.configDir, { recursive: true });
  await writeBackup(opts.configDir, existing);
  await writeFile(path, serializeConfig({ ...config, hooks }), "utf8");
  return changed
    ? { changed: true, summary: "Installed the Codex hooks." }
    : { changed: false, summary: "Codex hooks are already installed." };
}

/**
 * Records the exact pre-install state for a later verbatim restore: the
 * file bytes when the file existed, or a marker when it did not. Only the
 * first install writes the backup — a reinstall must not overwrite the
 * original bytes with installed ones, or uninstall could never restore
 * the pristine config.
 */
async function writeBackup(configDir: string, existing: string | null): Promise<void> {
  const backupPath = backupFilePath(configDir);
  try {
    await readFile(backupPath, "utf8");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await writeFile(backupPath, existing === null ? "hearable:absent" : existing, "utf8");
}

/**
 * Removes what install added by restoring the exact pre-install bytes
 * from the sidecar backup: the original file verbatim when it existed,
 * or a deleted file when it did not. User formatting (compact JSON, key
 * order, indentation, trailing whitespace) survives the round trip
 * because the bytes are never re-serialized. Entries the user or another
 * tool wrote after install are not preserved — the backup predates them,
 * which the installer states in its summary contract and the README.
 * Without a backup (a foreign install), falls back to removing only the
 * entries carrying the hearable marker.
 */
export async function uninstallCodex(opts: InstallOptions): Promise<void> {
  const path = hooksFilePath(opts.configDir);
  const restored = await restoreFromBackup(opts.configDir, path);
  if (restored) {
    return;
  }
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new Error(
      `Could not read the Codex hooks file. Check the directory exists and try again. (${path})`,
    );
  }
  const config = parseConfig(existing);
  const hooks = hooksOf(config);
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) {
      continue;
    }
    const kept = entries.filter((candidate) => !isHearableEntry(candidate));
    if (kept.length === entries.length) {
      continue;
    }
    if (kept.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = kept;
    }
    changed = true;
  }
  if (!changed) {
    return;
  }
  if (Object.keys(hooks).length === 0) {
    delete config.hooks;
  } else {
    config.hooks = hooks;
  }
  await writeFile(path, serializeConfig(config), "utf8");
}

/**
 * Restores the pre-install state from the sidecar backup: the original
 * bytes verbatim, or a deleted file when no file existed. Deletes the
 * backup afterwards. Returns true when a backup decided the outcome;
 * false when no backup exists and the caller should fall back to
 * marker-based removal.
 */
async function restoreFromBackup(configDir: string, path: string): Promise<boolean> {
  const backupPath = backupFilePath(configDir);
  let backup: string;
  try {
    backup = await readFile(backupPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (backup === "hearable:absent") {
    await rm(path, { force: true });
  } else {
    await writeFile(path, backup, "utf8");
  }
  await rm(backupPath, { force: true });
  return true;
}

/** Reads the hooks file bytes; null when the file does not exist. */
export async function readHooksFile(configDir: string): Promise<string | null> {
  try {
    return await readFile(hooksFilePath(configDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return null;
  }
}
