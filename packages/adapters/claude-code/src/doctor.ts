// packages/adapters/claude-code/src/doctor.ts — the installed-reality
// checks for the Claude Code adapter. What this is for: answering the docs/ARCHITECTURE.md
// §9 open question (HTTP hooks vs command hooks on the installed version),
// reporting version, hook reachability and install state, one diagnostic per
// check with plain-language fixes. What it must not do: change capabilities
// or write config — doctor observes, install acts.

import { execFile } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "@hearable/adapter-kit";
import { CLAUDE_CODE_CAPABILITIES } from "./capabilities.js";
import { MANAGED_EVENTS, MANAGED_MARKER, SETTINGS_FILE } from "./install.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettingsObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function runClaudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.trim().slice(0, 120));
    });
  });
}

function readManagedCommands(settings: Record<string, unknown>): string[] {
  const commands: string[] = [];
  const hooks = settings.hooks;
  if (!isRecord(hooks)) {
    return commands;
  }
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      if (!isRecord(group) || group._hearable !== MANAGED_MARKER) {
        continue;
      }
      const inner = group.hooks;
      if (!Array.isArray(inner)) {
        continue;
      }
      for (const handler of inner) {
        if (isRecord(handler) && typeof handler.command === "string") {
          commands.push(handler.command);
        }
      }
    }
  }
  return commands;
}

/**
 * Parses the daemon URL out of an installed hook command
 * (`<relay> --agent claude-code --url <daemon-url>`). Null when the command
 * is not in the shape this adapter installs.
 */
export function daemonUrlFromCommand(command: string): string | null {
  const match = /--url\s+(\S+)/.exec(command);
  return match?.[1] === undefined || match[1] === "" ? null : match[1];
}

/** Relay path: the first token of the installed hook command. */
export function relayFromCommand(command: string): string | null {
  const first = command.split(/\s+/)[0];
  return first === undefined || first === "" ? null : first;
}

async function relayIsExecutable(relayPath: string): Promise<boolean> {
  try {
    await access(relayPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function daemonIsReachable(daemonUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(new URL("/health", daemonUrl), {
      signal: controller.signal,
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function countManagedEntries(settings: Record<string, unknown>): {
  eventsWithManaged: number;
  stale: number;
} {
  let eventsWithManaged = 0;
  let stale = 0;
  const hooks = settings.hooks;
  if (!isRecord(hooks)) {
    return { eventsWithManaged, stale };
  }
  for (const event of MANAGED_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) {
      continue;
    }
    const managed = groups.filter((group) => isRecord(group) && group._hearable === MANAGED_MARKER);
    if (managed.length > 0) {
      eventsWithManaged += 1;
      stale += Math.max(0, managed.length - 1);
    }
  }
  return { eventsWithManaged, stale };
}

/**
 * Checks the installed Claude Code reality: CLI version, settings install
 * state, hook reachability. One diagnostic per check, including the checks
 * that pass. Never throws: a doctor that crashes is worse than no doctor.
 */
export async function doctorClaudeCode(
  configDir: string = join(process.env.HOME ?? "", ".claude"),
): Promise<readonly Diagnostic[]> {
  const found: Diagnostic[] = [];
  try {
    const version = await runClaudeVersion();
    if (version === null) {
      found.push({
        severity: "fail",
        message: "The Claude Code command line is not on the path.",
        fix: "Install Claude Code, then run hearable install again.",
      });
    } else {
      found.push({ severity: "ok", message: `Claude Code is installed (${version}).` });
    }

    let settingsText: string | null = null;
    try {
      settingsText = await readFile(join(configDir, SETTINGS_FILE), "utf8");
    } catch {
      settingsText = null;
    }
    if (settingsText === null) {
      found.push({
        severity: "fail",
        message: "Hearable hooks are not installed in the Claude Code settings.",
        fix: "Run hearable install to add them.",
      });
    } else {
      let settings: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(settingsText);
        settings = isRecord(parsed) ? parsed : null;
      } catch {
        settings = null;
      }
      if (settings === null) {
        found.push({
          severity: "fail",
          message: "The Claude Code settings file is not valid JSON.",
          fix: "Fix or remove settings.json, then run hearable install again.",
        });
      } else {
        const { eventsWithManaged } = countManagedEntries(settings);
        if (eventsWithManaged === MANAGED_EVENTS.length) {
          found.push({
            severity: "ok",
            message: `Hearable hooks are installed for all ${MANAGED_EVENTS.length} hook events.`,
          });
        } else if (eventsWithManaged === 0) {
          found.push({
            severity: "fail",
            message: "Hearable hooks are not installed in the Claude Code settings.",
            fix: "Run hearable install to add them.",
          });
        } else {
          found.push({
            severity: "fail",
            message: `Hearable hooks are installed for ${eventsWithManaged} of ${MANAGED_EVENTS.length} hook events.`,
            fix: "Run hearable install again to repair the missing entries.",
          });
        }
      }
    }

    // The delivery check reads the installed command hooks: the relay file
    // must be executable and the daemon URL it posts to must answer.
    const installedSettings = settingsText !== null ? parseSettingsObject(settingsText) : null;
    const commands = installedSettings !== null ? readManagedCommands(installedSettings) : [];
    if (commands.length === 0) {
      found.push({
        severity: "fail",
        message: "No Hearable hook command is configured, so no events can reach the daemon.",
        fix: "Run hearable install to add the hook commands.",
      });
    } else {
      const first = commands[0] as string;
      const relay = relayFromCommand(first);
      const daemonUrl = daemonUrlFromCommand(first);
      if (relay !== null && !(await relayIsExecutable(relay))) {
        found.push({
          severity: "fail",
          message: `The hook relay at ${relay} is missing or not executable, so hook events cannot reach the daemon.`,
          fix: "Run hearable install again to point the hooks at the relay.",
        });
      } else if (daemonUrl === null) {
        found.push({
          severity: "fail",
          message: "The installed hook command has no daemon URL, so events have nowhere to go.",
          fix: "Run hearable install again to repair the hook commands.",
        });
      } else if (!(await daemonIsReachable(daemonUrl))) {
        found.push({
          severity: "fail",
          message: `The daemon at ${daemonUrl} did not answer, so hook events are dropped for now.`,
          fix: "Start the daemon with hearable start, then run hearable doctor again.",
        });
      } else {
        found.push({
          severity: "ok",
          message: `Hook events reach the daemon at ${daemonUrl} through the hearable-hook relay.`,
        });
      }
      found.push({
        severity: "ok",
        message: `Observed Claude Code capabilities: editEvents=${CLAUDE_CODE_CAPABILITIES.editEvents}, permissionEvents=${CLAUDE_CODE_CAPABILITIES.permissionEvents}, subagents=${CLAUDE_CODE_CAPABILITIES.subagents}.`,
      });
    }
    return found;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      ...found,
      {
        severity: "fail",
        message: `The Claude Code checks could not run (${reason}).`,
        fix: "Run hearable install again. If the problem continues, report it.",
      },
    ];
  }
}
