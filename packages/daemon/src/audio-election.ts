// Owns the daemon-wide browser audio endpoint election.
// What this is for: making one connected browser audible at a time. What it
// must not do: create audio, inspect agent events, or choose a browser without
// an explicit claim.

import type { WebSocket } from "ws";
import type { Scheduler } from "./broadcast.js";
import type { Clock } from "./clock.js";

export const AUDIO_HEARTBEAT_INTERVAL_MS = 500;
export const AUDIO_HANDOFF_MS = 1_300;
const AUDIO_SWEEP_INTERVAL_MS = 50;

/**
 * How long an owner may go without a heartbeat before its lease lapses. Four
 * heartbeat intervals, not one: the browser's heartbeat is a main-thread
 * `setInterval`, so building the audio graph, a garbage collection pause or a
 * backgrounded tab (throttled to >=1 s) all delay it past a single interval.
 * A lease equal to the interval revoked audio on the first late beat and the
 * page went silent while still reporting itself as playing.
 */
export const AUDIO_LEASE_TIMEOUT_MS = AUDIO_HEARTBEAT_INTERVAL_MS * 4;

export type AudioElectionMessage = {
  type: "audio-election";
  endpointId: string;
  ownerId: string | null;
};

type Peer = { socket: WebSocket; lastHeartbeat: number };

export class AudioElection {
  private readonly peers = new Map<string, Peer>();
  private ownerId: string | null = null;
  /**
   * The endpoint whose lease lapsed in `sweep`, and only that endpoint: it may
   * take ownership back with a heartbeat (see `heartbeat`). Cleared whenever
   * ownership is decided any other way, so a deliberate release or a takeover
   * is never undone by a straggling beat.
   */
  private lapsedOwnerId: string | null = null;
  private sweepCancel: (() => void) | null = null;
  private handoffCancel: (() => void) | null = null;
  private nextId = 0;

  constructor(
    private readonly clock: Clock,
    private readonly scheduler: Scheduler,
    private readonly send: (socket: WebSocket, message: AudioElectionMessage) => void,
  ) {
    this.scheduleSweep();
  }

  connect(socket: WebSocket, announce = true): string {
    const endpointId = `audio-${++this.nextId}`;
    this.peers.set(endpointId, { socket, lastHeartbeat: this.clock() });
    if (announce) this.sendState(endpointId);
    return endpointId;
  }

  disconnect(endpointId: string): void {
    this.peers.delete(endpointId);
    if (this.lapsedOwnerId === endpointId) {
      this.lapsedOwnerId = null;
    }
    if (this.ownerId === endpointId) {
      this.ownerId = null;
      this.broadcastState();
    }
  }

  claim(endpointId: string, takeover: boolean): void {
    if (!this.peers.has(endpointId)) return;
    if (this.ownerId !== null && this.ownerId !== endpointId && !takeover) {
      this.sendState(endpointId);
      return;
    }
    if (takeover && this.ownerId !== null && this.ownerId !== endpointId) {
      this.ownerId = null;
      this.lapsedOwnerId = null;
      this.broadcastState();
      this.handoffCancel?.();
      this.handoffCancel = this.scheduler.schedule(() => {
        this.handoffCancel = null;
        if (this.peers.has(endpointId)) {
          this.ownerId = endpointId;
          this.broadcastState();
        }
      }, AUDIO_HANDOFF_MS);
      return;
    }
    this.ownerId = endpointId;
    this.lapsedOwnerId = null;
    this.broadcastState();
  }

  /**
   * Records a beat from `endpointId`. An endpoint whose lease lapsed takes
   * ownership back here: the page is still playing and still wants to be
   * audible, so the beat that proves it is alive is also its re-claim. Without
   * this a single late beat silenced the page until the owner clicked the
   * audio button twice, because the browser only claims on that gesture.
   * Only a lapse arms this: a release or a takeover clears `lapsedOwnerId`,
   * so neither is undone by a straggling beat.
   */
  heartbeat(endpointId: string): void {
    const peer = this.peers.get(endpointId);
    if (peer === undefined) return;
    peer.lastHeartbeat = this.clock();
    if (this.ownerId === null && this.lapsedOwnerId === endpointId) {
      this.ownerId = endpointId;
      this.lapsedOwnerId = null;
      this.broadcastState();
    }
  }

  owner(): string | null {
    return this.ownerId;
  }

  release(endpointId: string): void {
    if (this.lapsedOwnerId === endpointId) {
      this.lapsedOwnerId = null;
    }
    if (this.ownerId !== endpointId) return;
    this.ownerId = null;
    this.broadcastState();
  }

  /**
   * Drops an owner that stopped heartbeating. The endpoint is remembered as
   * the lapsed owner so its next beat can take the lease back; a lapse is a
   * missed beat, not a decision to stop listening.
   */
  sweep(): void {
    const now = this.clock();
    if (this.ownerId === null) return;
    const owner = this.peers.get(this.ownerId);
    if (owner !== undefined && now - owner.lastHeartbeat < AUDIO_LEASE_TIMEOUT_MS) return;
    this.lapsedOwnerId = owner === undefined ? null : this.ownerId;
    this.ownerId = null;
    this.broadcastState();
  }

  dispose(): void {
    this.sweepCancel?.();
    this.handoffCancel?.();
    this.sweepCancel = null;
    this.handoffCancel = null;
    this.peers.clear();
    this.ownerId = null;
    this.lapsedOwnerId = null;
  }

  private sendState(endpointId: string): void {
    const peer = this.peers.get(endpointId);
    if (peer === undefined) return;
    this.send(peer.socket, { type: "audio-election", endpointId, ownerId: this.ownerId });
  }

  private broadcastState(): void {
    for (const endpointId of this.peers.keys()) this.sendState(endpointId);
  }

  private scheduleSweep(): void {
    this.sweepCancel = this.scheduler.schedule(() => {
      this.sweep();
      this.scheduleSweep();
    }, AUDIO_SWEEP_INTERVAL_MS);
  }
}
