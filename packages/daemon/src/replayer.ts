// packages/daemon/src/replayer.ts — file replay through the live ingest
// path. What this is for: reading recording files (docs/EVENTS.md §Wire
// format), rescaling their timestamps by `--speed`, driving the engine clock
// (the injected daemon clock, shared with the replayer) and feeding the
// events through the same `ingest.handlePostEvents` path live events take —
// there is no parallel pipeline. Concurrent replays merge by rescaled time
// and namespace session ids per replay so lanes never collide. What it must
// not do: guess at files it cannot read (an unsupported schema version or a
// malformed line is a loud plain-language error), invent CLI flags (p1-t11
// wires these options to argv), or stream in-flight sessions — file replay
// only. Batch delivery is paced against the wall clock: a batch is fed no
// earlier than its wall-time equivalent, so replayed receivedAt never runs
// ahead of wall time and the daemon's broadcast flush and lane ticker observe
// mid-replay state. Batches already due feed synchronously with no wait.

import { readFileSync } from "node:fs";
import { type NormalizedEvent, NormalizedEventSchema } from "@hearable/core";
import type { Ingest } from "./ingest.js";
import { parseRecordingHeader, RecordingReadError } from "./recording.js";

/**
 * The engine clock, shared between the daemon and the replayer. The daemon
 * reads it (passed as its `Clock`); the replayer advances it to each batch's
 * rescaled time before feeding that batch, so `receivedAt` stamping and the
 * Phase 2 engine seam see replay time, not wall time. When the replay
 * finishes, the replayer hands the clock back with `resumeLive` (see the
 * handoff policy on `ReplayOptions.restoreClock`): leaving a shared clock
 * parked at the final replay timestamp would stamp later live events with
 * replay time and skew lane idle release until wall time catches up.
 */
export type MutableClock = {
  now(): number;
  set(now: number): void;
  /** Returns the clock to live wall time after a replay. */
  resumeLive(): void;
};

/**
 * A wall-clock-backed mutable clock for live-with-replay composition. The
 * daemon reads it as its `Clock`; the replayer drives it during replay and
 * hands it back to wall time afterwards. `wallNow` is injectable so tests
 * can pin the live time they hand back to.
 */
export function createReplayClock(
  initialNow?: number,
  wallNow: () => number = Date.now,
): MutableClock {
  let current = initialNow ?? wallNow();
  return {
    now: () => current,
    set: (now: number) => {
      current = now;
    },
    resumeLive: () => {
      current = wallNow();
    },
  };
}

/**
 * Tracks claimed session namespaces so concurrent and sequential replays
 * against one daemon never share a lane. The daemon composition owns one
 * scope for its lifetime (see `namespacesFor`, which binds a scope to the
 * daemon's ingest the same way `PendingStartsStore` binds pending tool
 * starts per session): every replay through that daemon claims from the same
 * scope, so cross-call uniqueness is automatic and no caller has to remember
 * to wire a scope. A caller-supplied scope still wins when given explicitly,
 * for tests and the offline golden tooling.
 */
export type NamespaceScope = {
  /** Namespaces already claimed through this scope. */
  readonly taken: ReadonlySet<string>;
  /**
   * Claims an explicit namespace. Throws a plain-language error when it is
   * already taken, instead of merging two replays into one lane.
   */
  claim(namespace: string, label: string): void;
  /** Allocates the next free `replay-<n>` default, skipping taken names. */
  claimDefault(): string;
};

/** Creates an empty namespace scope for one daemon's replay lifetime. */
export function createNamespaceScope(): NamespaceScope {
  const taken = new Set<string>();
  let nextDefault = 1;
  return {
    taken,
    claim(namespace: string, label: string): void {
      if (taken.has(namespace)) {
        throw new Error(
          `Cannot replay ${label}: session namespace "${namespace}" is already used by another replay. ` +
            `Choose a different namespace so the two replays never share a lane.`,
        );
      }
      taken.add(namespace);
    },
    claimDefault(): string {
      while (taken.has(`replay-${nextDefault}`)) {
        nextDefault += 1;
      }
      const namespace = `replay-${nextDefault}`;
      nextDefault += 1;
      taken.add(namespace);
      return namespace;
    },
  };
}

