// packages/daemon/src/broadcast.ts — the coalescing WebSocket event broadcaster.
// What this is for: pushing normalized event frames to connected browsers at
// most every BROADCAST_INTERVAL_MS (10 Hz-capped), batching bursts into one
// frame, per docs/ARCHITECTURE.md §Data flow step 7 and the daemon wire
// protocol. What it must not do: decide what a snapshot contains (the server
// produces those from lane state), block the ingest path, or hold clients —
// it hands ready frames to a dispatch callback the server bounds to its
// WebSocket server.

import type { NormalizedEvent } from "@hearable/core";
import type { Clock } from "./clock.js";
import type { LaneRender } from "./engine.js";
import type { LaneSnapshot, LaneView } from "./lanes.js";
import type { SessionRef } from "./sessions.js";

export const BROADCAST_INTERVAL_MS = 100;

export type Scheduler = {
  /** Schedules `fn` after `ms`, returning a cancel handle. */
  schedule(fn: () => void, ms: number): () => void;
};

export const defaultScheduler: Scheduler = {
  schedule(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** Every message the daemon pushes to the browser over the WebSocket. */
export type ServerMessage =
  | {
      type: "snapshot";
      lanes: LaneView[];
      queued: SessionRef[];
      signals: readonly LaneRender[];
      calm: number;
      serverTime: number;
    }
  | {
      type: "events";
      events: readonly NormalizedEvent[];
      signals: readonly LaneRender[];
      calm: number;
      serverTime: number;
      /**
       * Current lane occupancy, present whenever `laneSource` is wired (the
       * daemon always wires it; tests that exercise coalescing alone need
       * not). Lane allocation changes without any event of its own — an idle
       * lane is freed by the daemon's tick — so lane truth rides along with
       * every frame rather than only the connect-time snapshot. Before this,
       * a browser's lane view was frozen at connect: a session that started
       * later never appeared, and one that ended never left.
       */
      lanes?: LaneView[];
      queued?: SessionRef[];
    };

export type BroadcastTarget = {
  /** Called with a fully-formed frame whenever one is dispatched. */
  send(msg: ServerMessage): void;
};

/**
 * Buffers events and flushes them as one frame at most every
 * BROADCAST_INTERVAL_MS. `push` is cheap and non-blocking; flush occurs on the
 * injected scheduler so tests and the replayer can drive time deterministically.
 */
export class Broadcaster {
  private readonly buffer: NormalizedEvent[] = [];
  private latestSignals: readonly LaneRender[] = [];
  private latestCalm = 0.6;
  private signalPending = false;
  private scheduled = false;
  private pendingCancel: (() => void) | null = null;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly clock: Clock,
  ) {}

  /** The transport set by the server: emits one frame per flush. */
  target: BroadcastTarget | null = null;

  /**
   * The lane truth read at flush time, set by the server alongside `target`.
   * Injected the same way the transport is, so the broadcaster stays ignorant
   * of the lane allocator.
   */
  laneSource: (() => LaneSnapshot) | null = null;

  /** Buffers events for the next frame. */
  push(
    events: readonly NormalizedEvent[],
    signals: readonly LaneRender[] = this.latestSignals,
    calm = this.latestCalm,
  ): void {
    this.buffer.push(...events);
    this.latestSignals = signals;
    this.latestCalm = calm;
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    this.pendingCancel = this.scheduler.schedule(() => {
      this.scheduled = false;
      this.pendingCancel = null;
      this.flush();
    }, BROADCAST_INTERVAL_MS);
  }

  /** Queues a signal-only frame for timer-driven state changes. */
  pushSignals(signals: readonly LaneRender[], calm = this.latestCalm): void {
    this.latestSignals = signals;
    this.latestCalm = calm;
    this.signalPending = true;
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    this.pendingCancel = this.scheduler.schedule(() => {
      this.scheduled = false;
      this.pendingCancel = null;
      this.flush();
    }, BROADCAST_INTERVAL_MS);
  }

  /** Dispatches the buffered frame now, if there is anything to send. */
  flush(): void {
    if (this.target === null || (this.buffer.length === 0 && !this.signalPending)) {
      return;
    }
    this.signalPending = false;
    const frame: ServerMessage = {
      type: "events",
      events: this.buffer.splice(0),
      signals: this.latestSignals,
      calm: this.latestCalm,
      serverTime: this.clock(),
      ...(this.laneSource === null ? {} : this.laneSource()),
    };
    this.target.send(frame);
  }

  /** Cancels any pending flush; called on shutdown. */
  dispose(): void {
    if (this.pendingCancel !== null) {
      this.pendingCancel();
      this.pendingCancel = null;
    }
    this.scheduled = false;
  }
}
