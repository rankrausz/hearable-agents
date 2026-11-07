// packages/adapter-kit/src/conformance/redaction.ts — the check behind the
// redaction conformance cases: events in, recorded lines out,
// forbidden-field assertions. What this is for: proving an adapter's mapped
// events persist none of the secrets its raw payloads held — prompts,
// absolute paths, tool I/O, lifecycle.message text and non-allowlisted meta —
// through the recorder's own redaction. What it must not do: decide what the
// recorded representation is on its own — the recorded lines are built by a
// redaction projection the kit owns and keeps equivalent to the daemon's
// recorder (see below); nor guess which strings are secret — the suite names
// every forbidden string explicitly so a failure says exactly what survived.

import type { NormalizedEvent } from "@hearable/core";
import { NormalizedEventSchema } from "@hearable/core";
import type { RedactionCase } from "./suites.js";

// The recorded-line projection mirrors the daemon recorder contract of
// docs/EVENTS.md §Redaction and ADR 0006 — the shape the daemon's
// `redactEvent` persists as one JSON line per event — transcribed into the
// kit so the conformance check runs through equivalent default-deny rules
// without reaching into the daemon package (which the package boundary
// forbids: adapter-kit may import only @hearable/core from the workspace,
// and the daemon's recorder is synchronous file I/O no pure check may call).
// Session ids are re-keyed per case in first-seen order, `lifecycle.message` and tool I/O
// are dropped, targets keep only relative paths or command heads, and `meta`
// passes a closed allowlist (same key sets the daemon's redacting recorder
// keeps; `turnId` strings hash so turn correlation survives without the
// value). Any behaviour change to the daemon recorder must be mirrored here,
// and the equivalence suite below (`recordedLinesFor` against adversarial
// normalized fields) fails loudly if the projection ever preserves a
// sensitive field the recorder drops.

type RedactMode = "default";

const NOTIFICATION_KINDS: ReadonlySet<string> = new Set([
  "unknown",
  "idle_prompt",
  "permission_replied",
  "cancel",
  "streaming",
]);

const KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set([
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
  "Interrupt",
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

const SESSION_SOURCES: ReadonlySet<string> = new Set([
  "startup",
  "resume",
  "clear",
  "compact",
  "fork",
]);

const COARSE_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "test_failure",
  "compile_error",
  "not_found",
  "timeout",
  "other",
]);

// The `via` values docs/EVENTS.md §Shape contracts — the AgentId union plus
// the wrapped-agent tokens EVENTS.md documents beyond it. Kept as plain
// data, exactly like the recorder's own known-agent set: no branch here
// names an agent, and an unknown `via` is dropped rather than recorded.
const KNOWN_VIA_VALUES: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "acp",
  "emit",
  "replay",
  "sandbox",
  "gemini-cli",
  "app",
  "cli",
]);

function isKnownValue(known: ReadonlySet<string>): (value: string | number | boolean) => boolean {
  return (value) => typeof value === "string" && known.has(value);
}

const RECORDED_META_KEYS: Readonly<Record<string, (value: string | number | boolean) => boolean>> =
  {
    kind: isKnownValue(NOTIFICATION_KINDS),
    hookEvent: isKnownValue(KNOWN_HOOK_EVENTS),
    source: isKnownValue(SESSION_SOURCES),
    turnId: (value) => typeof value === "number" || typeof value === "string",
  };

/** Re-keys session ids to `s1`, `s2`, … in first-seen order, per case. */
class CaseSessionRekey {
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

/**
 * The recorded lines for a redaction case: each event redacted through the
 * recorded-line projection, then one JSON line per event — the shape the
 * recorder persists. Pure and total.
 */
export function recordedLinesFor(events: RedactionCase["events"]): readonly string[] {
  const rekey = new CaseSessionRekey();
  return events.map((event) => JSON.stringify(redactRecordedEvent(event, rekey, "default")));
}

/**
 * Redacts one event the way the recorder persists it: field by field from
 * explicitly approved inputs, so an unexpected runtime property or a future
 * schema field the projection has not been taught is dropped by
 * construction. Re-validated through the core schema.
 */
export function redactRecordedEvent(
  event: NormalizedEvent,
  rekey: { for(sessionId: string): string },
  redact: RedactMode,
): NormalizedEvent {
  return NormalizedEventSchema.parse(buildRedactedEvent(event, rekey, redact));
}

function buildRedactedEvent(
  event: NormalizedEvent,
  rekey: { for(sessionId: string): string },
  redact: RedactMode,
): Record<string, unknown> {
  const built = buildKindFields(event, rekey, redact);
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
  rekey: { for(sessionId: string): string },
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
      return { ...baseFields(event, rekey), kind: event.kind };
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
      return { ...baseFields(event, rekey), kind: event.kind };
  }
}