/**
 * Returns the namespace scope bound to one ingest instance — one scope for
 * the daemon's lifetime, created on first use. The replayer keys the scope
 * off the `ingest` object (a `WeakMap`, so a discarded composition never
 * pins memory), which is why cross-call uniqueness is automatic for every
 * replay through the same daemon with no caller wiring.
 */
export function namespacesFor(ingest: Pick<Ingest, "handlePostEvents">): NamespaceScope {
  const existing = scopesByIngest.get(ingest);
  if (existing !== undefined) {
    return existing;
  }
  const scope = createNamespaceScope();
  scopesByIngest.set(ingest, scope);
  return scope;
}

const scopesByIngest = new WeakMap<Pick<Ingest, "handlePostEvents">, NamespaceScope>();

export type ReplayerDeps = {
  ingest: Pick<Ingest, "handlePostEvents">;
  clock: MutableClock;
  /**
   * Shared namespace scope. Defaults to the scope bound to this `ingest`
   * instance (one per daemon lifetime via `namespacesFor`), so separate
   * replay calls against the same daemon can never reuse a namespace.
   * Passing an explicit scope overrides that binding, for tests and offline
   * tooling with no daemon composition.
   */
  namespaces?: NamespaceScope;
};

export type ReplayRequest = {
  /** Human label for errors and summaries; the file path when replaying files. */
  label: string;
  /** The full recording file text, header line first. */
  text: string;
  /**
   * Session namespace for this replay; session ids become
   * `<namespace>:<recorded-id>`. Defaults to `replay-<n>` by file order, so
   * concurrent replays never share a lane.
   */
  namespace?: string;
};

export type ReplaySummary = {
  label: string;
  namespace: string;
  agent: string;
  eventCount: number;
  /** Rescaled first/last event times on the engine clock. */
  firstTs: number | null;
  lastTs: number | null;
};

