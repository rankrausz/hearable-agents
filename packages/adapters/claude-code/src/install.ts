// packages/adapters/claude-code/src/install.ts — the user-scope installer
// for the Claude Code reference adapter. What this is for: merging Hearable
// hook entries into the `hooks` object of `~/.claude/settings.json` (user
// scope) inside entries tagged with a Hearable marker, idempotently, without
// touching anything the user already configured — and removing exactly what
// was added on uninstall so the file is byte-identical afterwards. What it
// must not do: write any other scope, reformat user content, or leave a
// trace behind. Entries live in the real `hooks` object (not a sidecar key)
// so Claude Code executes them; the marker is a `_hearable` flag on each
// entry Hearable owns, which Claude Code ignores as an unknown field.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstallOptions, InstallResult } from "@hearable/adapter-kit";

/** The settings file, relative to the config dir (Claude Code's `~/.claude`). */
export const SETTINGS_FILE = "settings.json";

/**
 * Sidecar holding the pristine settings bytes from before the first install.
 * The sidecar path is the settings path plus PRISTINE_SIDECAR_SUFFIX. The
 * ABSENT_BASELINE sentinel marks that no file existed: uninstall then
 * removes the file it created so no trace remains. Never overwritten once
 * written, so a changed reinstall still restores the original baseline.
 */
export const PRISTINE_SIDECAR_SUFFIX = "hearable-pristine";

/**
 * Sidecar sentinel marking that no settings file existed before the first
 * install. Uninstall then removes the created file instead of leaving an
 * empty object behind.
 */
export const ABSENT_BASELINE = "absent";

/** Marker flag on every hook entry Hearable owns. */
export const MANAGED_FLAG = "_hearable";

/** Marker value identifying the owning adapter. */
export const MANAGED_MARKER = "hearable:claude-code";

/** Every hook event the adapter observes (docs/EVENTS.md §Claude Code mapping). */
export const MANAGED_EVENTS: readonly string[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
];

export type HookHandler = {
  readonly type: "command";
  readonly command: string;
};

export type HookEntry = {
  readonly matcher?: string;
  readonly hooks: readonly HookHandler[];
  readonly [MANAGED_FLAG]?: string;
};

/**
 * The hook command embedded into the config: the relay plus its two
 * documented argv flags (adapter id, daemon URL). Shell form (no `args`)
 * because the command is one string with flags.
 */
export function hookCommand(relayPath: string, daemonUrl: string): string {
  return `${relayPath} --agent claude-code --url ${daemonUrl}`;
}

/** One managed entry per event: match-all, running the relay. */
export function managedEntry(relayPath: string, daemonUrl: string): HookEntry {
  return {
    matcher: "",
    hooks: [{ type: "command", command: hookCommand(relayPath, daemonUrl) }],
    [MANAGED_FLAG]: MANAGED_MARKER,
  };
}

function settingsPath(configDir: string): string {
  return join(configDir, SETTINGS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("settings.json must contain a single JSON object");
  }
  return parsed;
}

/**
 * Serialises settings deterministically: two-space indent, trailing newline.
 * Deterministic output is what makes idempotence byte-checkable — a second
 * install must produce byte-identical text, not merely equal JSON.
 */
export function serializeSettings(settings: Record<string, unknown>): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function isManagedEntry(value: unknown): value is HookEntry {
  return isRecord(value) && value[MANAGED_FLAG] === MANAGED_MARKER;
}

function hooksOf(settings: Record<string, unknown>): Record<string, unknown[]> {
  const hooks = settings.hooks;
  if (!isRecord(hooks)) {
    return {};
  }
  const entries: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    // Only managed events are array-shaped by contract; anything else
    // (a string, a number, another agent's shape) passes through untouched.
    if (MANAGED_EVENTS.includes(event) && Array.isArray(groups)) {
      entries[event] = [...groups];
    }
  }
  return entries;
}

function pruneManaged(groups: unknown[]): { kept: unknown[]; removed: number } {
  const kept = groups.filter((group) => !isManagedEntry(group));
  return { kept, removed: groups.length - kept.length };
}

async function readPristine(settingsFilePath: string): Promise<string | null> {
  try {
    return await readFile(`${settingsFilePath}.${PRISTINE_SIDECAR_SUFFIX}`, "utf8");
  } catch {
    return null;
  }
}

async function removePristine(settingsFilePath: string): Promise<void> {
  await rm(`${settingsFilePath}.${PRISTINE_SIDECAR_SUFFIX}`, { force: true });
}

/**
 * Installs the Hearable hooks into the user-scope settings file. Idempotent:
 * a second install with the same daemon URL and relay path reports
 * `changed: false` and writes nothing. A settings file that does not exist
 * is created; pre-existing user content (including their own hooks) is kept
 * untouched — Hearable entries merge into the `hooks` object alongside them.
 */