function baseFields(
  event: NormalizedEvent,
  rekey: { for(sessionId: string): string },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    v: event.v,
    id: event.id,
    ts: event.ts,
    receivedAt: event.receivedAt,
    agent: event.agent,
    sessionId: rekey.for(event.sessionId),
  };
  // `via` names the wrapped agent (a short machine token like other meta
  // values): kept only when it names a value docs/EVENTS.md contracts, so
  // free-text source names cannot survive recording. Anything else on the
  // event — including unknown future fields — is not carried over.
  if (event.via !== undefined && typeof event.via === "string" && KNOWN_VIA_VALUES.has(event.via)) {
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

function redactTarget(
  target: string | undefined,
  category: string,
  redact: RedactMode,
): string | undefined {
  void redact;
  if (target === undefined || target === "") {
    return undefined;
  }
  if (category === "exec") {
    const head = target.split(/\s+/, 1)[0] ?? "";
    if (head === "") {
      return undefined;
    }
    return head.includes("/") ? (head.split("/").pop() ?? head) : head;
  }
  if (category === "read" || category === "search" || category === "edit") {
    return isAbsolutePath(target) ? undefined : target;
  }
  return undefined;
}

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
    kept[key] = key === "turnId" && typeof value === "string" ? redactTurnId(value) : value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function redactTurnId(turnId: string): string {
  // Same 16-hex shape the recorder uses (sha256, truncated): turn
  // correlation survives, the value itself cannot. Implemented without a
  // runtime dependency so the kit's main entry keeps zero runtime deps — the
  // kit's equivalence regression pins this against node:crypto vectors.
  return sha256Hex(turnId).slice(0, 16);
}

// SHA-256 over UTF-8 bytes (FIPS 180-4), self-contained so the kit stays
// dependency-free. Pinned against node:crypto vectors by the equivalence
// regression in test/conformance.test.ts.
function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const schedule = new Uint32Array(64);
  const roundConstants = ROUND_CONSTANTS;

  const wordAt = (words: Uint32Array, index: number): number => words[index] ?? 0;
  const rotateRight = (value: number, bits: number): number =>
    (value >>> bits) | (value << (32 - bits));

  for (let block = 0; block < paddedLength; block += 64) {
    for (let word = 0; word < 16; word += 1) {
      schedule[word] = view.getUint32(block + word * 4);
    }
    for (let word = 16; word < 64; word += 1) {
      const s0 =
        rotateRight(wordAt(schedule, word - 15), 7) ^
        rotateRight(wordAt(schedule, word - 15), 18) ^
        (wordAt(schedule, word - 15) >>> 3);
      const s1 =
        rotateRight(wordAt(schedule, word - 2), 17) ^
        rotateRight(wordAt(schedule, word - 2), 19) ^
        (wordAt(schedule, word - 2) >>> 10);
      schedule[word] = (wordAt(schedule, word - 16) + s0 + wordAt(schedule, word - 7) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let round = 0; round < 64; round += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 =
        (h + sigma1 + choose + wordAt(roundConstants, round) + wordAt(schedule, round)) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

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

/**
 * Checks one redaction case: every event satisfies the normalized event
 * schema, then none of the case's forbidden strings appears anywhere in the
 * recorded lines. Throws with a plain-language message naming the case and
 * the surviving secret. An empty event list fails: vacuous coverage is not
 * coverage.
 */
export function checkRedactionCase(redactionCase: RedactionCase): void {
  if (redactionCase.events.length === 0) {
    throw new Error(
      `redaction case "${redactionCase.name}" supplies no events — register the events the adapter produces (typically its mapped fixture events) so there is something to check`,
    );
  }
  for (const event of redactionCase.events) {
    const result = NormalizedEventSchema.safeParse(event);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(
        `redaction case "${redactionCase.name}": an event does not satisfy the normalized event schema (${issues})`,
      );
    }
  }
  const dumped = recordedLinesFor(redactionCase.events).join("\n");
  for (const forbidden of redactionCase.forbidden) {
    if (forbidden === "") {
      throw new Error(
        `redaction case "${redactionCase.name}": a forbidden string is empty — name the exact secret text (a prompt, a path, tool I/O, a message or a meta value) that must not survive recording`,
      );
    }
    if (dumped.includes(forbidden)) {
      throw new Error(
        `redaction case "${redactionCase.name}": forbidden text ${JSON.stringify(forbidden)} survived recording — the adapter must not emit it`,
      );
    }
  }
}