export type ReplayOptions = {
  /**
   * Playback speed multiplier: 10 plays ten times faster than recorded.
   * Must be finite and greater than zero. Defaults to 1.
   */
  speed?: number;
  /**
   * Engine-clock time the earliest event of the replay maps to. Defaults to
   * the clock's current time, so replays land in the present.
   */
  anchorNow?: number;
  /**
   * Clock handoff after the replay. `true` (default): the shared clock is
   * handed back to live wall time with `resumeLive`, so later live events
   * are stamped with wall time and lane idle release measures real idleness
   * from the moment the replay ends. `false`: the clock stays parked at the
   * final replay timestamp, for callers (offline golden tests) that hold no
   * live clock and want to keep asserting on replay time afterwards.
   */
  restoreClock?: boolean;
  /**
   * Pacing hooks, reserved for tests that drive the scheduler and wall clock
   * deterministically. A batch with engine-clock timestamp `replayTs` is due
   * at wall time `anchorWall + (replayTs - anchor)` and feeds synchronously
   * with no wait when already due; a batch due in the future waits out the
   * difference through `sleep`. Live callers leave both unset: the batch
   * spacing on the engine clock paces one-for-one with real wall time.
   */
  wallNow?: () => number;
  /**
   * Waits `ms` wall milliseconds before a batch that is not yet due.
   * Defaults to a real timer; tests inject a fake that advances their
   * deterministic scheduler.
   */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Replays recording files from disk, concurrently: every file is parsed and
 * version-checked first (so a bad file fails before anything is ingested),
 * then all events merge by rescaled timestamp through the live ingest path.
 * Batch delivery is paced against the wall clock (see `ReplayOptions`), so
 * mid-replay daemon state is observable on wall-clock timers.
 */
export async function replayRecordingFiles(
  filePaths: readonly string[],
  deps: ReplayerDeps,
  options?: ReplayOptions,
): Promise<ReplaySummary[]> {
  const requests = filePaths.map((filePath) => ({
    label: filePath,
    text: readRecordingFile(filePath),
  }));
  return replayRecordings(requests, deps, options);
}

/** Replays one recording file from disk. */
export async function replayRecordingFile(
  filePath: string,
  deps: ReplayerDeps,
  options?: ReplayOptions & { namespace?: string },
): Promise<ReplaySummary> {
  const summaries = await replayRecordings(
    [{ label: filePath, text: readRecordingFile(filePath), namespace: options?.namespace }],
    deps,
    options,
  );
  return summaries[0] as ReplaySummary;
}

/**
 * Replays already-read recordings concurrently through the live ingest path.
 * Each replay's session ids are namespaced (`<namespace>:<recorded-id>`,
 * including `parentSessionId`) so two lanes from two files never collide;
 * both files keep their recorded `agent`, so the lanes keep their identity.
 * Namespaces are unique per call and, through the scope bound to the
 * daemon's ingest (`namespacesFor`), across calls: an explicit namespace
 * that is already taken fails with a plain-language error instead of
 * merging two replays into one lane.
 */
export async function replayRecordings(
  requests: readonly ReplayRequest[],
  deps: ReplayerDeps,
  options?: ReplayOptions,
): Promise<ReplaySummary[]> {
  const speed = options?.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new Error(
      `Cannot replay: speed must be a number greater than zero, got ${String(options?.speed)}. ` +
        `Pass --speed 10 to play ten times faster than recorded.`,
    );
  }
  const namespaces = deps.namespaces ?? namespacesFor(deps.ingest);
  const claimed = requests.map((request) => {
    if (request.namespace !== undefined) {
      namespaces.claim(request.namespace, request.label);
      return request.namespace;
    }
    return namespaces.claimDefault();
  });
  const anchor = options?.anchorNow ?? deps.clock.now();
  const parsed = requests.map((request, index) =>
    parseRecording(request, claimed[index] as string, index, speed, anchor),
  );
  const merged = parsed
    .flatMap((file) => file.batches.map((batch) => ({ ...batch, file })))
    .sort((left, right) => left.replayTs - right.replayTs || left.file.index - right.file.index);
  // Pacing: each batch feeds no earlier than its wall-time equivalent
  // `anchorWall + (replayTs - anchor) / 1`, so replayed `receivedAt` never
  // runs ahead of wall time and the daemon's broadcast flush and lane-idle
  // ticker observe mid-replay state. Batches already due (the common case at
  // live speed and above) feed synchronously with no wait.
  const wallNow = options?.wallNow ?? Date.now;
  const sleep = options?.sleep ?? defaultSleep;
  const anchorWall = wallNow();
  try {
    for (const batch of merged) {
      const dueAt = anchorWall + (batch.replayTs - anchor);
      // Rechecked after every wait: a wall clock that jumps backward during
      // a sleep must not let the batch feed while wall time is still earlier
      // than its due time.
      for (;;) {
        const waitMs = dueAt - wallNow();
        if (waitMs <= 0) {
          break;
        }
        await sleep(waitMs);
      }
      deps.clock.set(batch.replayTs);
      const reason = deps.ingest.handlePostEvents({
        normalized: true,
        agentHeader: null,
        bodyText: JSON.stringify(batch.events),
      });
      if (reason !== null) {
        // Unreachable for schema-valid batches unless ingest itself is broken;
        // failing loudly beats silently dropping replayed history.
        throw new Error(
          `Replay of ${batch.file.request.label} stopped: the daemon refused a replayed batch (${reason}).`,
        );
      }
    }
  } finally {
    // Handoff policy: by default the shared clock returns to live wall time,
    // so the next live event after a replay gets a wall `receivedAt` and lane
    // idle timing measures real idleness from here. A failure mid-replay
    // still restores the clock: replay time must never leak into live state.
    if (options?.restoreClock !== false) {
      deps.clock.resumeLive();
    }
  }
  return parsed.map((file) => ({
    label: file.request.label,
    namespace: file.namespace,
    agent: file.agent,
    eventCount: file.eventCount,
    firstTs: file.firstTs,
    lastTs: file.lastTs,
  }));
}

