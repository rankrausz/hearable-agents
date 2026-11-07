// packages/cli/src/parse.ts — argv parsing for the CLI commands,
// dependency-free on purpose (task p1-t11 notes: three commands do not need a
// parsing framework). What this is for: turning raw argv into one typed
// `Parsed` result — start, install, record, replay, a deferred verb, or a plain-language
// usage error — so `run.ts` never re-interprets flags. What it must not do:
// touch the filesystem, call the daemon, or invent options the task does not
// name.

import type { RedactMode } from "@hearable/daemon";

/**
 * The verbs the full MVP CLI will offer (docs/ARCHITECTURE.md) but Phase 1 does not
 * implement. Each names the phase that owns it, so the "not in this phase"
 * message tells users and the conductor where each verb went instead of
 * leaving a silent stub.
 */
export const DEFERRED_VERBS: Readonly<Record<string, { phase: string; note: string }>> = {
  uninstall: { phase: "1b", note: "the adapter installers" },
  emit: { phase: "1b", note: "the emit adapter" },
  acp: { phase: "1b", note: "the ACP proxy" },
};

/**
 * `record --redact` semantics drift by phase; the CLI only passes the flag
 * through to the recorder (`default` vs `paths` hashing), per docs/EVENTS.md
 * §Redaction.
 */
export type RecordFlags = {
  name: string;
  redact: RedactMode;
  raw: boolean;
  stop: boolean;
};

export type Parsed =
  | { kind: "start" }
  | { kind: "service"; action: ServiceAction }
  | { kind: "doctor" }
  | { kind: "install"; agent?: InstallAgent }
  | { kind: "record"; flags: RecordFlags }
  | { kind: "replay"; files: string[]; speed: number }
  | { kind: "deferred"; verb: string; phase: string; note: string }
  | { kind: "usage-error"; message: string };

export type InstallAgent = "claude-code" | "codex";
export type ServiceAction = "install" | "uninstall" | "status";

/** The one-line deferred-verb answer, naming the owning phase per the task. */
export function deferredVerbMessage(verb: string, phase: string, note: string): string {
  const capitalized = `${verb.charAt(0).toUpperCase()}${verb.slice(1)}`;
  return `${capitalized} is not in this phase; it arrives in Phase ${phase} with ${note}.`;
}

export function parseArgv(argv: readonly string[]): Parsed {
  const verb = argv[0];
  if (verb === undefined) {
    return usageError("Nothing to run. Try: hearable start | install | doctor | record | replay.");
  }
  if (verb === "start") {
    if (argv.length > 1) {
      const extra = argv.slice(1).join(" ");
      return usageError(`Start takes no options, but you passed "${extra}".`);
    }
    return { kind: "start" };
  }
  if (verb === "service") {
    return parseService(argv.slice(1));
  }
  if (verb === "doctor") {
    if (argv.length > 1) {
      return usageError(`Doctor takes no options, but you passed "${argv.slice(1).join(" ")}".`);
    }
    return { kind: "doctor" };
  }
  if (verb === "install") {
    return parseInstall(argv.slice(1));
  }
  if (verb === "record") {
    return parseRecord(argv.slice(1));
  }
  if (verb === "replay") {
    return parseReplay(argv.slice(1));
  }
  const deferred = DEFERRED_VERBS[verb];
  if (deferred !== undefined) {
    return { kind: "deferred", verb, phase: deferred.phase, note: deferred.note };
  }
  return usageError(
    `Unknown command "${verb}". This phase runs: hearable start | install | doctor | record | replay.`,
  );
}

function parseService(rest: readonly string[]): Parsed {
  const action = rest[0];
  if (
    rest.length !== 1 ||
    (action !== "install" && action !== "uninstall" && action !== "status")
  ) {
    return usageError("Service needs one action: install, uninstall or status.");
  }
  return { kind: "service", action };
}

function parseInstall(rest: readonly string[]): Parsed {
  if (rest.length === 0) {
    return { kind: "install" };
  }
  if (rest.length > 1) {
    return usageError("Install accepts one agent at a time: claude-code or codex.");
  }
  const agent = rest[0];
  if (agent === "claude-code" || agent === "codex") {
    return { kind: "install", agent };
  }
  return usageError(`Unknown install agent "${agent}". Supported agents: claude-code, codex.`);
}

function parseRecord(rest: readonly string[]): Parsed {
  let name: string | undefined;
  let redact: RedactMode = "default";
  let raw = false;
  let stop = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "--stop") {
      stop = true;
      continue;
    }
    if (token === "--raw") {
      raw = true;
      continue;
    }
    if (token === "--name" || token.startsWith("--name=")) {
      const inline = token.startsWith("--name=");
      const value = inline ? token.slice("--name=".length) : (rest[index + 1] ?? "");
      if (!inline) {
        index += 1;
      }
      if (value === "") {
        return usageError("Record --name needs a non-empty name to write the recording to.");
      }
      name = value;
      continue;
    }
    if (token === "--redact=paths") {
      redact = "paths";
      continue;
    }
    if (token.startsWith("--redact")) {
      return usageError(
        "Record --redact only accepts =paths, which hashes relative paths. Pass --redact=paths or omit the flag.",
      );
    }
    return usageError(
      `Unknown option "${token}" for record. Supported: --name <name>, --redact=paths, --raw, --stop.`,
    );
  }
  if (name === undefined) {
    return usageError("Record needs --name <name> to write the recording to.");
  }
  if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") {
    return usageError(
      `Recording name "${name}" must be letters, numbers, dots and dashes only, so the file stays inside fixtures-local/.`,
    );
  }
  return { kind: "record", flags: { name, redact, raw, stop } };
}

function parseReplay(rest: readonly string[]): Parsed {
  const files: string[] = [];
  let speed = 1;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "--speed" || token.startsWith("--speed=")) {
      const inline = token.startsWith("--speed=");
      const value = inline ? token.slice("--speed=".length) : (rest[index + 1] ?? "");
      if (!inline) {
        index += 1;
      }
      const parsed = Number(value);
      if (value === "" || !Number.isFinite(parsed) || parsed <= 0) {
        return usageError(
          `Replay --speed needs a number greater than zero, got "${value}". Pass --speed 10 to play ten times faster.`,
        );
      }
      speed = parsed;
      continue;
    }
    if (token.startsWith("--")) {
      return usageError(
        `Unknown option "${token}" for replay. Supported: <file...> and --speed <number>.`,
      );
    }
    files.push(token);
  }
  if (files.length === 0) {
    return usageError("Replay needs at least one recording file. Pass <file...>.");
  }
  return { kind: "replay", files, speed };
}

function usageError(message: string): Parsed {
  return { kind: "usage-error", message };
}
