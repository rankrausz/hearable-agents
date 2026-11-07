// packages/daemon/src/lanes.ts — session-to-lane allocation per
// docs/ARCHITECTURE.md §packages/daemon `lanes.ts`. What this is for: mapping
// every session to one of the MVP lanes, queueing sessions when all lanes are
// full (tracked but silent), folding subagent sessions (those carrying a
// parentSessionId) into the parent's lane, and freeing a lane on `session.end`
// or after laneReleaseAfterMs of inactivity, promoting the queue. What it must
// not do: know why a session is active or what it is doing — lanes are
// agent-agnostic identity buckets, and anything semantic belongs to the state
// engine in Phase 2.

import type { NormalizedEvent } from "@hearable/core";
import type { Clock } from "./clock.js";
import type { SessionRecord, SessionRef, Sessions } from "./sessions.js";
import { toSessionRef } from "./sessions.js";

export type LaneState = "active" | "free";

export type LaneView = {
  laneId: number;
  state: LaneState;
  /** Session refs occupying this lane, owner first, folded subagents after. */
  sessions: SessionRef[];
};

export type LaneSnapshot = {
  lanes: LaneView[];
  queued: SessionRef[];
};

/**
 * The lane a session's activity should land in: the parent lane for a
 * subagent, its own lane otherwise. Allocation is keyed by this value so a
 * subagent folds into the parent's lane even when the parent has not been
 * seen yet.
 */
export function laneKeyOf(sessionId: string, parentSessionId: string | undefined): string {
  return parentSessionId ?? sessionId;
}

/**
 * The seat preference order over lane ids (docs/SOUND_DESIGN.md §Seats and
 * allocation, ADR 0024): mid (lane 1), low (lane 0), high (lane 2), upper
 * (lane 3). A solo agent must sound centred and mid-register, so the first
 * free seat is never simply the lowest lane id. Lane index → seat identity is
 * unchanged; only the order seats are handed out in is declared here.
 */
export const SEAT_PREFERENCE: readonly number[] = [1, 0, 2, 3];

/**
 * The allocation order for `laneCount` lanes: the declared preference
 * restricted to lane ids that exist, then any lane ids the table does not name
 * in ascending order so every configured lane stays reachable.
 */
export function seatOrderFor(laneCount: number): readonly number[] {
  const declared = SEAT_PREFERENCE.filter((laneId) => laneId < laneCount);
  const rest = Array.from({ length: laneCount }, (_, laneId) => laneId).filter(
    (laneId) => !declared.includes(laneId),
  );
  return [...declared, ...rest];
}

/**
 * The mutable lane allocator. A key keeps its lane id from placement until
 * release: joins, leaves and promotions never move a live key, so balance
 * comes only from the preference order. Owned by the daemon; never shared
 * with core.
 */
export class LaneManager {
  private readonly slots: (string | null)[];
  private readonly seatOrder: readonly number[];
  private readonly slotByKey = new Map<string, number>();
  private readonly queue: string[] = [];
  private readonly queuedKeys = new Set<string>();
  // Which sessions currently fold under each key, so a key can be dropped the
  // moment its last member ends — otherwise a queued subagent whose parent is
  // unseen would leave a parent key in the queue that owns no live session.
  private readonly membersByKey = new Map<string, Set<string>>();
  private readonly keyOfSession = new Map<string, string>();

  constructor(
    laneCount: number,
    private readonly releaseAfterMs: number,
    private readonly sessions: Sessions,
    private readonly clock: Clock,
  ) {
    this.slots = Array.from({ length: laneCount }, () => null);
    this.seatOrder = seatOrderFor(laneCount);
  }

  /**
   * Routes one event through allocation. An ending event (`session.end` for a
   * root session, `subagent.end` for a folded subagent) de-registers that
   * session from its key and, when the key has no members left, releases its
   * lane or drops it from the queue. Every other event places the session's
   * lane key, creating the assignment when needed. Idempotent per key.
   */
  accept(event: NormalizedEvent): void {
    const key = laneKeyOf(event.sessionId, event.parentSessionId);
    if (event.kind === "session.end" || event.kind === "subagent.end") {
      this.forgetMember(event.sessionId, key);
      return;
    }
    this.rememberMember(key, event.sessionId);
    this.place(key);
  }

  /**
   * Frees every lane whose owner has been idle for `laneReleaseAfterMs`,
   * promoting the queue into freed slots in seat preference order. Called from
   * the daemon's tick timer.
   */
  advance(): void {
    const now = this.clock();
    for (const laneId of this.seatOrder) {
      const key = this.slots[laneId];
      if (key === null || key === undefined) {
        continue;
      }
      const members = this.membersForKey(key);
      let lastActivity = -Infinity;
      for (const record of members) {
        if (record.lastActivityAt > lastActivity) {
          lastActivity = record.lastActivityAt;
        }
      }
      if (members.length === 0 || now - lastActivity >= this.releaseAfterMs) {
        this.freeLane(laneId, key);
      }
    }
  }

