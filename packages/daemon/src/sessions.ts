// packages/daemon/src/sessions.ts — the daemon's per-session registry. What
// this is for: tracking every session the daemon has seen, attaching the
// adapter's capabilities on first sight (docs/EVENTS.md §Capabilities), and
// holding each session's map context (cwd) so adapters can stay pure. What it
// must not do: decide lane allocation (that is lanes.ts), know which agent a
// session belongs to beyond the event's own `agent` field — agent identity and
// capabilities are data, never branches — or hold anything secret (session
// views expose identity and timing only).

import type { AdapterCapabilities, NormalizedEvent } from "@hearable/core";
import type { FocusTarget } from "./focus-origin.js";

/**
 * The view of a session exposed to browsers and /health: identity and timing,
 * never secrets and never capabilities internals.
 */
export type SessionRef = {
  sessionId: string;
  agent: string;
  via?: string;
  parentSessionId?: string;
  /** Display name: the cwd basename while session naming lands (docs/UI.md). */
  name: string;
  firstSeenAt: number;
  lastActivityAt: number;
};

/** The daemon's full bookkeeping for one session, kept internally. */
export type SessionRecord = SessionRef & {
  capabilities: AdapterCapabilities | null;
  cwd: string | null;
  /** Local, ephemeral transport data; omitted from every public session view. */
  focus?: Promise<FocusTarget>;
};

/** A mutable registry of sessions in arrival order. Owned by the daemon. */
export class Sessions {
  private readonly recordsBySessionId = new Map<string, SessionRecord>();

  /**
   * Registers or touches the session of `event`, attaching `capabilities` on
   * first sight. Returns the record. First-sight capabilities win: a later
   * adapter downgrade is deliberate runtime re-observation, not this path.
   */
  observe(
    event: NormalizedEvent,
    capabilities: AdapterCapabilities | null,
    now: number,
  ): SessionRecord {
    const existing = this.recordsBySessionId.get(event.sessionId);
    if (existing !== undefined) {
      existing.lastActivityAt = now;
      if (event.via !== undefined && existing.via === undefined) {
        existing.via = event.via;
      }
      return existing;
    }
    const record: SessionRecord = {
      sessionId: event.sessionId,
      agent: event.agent,
      via: event.via,
      parentSessionId: event.parentSessionId,
      name: event.sessionId,
      firstSeenAt: now,
      lastActivityAt: now,
      capabilities,
      cwd: null,
    };
    this.recordsBySessionId.set(event.sessionId, record);
    return record;
  }

  /** The record for `sessionId`, or undefined when the session is untracked. */
  get(sessionId: string): SessionRecord | undefined {
    return this.recordsBySessionId.get(sessionId);
  }

  /**
   * Records the working directory the payload reported, so subsequent raw
   * payloads from the same session can be relativised against it. The session
   * display name follows the cwd basename (docs/UI.md), which is why this is
   * set here, next to the stored cwd. Ignored for untracked sessions.
   */
  setCwd(sessionId: string, cwd: string): void {
    const record = this.recordsBySessionId.get(sessionId);
    if (record !== undefined) {
      record.cwd = cwd;
      record.name = basenameOf(cwd);
    }
  }

  /** True when the session has been seen. */
  has(sessionId: string): boolean {
    return this.recordsBySessionId.has(sessionId);
  }

  /**
   * Bumps `sessionId`'s activity and, when it is a subagent, the parent's:
   * subagent activity keeps the parent lane out of the idle release window.
   */
  touch(sessionId: string, now: number): void {
    const record = this.recordsBySessionId.get(sessionId);
    if (record === undefined) {
      return;
    }
    record.lastActivityAt = now;
    const parent = record.parentSessionId;
    if (parent !== undefined && parent !== sessionId) {
      const parentRecord = this.recordsBySessionId.get(parent);
      if (parentRecord !== undefined) {
        parentRecord.lastActivityAt = now;
      }
    }
  }

  /** Removes the session; used when its `session.end` has been processed. */
  remove(sessionId: string): void {
    this.recordsBySessionId.delete(sessionId);
  }

  /** All records in first-seen order. */
  all(): readonly SessionRecord[] {
    return [...this.recordsBySessionId.values()];
  }
}

/** The session view exposed outward, without internal bookkeeping. */
export function toSessionRef(record: SessionRecord): SessionRef {
  return {
    sessionId: record.sessionId,
    agent: record.agent,
    via: record.via,
    parentSessionId: record.parentSessionId,
    name: record.name,
    firstSeenAt: record.firstSeenAt,
    lastActivityAt: record.lastActivityAt,
  };
}

/**
 * The trailing path segment of a working directory: "/repo/app" becomes
 * "app", "/" stays "/". Session names use this until session naming lands.
 */
export function basenameOf(path: string): string {
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 || slash === trimmed.length - 1 ? trimmed : trimmed.slice(slash + 1);
}
