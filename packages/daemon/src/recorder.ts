// packages/daemon/src/recorder.ts — the redacting JSONL recorder. What this
// is for: appending normalized events to a recording file (docs/EVENTS.md
// §Wire format header line first, then one event per line) with redaction by
// default per docs/EVENTS.md §Redaction
// (session ids re-keyed, relative paths and command heads only,
// `lifecycle.message` and tool I/O dropped, `meta` allowlisted), so that
// recordings are safe to commit as fixtures. What it must not do: decide what
// the CLI flags are called (p1-t11 wires these options to argv), read or
// replay files (replayer.ts), or keep anything it dropped — redaction is
// default-deny, an explicit allowlist, never a denylist.
//
// Two deliberate conservative readings of EVENTS.md §Redaction, for p1-t10:
// `tool.target` is kept only for read/search/edit (relative paths) and exec
// (command head); web/other targets are dropped because the doc does not say
// what a safe web/other target looks like. Absolute paths in `target` are
// dropped rather than relativised because the recorder never sees the session
// cwd; adapters already relativise, so an absolute target reaching here is a
// leak, not data.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type NormalizedEvent, NormalizedEventSchema } from "@hearable/core";
import type { Clock } from "./clock.js";
import { formatRecordingHeader } from "./recording.js";

/** How aggressively paths are scrubbed. The CLI passes this through. */
export type RedactMode = "default" | "paths";

export type RecorderOptions = {
  /** The recording file, e.g. `fixtures-local/stuck-auth.jsonl`. */
  filePath: string;
  /** Agent identity for the header line (`claude-code`, `codex`, …). */
  agent: string;
  /**
   * Annotations pointer for the header line. Defaults to the recording file's
   * basename with a trailing `.jsonl` replaced by `.annotations.json`, so the
   * committed header never carries a machine-local absolute path.
   */
  annotations?: string;
  /** `default` keeps relative paths; `paths` hashes them too. */
  redact?: RedactMode;
  /**
   * When true, original payloads passed to `recordRaw` are appended to the
   * `<name>.raw.jsonl` sidecar, which the root gitignore keeps off the
   * machine. Wiring raw payloads in is p1-t11's job; this only exposes it.
   */
  raw?: boolean;
  clock?: Clock;
};

/** Exact membership in a closed vocabulary: unknown values are dropped. */
function isKnownValue(known: ReadonlySet<string>): (value: string | number | boolean) => boolean {
  return (value) => typeof value === "string" && known.has(value);
}

/** Every `meta.kind` value docs/EVENTS.md assigns to a notification. */
const NOTIFICATION_KINDS: ReadonlySet<string> = new Set([
  "unknown",
  "idle_prompt",
  "permission_replied",
  "cancel",
  "streaming",
]);

/** Every hook event name docs/EVENTS.md's mapping tables assign. */
const KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set([
  // Claude Code mapping table.
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
  "AskUserQuestion",
  // Codex mapping table (adds `Interrupt` to the Claude-shaped names).
  "Interrupt",
  // Cursor mapping table.
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "beforeShellExecution",
  "afterShellExecution",
  "afterFileEdit",
  "beforeMCPExecution",
  "afterMCPExecution",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "stop",
]);

/** Every session-start matcher source docs/EVENTS.md names. */
const SESSION_SOURCES: ReadonlySet<string> = new Set([
  "startup",
  "resume",
  "clear",
  "compact",
  "fork",
]);

/** The coarse outcome classes docs/EVENTS.md §Shape contracts. */
const COARSE_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "test_failure",
  "compile_error",
  "not_found",
  "timeout",
  "other",
]);

/** The agent ids docs/EVENTS.md §Shape contracts for `via`. */
const KNOWN_AGENT_IDS: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "acp",
  "emit",
  "replay",
  "sandbox",
  // `via` values EVENTS.md documents beyond the AgentId union.
  "gemini-cli",
  "app",
  "cli",
]);

/**
 * Meta keys the recorder keeps, shaped by every `meta.*` contract in
 * docs/EVENTS.md. Each key additionally names the only values kept, as exact
 * closed vocabularies — never a shape check — so a token-shaped secret under
 * an allowlisted key (e.g. `kind: "sk-live-secret"`) is dropped rather than
 * recorded:
 * - `kind`: the notification kinds EVENTS.md names (`unknown` for unknown
 *   hook events, `idle_prompt`, `permission_replied`, `cancel`, `streaming`).
 * - `hookEvent`: the hook event names EVENTS.md's mapping tables name, for
 *   Claude Code, Codex and Cursor. A future hook name the recorder has not
 *   been taught is dropped; the event itself is still recorded.
 * - `source`: the session-start matcher sources EVENTS.md names (`startup`,
 *   `resume`, `clear`, `compact`).
 * - `turnId`: the Codex turn id, an agent-generated machine id whose exact
 *   format is not contracted, so no exact vocabulary can gate it. Strings are
 *   stored as a 16-hex hash (see `redactTurnId`): turn correlation survives,
 *   arbitrary source text cannot. Numbers pass through unchanged — a number
 *   cannot carry free text.
 */
