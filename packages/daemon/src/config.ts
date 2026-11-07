// packages/daemon/src/config.ts — daemon configuration, validated with zod at
// the process boundary. What this is for: reading the minimal user config
// (~/.config/hearable/config.json) plus caller-provided flag overrides into
// one validated shape, and ensuring the data directory exists. What it must
// not do: grow beyond port, host, lanes, laneReleaseAfterMs and data dir —
// anything a feature needs must be added to this schema deliberately, and the
// file is parsed strictly so an unknown or mistyped key is surfaced to the
// user instead of silently ignored.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LANE_CAP } from "@hearable/core";
import { z } from "zod";

export const DEFAULT_PORT = 4876;

/** The default data directory: user-scope, and gitignored via `.hearable/`. */
export function defaultDataDir(): string {
  return join(homedir(), ".hearable");
}

export const DEFAULT_CONFIG_FILE = join(homedir(), ".config", "hearable", "config.json");

/** The hosts the daemon binds to. Loopback only in this phase: unauthenticated
 * HTTP and WebSocket endpoints must never be exposed beyond the machine. */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1"];

export const DaemonConfigSchema = z.strictObject({
  host: z
    .string()
    .default("127.0.0.1")
    .refine((host) => LOOPBACK_HOSTS.includes(host), {
      message: "the daemon runs on loopback only in this phase; use 127.0.0.1, localhost or ::1",
    }),
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
  // The scene voices LANE_CAP seats; a lane past it would be shown but never
  // heard, so the cap bounds the config too (p7b-t03).
  lanes: z.number().int().min(1).max(LANE_CAP).default(LANE_CAP),
  laneReleaseAfterMs: z.number().int().positive().default(300_000),
  dataDir: z.string().default(defaultDataDir()),
});
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type DaemonConfigOverrides = Partial<z.input<typeof DaemonConfigSchema>>;

/**
 * A user-facing configuration error: what is wrong and what to do about it,
 * in plain language. Callers (the CLI) turn this into the process message.
 */
export class ConfigError extends Error {}

function plainIssue(issue: z.ZodIssue): string {
  const where = issue.path.length > 0 ? ` (field "${issue.path.join(".")}")` : "";
  return `${issue.message}${where}`;
}

/**
 * Loads and validates daemon config. Precedence: built-in defaults, then the
 * config file at `configFile` (default `~/.config/hearable/config.json`) when
 * it exists, then `overrides` (caller-provided flags). The data directory is
 * created if missing. `configFile` and `overrides` are parameters so tests can
 * point at throwaway paths, and the CLI can pass the flags it parses.
 */
export function loadConfig(options?: {
  configFile?: string;
  overrides?: DaemonConfigOverrides;
}): DaemonConfig {
  const filePath = options?.configFile ?? DEFAULT_CONFIG_FILE;
  const fileValues = readConfigFile(filePath);

  const parsed = DaemonConfigSchema.safeParse({
    ...fileValues,
    ...options?.overrides,
  });
  if (!parsed.success) {
    throw new ConfigError(
      `The config file at ${filePath} is not valid: ${parsed.error.issues
        .map(plainIssue)
        .join("; ")}. Fix or remove the file, and try again.`,
    );
  }
  mkdirSync(parsed.data.dataDir, { recursive: true });
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the config file; JSON that is not a single object is refused, and a
 * JSON parse failure is a plain-language error. */
function readConfigFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `Could not read the daemon config at ${filePath}: ${reason}. Fix the file permissions, or use flags instead.`,
    );
  }
  if (text.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `The config file at ${filePath} is not valid JSON: ${reason}. Fix or remove the file, and try again.`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(
      `The config file at ${filePath} must contain a single JSON object, not ${describeJsonValue(parsed)}. Fix or remove the file, and try again.`,
    );
  }
  return parsed;
}

function describeJsonValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return `a ${typeof value}`;
}
