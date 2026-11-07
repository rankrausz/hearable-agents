// packages/daemon/src/ingest.ts — the ingest pipeline: validate → adapt →
// assign lane → record stub → engine/attention → broadcast, with the engine seam
// (`applyToEngine`) at the end (docs/ARCHITECTURE.md §Data flow step 2,
// docs/ARCHITECTURE.md, task p1-t05). What this is for: accepting both wire forms from
// docs/EVENTS.md §Wire format — raw hook payloads routed by `x-hearable-agent`
// through that adapter's pure `map`, and `NormalizedEvent[]` batches — and
// never crashing on malformed input, which goes to the quarantine store. What
// it must not do: write to a recorder (p1-t06 owns that via the `record`
// seam), compute engine/attention state itself, or return an error body: the server
// always answers 204.

import type { LastToolRecords, MapContext, PendingToolStart } from "@hearable/adapter-kit";
import { forgetToolStart, nextLastToolRecords, rememberToolStart } from "@hearable/adapter-kit";
import type { NormalizedEvent } from "@hearable/core";
import { NormalizedEventSchema } from "@hearable/core";
import type { AdapterRegistry } from "./adapters.js";
import type { Broadcaster } from "./broadcast.js";
import type { Clock } from "./clock.js";
import type { LaneRender } from "./engine.js";
import { type FocusTarget, focusCapture, parseFocusOrigin } from "./focus-origin.js";
import type { LaneManager } from "./lanes.js";
import type { QuarantineStore } from "./quarantine.js";
import type { Sessions } from "./sessions.js";

export type ApplyToEngine = (events: readonly NormalizedEvent[], now: number) => void;

/** The record seam; the recorder (p1-t06) plugs in here. */
export type RecordEvents = (events: readonly NormalizedEvent[]) => void;

/**
 * The raw-record seam: receives each accepted raw wire-form body's original
 * text, for the `--raw` sidecar. The CLI (p1-t11) wires the recorder's
 * `recordRaw` here; the daemon never interprets the text.
 */
export type RecordRawEvents = (payloadText: string) => void;

export type IngestOptions = {
  readonly adapters: AdapterRegistry;
  readonly sessions: Sessions;
  readonly lanes: LaneManager;
  readonly quarantine: QuarantineStore;
  readonly broadcaster: Broadcaster;
  readonly clock: Clock;
  readonly record?: RecordEvents;
  readonly recordRaw?: RecordRawEvents;
  readonly applyToEngine?: ApplyToEngine;
  readonly engineSignals?: () => readonly LaneRender[];
  readonly engineCalm?: () => number;
};

export type Ingest = {
  /**
   * Processes one POST /events body. `bodyText` is null when the body
   * exceeded the daemon's size limit and was never read fully. Returns a
   * human-readable quarantine reason when the body was quarantined (so the
   * server and tests can inspect it), or null when everything ingested
   * cleanly. Never throws.
   */
  handlePostEvents(args: {
    normalized: boolean;
    agentHeader: string | null;
    bodyText: string | null;
    focusHeader?: string | null;
  }): string | null;
};