type ParsedRecording = {
  request: ReplayRequest;
  index: number;
  namespace: string;
  agent: string;
  eventCount: number;
  firstTs: number | null;
  lastTs: number | null;
  batches: { replayTs: number; events: NormalizedEvent[] }[];
};

function parseRecording(
  request: ReplayRequest,
  namespace: string,
  index: number,
  speed: number,
  anchor: number,
): ParsedRecording {
  const lines = request.text.split("\n");
  const header = parseRecordingHeader(lines[0], request.label);
  const events: { originalTs: number; event: NormalizedEvent }[] = [];
  lines.slice(1).forEach((line, lineOffset) => {
    if (line.trim() === "") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new RecordingReadError(
        `Cannot replay ${request.label}: line ${lineOffset + 2} is not valid JSON. ` +
          `Use a file written by hearable record, not a hand-edited copy.`,
      );
    }
    const result = NormalizedEventSchema.safeParse(parsed);
    if (!result.success) {
      throw new RecordingReadError(
        `Cannot replay ${request.label}: line ${lineOffset + 2} is not a normalized event. ` +
          `Use a file written by hearable record, not a hand-edited copy.`,
      );
    }
    events.push({ originalTs: result.data.ts, event: result.data });
  });
  if (events.length === 0) {
    return {
      request,
      index,
      namespace,
      agent: header.agent,
      eventCount: 0,
      firstTs: null,
      lastTs: null,
      batches: [],
    };
  }
  const firstOriginalTs = Math.min(...events.map((entry) => entry.originalTs));
  // Per-file alignment: every file starts at the anchor, so files recorded
  // days apart still replay together instead of preserving the wall gap
  // between their recording sessions.
  const rescaled = events.map((entry, eventIndex) => ({
    replayTs: Math.round(anchor + (entry.originalTs - firstOriginalTs) / speed),
    order: eventIndex,
    event: namespaceEvent(entry.event, namespace),
  }));
  rescaled.sort((left, right) => left.replayTs - right.replayTs || left.order - right.order);
  const batches: { replayTs: number; events: NormalizedEvent[] }[] = [];
  for (const entry of rescaled) {
    const last = batches[batches.length - 1];
    if (last !== undefined && last.replayTs === entry.replayTs) {
      last.events.push(entry.event);
    } else {
      batches.push({ replayTs: entry.replayTs, events: [entry.event] });
    }
  }
  const stamps = batches.map((batch) => batch.replayTs);
  return {
    request,
    index,
    namespace,
    agent: header.agent,
    eventCount: events.length,
    firstTs: Math.min(...stamps),
    lastTs: Math.max(...stamps),
    batches,
  };
}

/**
 * Namespaces session identity for one replay: `<namespace>:<recorded-id>`,
 * applied to `sessionId` and `parentSessionId` together so folded subagents
 * stay folded under their own replay's parent.
 */
function namespaceEvent(event: NormalizedEvent, namespace: string): NormalizedEvent {
  const namespaced = { ...event, sessionId: `${namespace}:${event.sessionId}` };
  if (event.parentSessionId === undefined) {
    return namespaced;
  }
  return { ...namespaced, parentSessionId: `${namespace}:${event.parentSessionId}` };
}

/**
 * The default wall wait between replay batches that are not yet due: a real
 * timer, so live replays pace out while fast replays (whose batches are
 * already due) stay synchronous.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function readRecordingFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RecordingReadError(
      `Cannot replay ${filePath}: the file could not be read (${detail}). ` +
        `Check the path and try again.`,
    );
  }
}