export const RECORDED_META_KEYS: Readonly<
  Record<string, (value: string | number | boolean) => boolean>
> = {
  kind: isKnownValue(NOTIFICATION_KINDS),
  hookEvent: isKnownValue(KNOWN_HOOK_EVENTS),
  source: isKnownValue(SESSION_SOURCES),
  turnId: (value) => typeof value === "number" || typeof value === "string",
};

export type Recorder = {
  /**
   * Redacts and appends events. Matches the ingest `RecordEvents` seam so the
   * daemon (or the CLI) can plug it in directly. Never throws: a failed write
   * is not the agent's problem.
   */
  record(events: readonly NormalizedEvent[]): void;
  /**
   * Appends one original payload line to the `.raw.jsonl` sidecar. A no-op
   * unless the recorder was created with `raw: true`.
   */
  recordRaw(payloadText: string): void;
  /** The recording file path. */
  readonly filePath: string;
  /** The raw sidecar path, or null when `raw` was not enabled. */
  readonly rawFilePath: string | null;
};

/** Derives the sidecar path: `foo.jsonl` → `foo.raw.jsonl`. */
export function rawSidecarPath(filePath: string): string {
  return filePath.endsWith(".jsonl")
    ? `${filePath.slice(0, -".jsonl".length)}.raw.jsonl`
    : `${filePath}.raw.jsonl`;
}

/**
 * Derives the default annotations pointer for a recording path. Only the
 * file's basename is used, never its directories: with an absolute recording
 * path the committed header would otherwise leak a machine-local path such
 * as /Users/…, contrary to the shareable-recording privacy contract.
 */
export function defaultAnnotationsPath(filePath: string): string {
  const name = basename(filePath);
  return name.endsWith(".jsonl")
    ? `${name.slice(0, -".jsonl".length)}.annotations.json`
    : `${name}.annotations.json`;
}

/**
 * Creates the recorder, writing the header line immediately so the file is a
 * valid recording even if no events ever arrive. Parent directories are
 * created; the file itself is created empty first so a later append cannot
 * land before the header.
 */
export function createRecorder(options: RecorderOptions): Recorder {
  const clock = options.clock ?? Date.now;
  const redact = options.redact ?? "default";
  const annotations = options.annotations ?? defaultAnnotationsPath(options.filePath);
  const rawFilePath = options.raw === true ? rawSidecarPath(options.filePath) : null;
  const rekey = new SessionRekey();
  mkdirSync(dirname(options.filePath), { recursive: true });
  writeFileSync(
    options.filePath,
    `${formatRecordingHeader({ agent: options.agent, recordedAt: clock(), annotations })}\n`,
    "utf8",
  );
  return {
    filePath: options.filePath,
    rawFilePath,
    record(events) {
      try {
        const lines = events.map((event) => JSON.stringify(redactEvent(event, rekey, redact)));
        if (lines.length > 0) {
          appendFileSync(options.filePath, `${lines.join("\n")}\n`, "utf8");
        }
      } catch {
        // Recording must never break the session it observes.
      }
    },
    recordRaw(payloadText) {
      if (rawFilePath === null) {
        return;
      }
      try {
        appendFileSync(rawFilePath, `${payloadText}\n`, "utf8");
      } catch {
        // The sidecar is a debugging aid; losing it beats breaking ingest.
      }
    },
  };
}

/**
 * Redacts one event under default-deny: the output is constructed field by
 * field from explicitly approved inputs, so an unexpected runtime property
 * or a future schema field the recorder has not been taught is dropped by
 * construction rather than carried along. The result is re-validated through
 * the core schema, which also strips nothing — the allowlist above already
 * decided — but fails loudly if the recorder ever builds a misshapen event.
 */
export function redactEvent(
  event: NormalizedEvent,
  rekey: SessionRekey,
  redact: RedactMode,
): NormalizedEvent {
  const redacted = buildRedactedEvent(event, rekey, redact);
  return NormalizedEventSchema.parse(redacted);
}