export async function installClaudeCode(
  opts: InstallOptions & { relayPath: string },
): Promise<InstallResult> {
  const path = settingsPath(opts.configDir);
  await mkdir(opts.configDir, { recursive: true });
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = null;
  }
  const wanted = managedEntry(opts.relayPath, opts.daemonUrl);
  const wantedJson = JSON.stringify(wanted);
  if (existing === null) {
    // No baseline: the created file holds only Hearable entries. Marker it
    // so uninstall can remove the file itself and leave no trace.
    const hooks: Record<string, unknown[]> = {};
    for (const event of MANAGED_EVENTS) {
      hooks[event] = [wanted];
    }
    await writeFile(path, serializeSettings({ hooks }), "utf8");
    await writeFile(`${path}.${PRISTINE_SIDECAR_SUFFIX}`, ABSENT_BASELINE, "utf8");
    return { changed: true, summary: "Created settings.json with Hearable hooks." };
  }
  let settings: Record<string, unknown>;
  try {
    settings = parseSettings(existing);
  } catch {
    throw new Error(
      "The Claude Code settings file is not valid JSON. Fix or remove it, then run install again.",
    );
  }
  const managedHooks = hooksOf(settings);
  let changed = false;
  const nextHooks: Record<string, unknown[]> = { ...managedHooks };
  for (const event of MANAGED_EVENTS) {
    const groups = nextHooks[event] ?? [];
    // Exactly one managed entry per event, matching this install's command:
    // drop stale managed entries (a previous daemon URL), keep user groups.
    const { kept } = pruneManaged(groups);
    const wantedIndex = groups.findIndex((g) => JSON.stringify(g) === wantedJson);
    if (
      wantedIndex !== -1 &&
      groups.every((g) => !isManagedEntry(g) || JSON.stringify(g) === wantedJson)
    ) {
      nextHooks[event] = groups;
      continue;
    }
    nextHooks[event] = [...kept, wanted];
    changed = true;
  }
  // Events with no managed entry yet are a change; events already carrying
  // exactly this install's entry are not.
  if (!changed) {
    return { changed: false, summary: "Hearable hooks are already installed." };
  }
  // Non-managed hook values (a string, a number, another agent's shape)
  // pass through untouched: only managed events are rebuilt.
  const mergedHooks: Record<string, unknown> = isRecord(settings.hooks)
    ? { ...settings.hooks }
    : {};
  for (const event of MANAGED_EVENTS) {
    mergedHooks[event] = nextHooks[event];
  }
  const next = serializeSettings({ ...settings, hooks: mergedHooks });
  if (next === existing) {
    return { changed: false, summary: "Hearable hooks are already installed." };
  }
  // Byte-exact uninstall needs the pristine bytes: JSON key order and
  // whitespace cannot be recovered from parsed data. Record them in the
  // sidecar before the first install touches this file and never overwrite
  // an existing sidecar: a changed reinstall (new daemon URL) must still
  // restore the original pre-first-install bytes on uninstall.
  const sidecar = `${path}.${PRISTINE_SIDECAR_SUFFIX}`;
  const hasSidecar = (await readPristine(path)) !== null;
  if (!hasSidecar) {
    await writeFile(sidecar, existing, "utf8");
  }
  await writeFile(path, next, "utf8");
  return { changed: true, summary: "Added Hearable hooks to settings.json." };
}

/**
 * Removes every managed entry so the settings file is byte-identical to how
 * it was before install. A file with no managed entries is left untouched;
 * empty hook groups left behind are removed so no trace remains.
 */
export async function uninstallClaudeCode(opts: InstallOptions): Promise<void> {
  const path = settingsPath(opts.configDir);
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    return;
  }
  let settings: Record<string, unknown>;
  try {
    settings = parseSettings(existing);
  } catch {
    return;
  }
  if (!isRecord(settings.hooks)) {
    return;
  }
  const hooks = hooksOf(settings);
  let removed = 0;
  const nextHooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const { kept, removed: count } = pruneManaged(groups);
    removed += count;
    if (kept.length > 0) {
      nextHooks[event] = kept;
    }
  }
  if (removed === 0) {
    return;
  }
  // Restore byte-exactness: uninstall must return the exact bytes install
  // found. JSON key order and whitespace cannot be recovered from parsed
  // data, so the installer records the pristine bytes before the first
  // install in a sidecar the uninstall reads. The sidecar lives next to
  // settings.json, is never overwritten once written, and is removed by
  // uninstall. ABSENT_BASELINE means no file existed: the created file is
  // removed entirely so no trace remains.
  const remainder: Record<string, unknown> = { ...settings, hooks: nextHooks };
  const pristine = await readPristine(path);
  if (pristine === ABSENT_BASELINE) {
    await rm(path, { force: true });
    await removePristine(path);
    return;
  }
  if (pristine !== null) {
    await writeFile(path, pristine, "utf8");
    await removePristine(path);
    return;
  }
  await writeFile(path, serializeSettings(remainder), "utf8");
}