export function createIngest(options: IngestOptions): Ingest {
  const record = options.record ?? noopRecord;
  const recordRaw = options.recordRaw ?? noopRecordRaw;
  const applyToEngine = options.applyToEngine ?? noopApply;
  const captureFocus = focusCapture();
  const pendingStarts = new PendingStartsStore();
  const lastTools = new LastToolStore();
  return {
    handlePostEvents({ normalized, agentHeader, bodyText, focusHeader }) {
      if (bodyText === null) {
        options.quarantine.add({
          agent: agentHeader,
          normalized,
          reason: "body exceeded the daemon's size limit and was not read",
          bodySnippet: "",
        });
        return "body exceeded the daemon's size limit and was not read";
      }
      if (normalized && agentHeader !== null) {
        options.quarantine.add({
          agent: agentHeader,
          normalized: true,
          reason:
            "Both x-hearable-normalized and x-hearable-agent were present; send exactly one wire form.",
          bodySnippet: bodyText,
        });
        return "both x-hearable-normalized and x-hearable-agent were present; send exactly one wire form";
      }
      try {
        const origin = parseFocusOrigin(focusHeader ?? null);
        // Start capture before acknowledging the short-lived hook, without awaiting OS I/O.
        const focus = origin ? captureFocus(origin) : undefined;
        if (normalized) {
          return ingestNormalized(bodyText, agentHeader, options, record, applyToEngine, focus);
        }
        return ingestRaw(
          bodyText,
          agentHeader,
          options,
          pendingStarts,
          lastTools,
          record,
          recordRaw,
          applyToEngine,
          focus,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        options.quarantine.add({
          agent: agentHeader,
          normalized,
          reason: `ingest failed unexpectedly: ${reason}`,
          bodySnippet: bodyText,
        });
        return `unexpected ingest failure: ${reason}`;
      }
    },
  };
}

function ingestNormalized(
  bodyText: string,
  agentHeader: string | null,
  options: IngestOptions,
  record: RecordEvents,
  applyToEngine: ApplyToEngine,
  focus?: Promise<FocusTarget>,
): string | null {
  const { quarantine } = options;
  const parsed = parseJson(bodyText);
  if (parsed === null) {
    quarantine.add({
      agent: agentHeader,
      normalized: true,
      reason: "body was not valid JSON",
      bodySnippet: bodyText,
    });
    return "body was not valid JSON";
  }
  if (!Array.isArray(parsed)) {
    quarantine.add({
      agent: agentHeader,
      normalized: true,
      reason: "normalized body must be an array of events",
      bodySnippet: bodyText,
    });
    return "normalized body must be an array of events";
  }
  const events: NormalizedEvent[] = [];
  for (const candidate of parsed) {
    const stamped = stampAndValidate(candidate, options.clock());
    if (stamped === null) {
      quarantine.add({
        agent: agentHeader,
        normalized: true,
        reason: `an event did not match the normalized schema: ${schemaError(candidate)}`,
        bodySnippet: JSON.stringify(candidate),
      });
      return "an event did not match the normalized schema";
    }
    events.push(stamped);
  }
  applyIngest(events, options, record, applyToEngine, null, focus);
  return null;
}

function ingestRaw(
  bodyText: string,
  agentHeader: string | null,
  options: IngestOptions,
  pendingStarts: PendingStartsStore,
  lastTools: LastToolStore,
  record: RecordEvents,
  recordRaw: RecordRawEvents,
  applyToEngine: ApplyToEngine,
  focus?: Promise<FocusTarget>,
): string | null {
  const { adapters, quarantine, clock } = options;
  if (agentHeader === null) {
    quarantine.add({
      agent: null,
      normalized: false,
      reason: "missing x-hearable-agent routing header",
      bodySnippet: bodyText,
    });
    return "missing x-hearable-agent routing header";
  }
  const adapter = adapters.get(agentHeader);
  if (adapter === undefined) {
    quarantine.add({
      agent: agentHeader,
      normalized: false,
      reason: `no adapter registered for agent "${agentHeader}"`,
      bodySnippet: bodyText,
    });
    return `no adapter registered for agent "${agentHeader}"`;
  }
  const parsed = parseJson(bodyText);
  if (parsed === null) {
    quarantine.add({
      agent: agentHeader,
      normalized: false,
      reason: "body was not valid JSON",
      bodySnippet: bodyText,
    });
    return "body was not valid JSON";
  }

  const receivedAt = clock();
  const { ctx, cwd } = mapContextFor(
    parsed,
    pendingStarts,
    lastTools,
    receivedAt,
    options.sessions,
  );
  let mapped: readonly NormalizedEvent[];
  try {
    mapped = adapter.map(parsed, ctx);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    quarantine.add({
      agent: agentHeader,
      normalized: false,
      reason: `adapter.map threw: ${reason}`,
      bodySnippet: bodyText,
    });
    return `adapter.map threw: ${reason}`;
  }
  const events: NormalizedEvent[] = [];
  for (const candidate of mapped) {
    const stamped = stampAndValidate(candidate, receivedAt);
    if (stamped === null) {
      quarantine.add({
        agent: agentHeader,
        normalized: false,
        reason: `adapter produced an event that did not match the schema: ${schemaError(candidate)}`,
        bodySnippet: JSON.stringify(candidate),
      });
      return "adapter produced an event that did not match the schema";
    }
    events.push(stamped);
  }
  retainPendingToolStarts(events, pendingStarts);
  retainLastToolRecords(events, lastTools);
  // The payload cwd names the session (cwd basename via setCwd). It must land
  // inside applyIngest before the broadcast, so a live browser never sees the
  // session id as the lane name until reconnect.
  applyIngest(events, options, record, applyToEngine, cwd, focus);
  // The raw wire form's original text reaches the --raw sidecar here, on the
  // accepted path only: a quarantined body is a problem to keep, not a
  // payload to preserve verbatim.
  recordRaw(bodyText);
  return null;
}

/** Stamps receivedAt from the daemon clock and validates the shape. */
function stampAndValidate(candidate: unknown, receivedAt: number): NormalizedEvent | null {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const stamped = { ...(candidate as Record<string, unknown>), receivedAt };
  const result = NormalizedEventSchema.safeParse(stamped);
  return result.success ? result.data : null;
}

function schemaError(candidate: unknown): string {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return "not an object";
  }
  const result = NormalizedEventSchema.safeParse({ ...(candidate as Record<string, unknown>) });
  if (result.success) {
    return "unknown";
  }
  return result.error.issues
    .slice(0, 1)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
    .join("; ");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The daemon's side of map purity: one context per session, threaded here.
 * The payload's own cwd wins when present; otherwise the session's stored cwd
 * (recorded from an earlier raw payload of the same session) is the fallback,
 * so a later raw event without cwd still gets path-relative fingerprints
 * against the right working directory. The bounded last-tool list travels on
 * the same context so Stop can apply the documented "last tool was a
 * question tool" rule after that tool already completed.
 */
function mapContextFor(
  raw: unknown,
  pendingStarts: PendingStartsStore,
  lastTools: LastToolStore,
  receivedAt: number,
  sessions: Sessions,
): { ctx: MapContext & { lastToolRecords: LastToolRecords }; cwd: string | null } {
  const sessionId = extractSessionId(raw) ?? "unknown";
  const record = sessions.get(sessionId);
  const payloadCwd = extractStringField(raw, "cwd");
  const cwd = payloadCwd ?? record?.cwd ?? "/";
  return {
    ctx: {
      receivedAt,
      cwd,
      pendingToolStarts: pendingStarts.for(sessionId),
      lastToolRecords: lastTools.for(sessionId),
    },
    cwd: payloadCwd,
  };
}

function extractSessionId(raw: unknown): string | null {
  // Each adapter family names its session field differently; the daemon must
  // pick the per-session pending list before `map` runs (docs/EVENTS.md
  // §Claude Code mapping for the field names).
  for (const key of ["session_id", "sessionID", "sessionId", "conversation_id"]) {
    const value = extractStringField(raw, key);
    if (value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function extractStringField(raw: unknown, key: string): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * Keeps each session's bounded last-tool record in step with the mapped tool
 * events, using the kit's pure fold. The daemon owns this list exactly
 * like the pending starts (docs/EVENTS.md §Claude Code mapping, Stop row):
 * every tool.start/end/fail refreshes it, so a later Stop still sees what
 * ran last after the tool's own end already cleared its pending start.
 */
function retainLastToolRecords(events: readonly NormalizedEvent[], lastTools: LastToolStore): void {
  const touched = new Set<string>();
  for (const event of events) {
    if (event.kind !== "tool.start" && event.kind !== "tool.end" && event.kind !== "tool.fail") {
      continue;
    }
    touched.add(event.sessionId);
  }
  if (touched.size === 0) {
    return;
  }
  const folded = nextLastToolRecords(lastTools.all(), events);
  for (const sessionId of touched) {
    lastTools.retain(sessionId, folded);
  }
}

/**
 * Keeps each session's pending tool starts in step with the mapped tool
 * events, using the kit's pure helpers. The daemon owns these lists, not the
 * adapter (docs/ARCHITECTURE.md §packages/adapter-kit, MapContext docs).
 */
function retainPendingToolStarts(
  events: readonly NormalizedEvent[],
  pendingStarts: PendingStartsStore,
): void {
  for (const event of events) {
    if (event.kind !== "tool.start" && event.kind !== "tool.end" && event.kind !== "tool.fail") {
      continue;
    }
    const { sessionId, tool } = event;
    const match = { sessionId, toolName: tool.name };
    pendingStarts.set(
      sessionId,
      event.kind === "tool.start"
        ? rememberToolStart(pendingStarts.for(sessionId), {
            sessionId,
            toolName: tool.name,
            startedAt: event.ts,
          })
        : forgetToolStart(pendingStarts.for(sessionId), match),
    );
  }
}

/**
 * Registers sessions, assigns lanes, records, broadcasts and runs the Phase 2
 * engine seam, in the order the task fixes: lane allocation happens per event
 * so `session.end` releases its lane in the same batch.
 */
function applyIngest(
  events: readonly NormalizedEvent[],
  options: IngestOptions,
  record: RecordEvents,
  applyToEngine: ApplyToEngine,
  cwd: string | null = null,
  focus?: Promise<FocusTarget>,
): void {
  const { adapters, sessions, lanes, broadcaster, clock } = options;
  for (const event of events) {
    const capabilities = adapters.get(event.agent)?.capabilities ?? null;
    const session = sessions.observe(event, capabilities, event.receivedAt);
    if (focus) session.focus = focus;
    if (cwd !== null) {
      sessions.setCwd(event.sessionId, cwd);
    }
    lanes.accept(event);
    // Both endings remove the session from the registry: a root session ends
    // on session.end, a folded subagent ends on subagent.end. Either way the
    // lane member is gone, and lanes.ts drops a lane key when its last member
    // ends.
    if (event.kind === "session.end" || event.kind === "subagent.end") {
      sessions.remove(event.sessionId);
      continue;
    }
    sessions.touch(event.sessionId, event.receivedAt);
  }
  record(events);
  applyToEngine(events, clock());
  broadcaster.push(events, options.engineSignals?.() ?? undefined, options.engineCalm?.());
}

function noopRecord(): void {}
function noopRecordRaw(): void {}
function noopApply(): void {}

/**
 * Per-session pending tool starts, owned by the daemon and shared with
 * adapters through MapContext between `map` calls.
 */
class PendingStartsStore {
  private readonly bySession = new Map<string, PendingToolStart[]>();

  /** The current pending list for `sessionId`, auto-created empty. */
  for(sessionId: string): readonly PendingToolStart[] {
    const existing = this.bySession.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: PendingToolStart[] = [];
    this.bySession.set(sessionId, fresh);
    return fresh;
  }

  /** Replaces the list; sees the store's own array so callers stay pure. */
  set(sessionId: string, next: readonly PendingToolStart[]): void {
    this.bySession.set(sessionId, [...next]);
  }
}

/**
 * Per-session bounded last-tool records, owned by the daemon and threaded
 * through MapContext with the pending starts. The fold itself is the kit's
 * pure `nextLastToolRecords`; this store only holds the folded list between
 * `map` calls so adapters stay pure.
 */
class LastToolStore {
  private records: LastToolRecords = [];

  /** The current folded list, filtered to one session for the context. */
  for(sessionId: string): LastToolRecords {
    return this.records.filter((entry) => entry.sessionId === sessionId);
  }

  /** Every folded record, for the adapter's pure fold input. */
  all(): LastToolRecords {
    return this.records;
  }

  /**
   * Writes back the folded list after a batch. Sessions whose tool events
   * stopped arriving keep their last entry (that is the point: the record
   * survives the tool's own end); the list stays bounded by the fold.
   */
  retain(_sessionId: string, next: LastToolRecords): void {
    this.records = [...next];
  }
}