function buildRedactedEvent(
  event: NormalizedEvent,
  rekey: SessionRekey,
  redact: RedactMode,
): Record<string, unknown> {
  const built = buildKindFields(event, rekey, redact);
  // Tool and lifecycle blocks are allowlisted generically on top of the
  // kind-specific requirements: a block the event carries but the branch
  // above did not require is still rebuilt field by field, never copied.
  // Outcome survives only on tool.end/tool.fail, where the branch set it.
  if (event.tool !== undefined && built.tool === undefined) {
    built.tool = redactToolFields(event.tool, redact);
  }
  if (event.lifecycle !== undefined && built.lifecycle === undefined) {
    built.lifecycle = { reason: event.lifecycle.reason, confidence: event.lifecycle.confidence };
  }
  return built;
}

function buildKindFields(
  event: NormalizedEvent,
  rekey: SessionRekey,
  redact: RedactMode,
): Record<string, unknown> {
  switch (event.kind) {
    case "session.start":
      return {
        ...baseFields(event, rekey),
        kind: event.kind,
        ...(event.meta !== undefined ? { meta: redactMeta(event.meta) } : {}),
      };
    case "session.end":
    case "turn.start":
    case "compaction":
      return {
        ...baseFields(event, rekey),
        kind: event.kind,
      };
    case "turn.end":
      return {
        ...baseFields(event, rekey),
        kind: event.kind,
        lifecycle: { reason: event.lifecycle.reason, confidence: event.lifecycle.confidence },
      };
    case "tool.start":
      return {
        ...baseFields(event, rekey),
        kind: event.kind,
        tool: redactToolFields(event.tool, redact),
      };
    case "tool.end":
    case "tool.fail":
      return {
        ...baseFields(event, rekey),
        kind: event.kind,
        tool: {
          ...redactToolFields(event.tool, redact),
          outcome: redactOutcomeFields(event.tool.outcome),
        },
      };
    case "permission.request":
      return {
        ...baseFields(event, rekey),
        kind: event.kind,
        lifecycle: { reason: "permission" as const, confidence: event.lifecycle.confidence },
      };
    case "question.asked":
      return {
        ...baseFields(event, rekey),
        kind: event.kind,
        lifecycle: { reason: "question" as const, confidence: event.lifecycle.confidence },
      };
    case "notification":
      return {
        ...baseFields(event, rekey),
        kind: event.kind,
        meta: withNotificationKind(redactMeta(event.meta)),
      };
    case "subagent.start":
    case "subagent.end":
      return {
        ...baseFields(event, rekey),
        kind: event.kind,
        parentSessionId: rekey.for(event.parentSessionId),
      };
    case "agent.report":
      return {
        ...baseFields(event, rekey),
        kind: event.kind,
      };
  }
}

// `session.start` carries `source` through the same default-deny meta
// allowlist as notifications (the only non-notification kind whose meta
// the recorder keeps); every other non-notification kind drops meta at the
// boundary. `redactMeta` returns undefined when nothing survived, in which
// case the spread above omits the key entirely.
/**
 * The identity and timing every recorded event keeps. `via` names the wrapped
 * agent (a short machine token like other meta values); anything else on the
 * event — including unknown future fields — is not carried over.
 */
function baseFields(event: NormalizedEvent, rekey: SessionRekey): Record<string, unknown> {
  const base: Record<string, unknown> = {
    v: event.v,
    id: event.id,
    ts: event.ts,
    receivedAt: event.receivedAt,
    agent: event.agent,
    sessionId: rekey.for(event.sessionId),
  };
  if (event.via !== undefined && typeof event.via === "string" && KNOWN_AGENT_IDS.has(event.via)) {
    base.via = event.via;
  }
  if (
    event.parentSessionId !== undefined &&
    event.kind !== "subagent.start" &&
    event.kind !== "subagent.end"
  ) {
    base.parentSessionId = rekey.for(event.parentSessionId);
  }
  return base;
}

/**
 * The tool fields the engine needs: name, category, exec kind, fingerprint,
 * the redacted target, duration. Outcome is added by the caller for
 * tool.end/tool.fail only; tool inputs and outputs never appear here.
 */
function redactToolFields(
  tool: NonNullable<NormalizedEvent["tool"]>,
  redact: RedactMode,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {
    name: tool.name,
    category: tool.category,
    fingerprint: tool.fingerprint,
  };
  if (tool.execKind !== undefined) {
    redacted.execKind = tool.execKind;
  }
  const target = redactTarget(tool.target, tool.category, redact);
  if (target !== undefined) {
    redacted.target = target;
  }
  if (tool.durationMs !== undefined) {
    redacted.durationMs = tool.durationMs;
  }
  return redacted;
}