  /** The current lane occupancy plus the queue, for snapshots and /health. */
  snapshot(): LaneSnapshot {
    const lanes = this.slots.map((key, laneId) => {
      if (key === null) {
        return { laneId, state: "free" as const, sessions: [] };
      }
      return {
        laneId,
        state: "active" as const,
        sessions: this.membersForKey(key).map(toSessionRef),
      };
    });
    return { lanes, queued: this.queueRefs() };
  }

  /** How many lanes are actively occupied right now. */
  occupiedCount(): number {
    return this.slots.reduce((count, slot) => (slot === null ? count : count + 1), 0);
  }

  /** Returns the allocated lane for a key; queued keys deliberately return undefined. */
  laneIdForKey(key: string): number | undefined {
    return this.slotByKey.get(key);
  }

  private rememberMember(key: string, sessionId: string): void {
    const previousKey = this.keyOfSession.get(sessionId);
    if (previousKey !== undefined && previousKey !== key) {
      const previousMembers = this.membersByKey.get(previousKey);
      previousMembers?.delete(sessionId);
      if (previousMembers !== undefined && previousMembers.size === 0) {
        // The session moved keys (pathological); drop the now-empty old key
        // from queue or lane just as if its last member had ended.
        this.membersByKey.delete(previousKey);
        this.releaseOwner(previousKey);
      }
    }
    this.keyOfSession.set(sessionId, key);
    const members = this.membersByKey.get(key) ?? new Set<string>();
    members.add(sessionId);
    this.membersByKey.set(key, members);
  }

  private forgetMember(sessionId: string, fallbackKey: string): void {
    const registeredKey = this.keyOfSession.get(sessionId) ?? fallbackKey;
    const members = this.membersByKey.get(registeredKey);
    if (members === undefined) {
      return;
    }
    members.delete(sessionId);
    this.keyOfSession.delete(sessionId);
    if (members.size === 0) {
      this.membersByKey.delete(registeredKey);
      this.releaseOwner(registeredKey);
    }
  }

  private place(key: string): void {
    if (this.slotByKey.has(key)) {
      return;
    }
    // Folding is implicit in the key: a subagent whose parent is untracked yet
    // degrades to owning its own lane, and later parent events fold it back.
    const freeLane = this.seatOrder.find((laneId) => this.slots[laneId] === null);
    if (freeLane !== undefined) {
      this.slots[freeLane] = key;
      this.slotByKey.set(key, freeLane);
      return;
    }
    if (!this.queuedKeys.has(key)) {
      this.queuedKeys.add(key);
      this.queue.push(key);
    }
  }

  private releaseOwner(key: string): void {
    const laneId = this.slotByKey.get(key);
    if (laneId !== undefined) {
      this.freeLane(laneId, key);
    }
    if (this.queuedKeys.has(key)) {
      this.queuedKeys.delete(key);
      const index = this.queue.indexOf(key);
      if (index !== -1) {
        this.queue.splice(index, 1);
      }
    }
  }

  private freeLane(laneId: number, key: string): void {
    this.slotByKey.delete(key);
    this.slots[laneId] = null;
    this.promoteQueue(laneId);
  }

  private promoteQueue(laneId: number): void {
    while (this.slots[laneId] === null && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined) {
        break;
      }
      // A queued key whose last member ended was already dropped by
      // forgetMember, so anything still here has live members and takes
      // the lane.
      this.slots[laneId] = next;
      this.slotByKey.set(next, laneId);
      this.queuedKeys.delete(next);
    }
  }

  /** The session records (owner first) currently folded under `key`. */
  private membersForKey(key: string): SessionRecord[] {
    const members: SessionRecord[] = [];
    for (const record of this.sessions.all()) {
      if (laneKeyOf(record.sessionId, record.parentSessionId) === key) {
        members.push(record);
      }
    }
    return members;
  }

  /** The live member sessions of every queued key, so a queued subagent shows. */
  private queueRefs(): SessionRef[] {
    const refs: SessionRef[] = [];
    for (const key of this.queue) {
      const members = this.membersByKey.get(key);
      if (members === undefined) {
        continue;
      }
      for (const sessionId of members) {
        const record = this.sessions.get(sessionId);
        if (record !== undefined) {
          refs.push(toSessionRef(record));
        }
      }
    }
    return refs;
  }
}