/** Coarse outcome numbers only: no output text, no raw blobs. */
function redactOutcomeFields(
  outcome: NonNullable<NonNullable<NormalizedEvent["tool"]>["outcome"]>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ok: outcome.ok };
  if (outcome.exitCode !== undefined) {
    redacted.exitCode = outcome.exitCode;
  }
  if (outcome.errorClass !== undefined && COARSE_ERROR_CLASSES.has(outcome.errorClass)) {
    redacted.errorClass = outcome.errorClass;
  }
  if (outcome.testSummary !== undefined) {
    redacted.testSummary = redactTestSummaryFields(outcome.testSummary);
  }
  if (outcome.outputChars !== undefined) {
    redacted.outputChars = outcome.outputChars;
  }
  return redacted;
}

/**
 * Rebuilds the test summary count by count: a runtime-added
 * `testSummary.secret` or a future sensitive count would otherwise serialize
 * by reference alongside the numbers the engine needs.
 */
function redactTestSummaryFields(
  summary: NonNullable<
    NonNullable<NonNullable<NormalizedEvent["tool"]>["outcome"]>["testSummary"]
  > &
    Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  if (typeof summary.passed === "number") {
    redacted.passed = summary.passed;
  }
  if (typeof summary.failed === "number") {
    redacted.failed = summary.failed;
  }
  if (typeof summary.skipped === "number") {
    redacted.skipped = summary.skipped;
  }
  return redacted;
}

/**
 * Keeps relative paths for read/search/edit and the command head for exec;
 * drops everything else (absolute paths, web/other targets). `paths` mode
 * hashes even the relative paths that survive.
 */
function redactTarget(
  target: string | undefined,
  category: string,
  redact: RedactMode,
): string | undefined {
  if (target === undefined || target === "") {
    return undefined;
  }
  let kept: string | undefined;
  if (category === "exec") {
    const head = target.split(/\s+/, 1)[0] ?? "";
    if (head === "") {
      return undefined;
    }
    kept = head.includes("/") ? (head.split("/").pop() ?? head) : head;
  } else if (category === "read" || category === "search" || category === "edit") {
    kept = isAbsolutePath(target) ? undefined : target;
  } else {
    kept = undefined;
  }
  if (kept === undefined) {
    return undefined;
  }
  return redact === "paths" ? hashPath(kept) : kept;
}

/**
 * Default-deny on meta: only allowlisted keys survive, and only when their
 * values match the key's closed shape. A `notification` with no surviving
 * meta still needs its required `meta.kind`, so callers fall back to
 * `{ kind: "unknown" }`.
 */
function redactMeta(
  meta: NormalizedEvent["meta"],
): Record<string, string | number | boolean> | undefined {
  if (meta === undefined) {
    return undefined;
  }
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, accepts] of Object.entries(RECORDED_META_KEYS)) {
    const value = meta[key];
    if (value === undefined || !accepts(value)) {
      continue;
    }
    // `turnId` strings are hashed at the boundary (see `redactTurnId`) so a
    // secret-shaped value can never survive recording; every other key keeps
    // only exact-vocabulary values per RECORDED_META_KEYS.
    kept[key] = key === "turnId" && typeof value === "string" ? redactTurnId(value) : value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * Hashes a Codex turn id so replay and debugging can still correlate turns
 * without recording arbitrary source text. The turn id format is not
 * contracted, so no exact vocabulary can gate it; the hash (same 16-hex
 * shape as fingerprints and path hashes) keeps equality while dropping the
 * value itself.
 */
function redactTurnId(turnId: string): string {
  return createHash("sha256").update(turnId).digest("hex").slice(0, 16);
}

/**
 * `notification` requires `meta.kind` in the schema; a notification whose
 * meta redacted to nothing (or whose kind value was itself hostile) keeps a
 * safe placeholder instead of the original text.
 */
function withNotificationKind(
  meta: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  if (meta === undefined) {
    return { kind: "unknown" };
  }
  if (meta.kind === undefined) {
    return { ...meta, kind: "unknown" };
  }
  return meta;
}

function isAbsolutePath(target: string): boolean {
  return (
    target.startsWith("/") ||
    target.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(target) ||
    target.startsWith("~")
  );
}

/** Hashes a path the way fingerprints hash: sha256, 16 hex chars. */
export function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/** Re-keys session ids to `s1`, `s2`, … in first-seen order, per recording. */
export class SessionRekey {
  private readonly keys = new Map<string, string>();

  for(sessionId: string): string {
    const existing = this.keys.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const next = `s${this.keys.size + 1}`;
    this.keys.set(sessionId, next);
    return next;
  }
}
