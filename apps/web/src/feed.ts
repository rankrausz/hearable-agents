// Maintains daemon snapshots and connection truth; must not resume sound from cached state.
// apps/web/src/feed.ts — the plain WebSocket client behind the bare console.
// What this is for: opening `ws://<daemon>/ws`, replacing lane state on every
// snapshot, appending event frames to a bounded log buffer, and reporting
// connection state in plain words. What it must not do: derive anything,
// infer lifecycle, or keep history beyond the visible log window —
// docs/ARCHITECTURE.md keeps lane state in the daemon; the browser renders.

import {
  type AudioElection,
  type ConsoleEvent,
  type LaneSignal,
  type LaneViewState,
  parseAudioElection,
  parseServerMessage,
  type SessionRefView,
  type SignalFrame,
} from "./protocol.js";

export type ConnectionState = "connecting" | "live" | "reconnecting";

export type FeedState = {
  connection: ConnectionState;
  lanes: readonly LaneViewState[];
  queued: readonly SessionRefView[];
  log: readonly ConsoleEvent[];
  signals: readonly LaneSignal[];
  signalFrames: readonly SignalFrame[];
  calm: number;
  audio: AudioElection;
};

export const MAX_LOG_EVENTS = 200;
export const MAX_SIGNAL_FRAMES = 120;

export type FeedListener = (state: FeedState) => void;

/**
 * Opens the daemon feed and calls `onState` on every snapshot, event frame
 * and connection change. Returns a `close` that stops reconnecting and shuts
 * the socket. Reconnects with a fixed delay; each reconnect resyncs from the
 * snapshot the daemon sends on connect.
 */
export function connectFeed(options: {
  url: string;
  onState: FeedListener;
  reconnectDelayMs?: number;
}): {
  close(): void;
  claimAudio(takeover?: boolean): void;
  heartbeatAudio(): void;
  releaseAudio(): void;
} {
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  const seenIds = new Set<string>();
  let lanes: LaneViewState[] = [];
  let queued: SessionRefView[] = [];
  let log: ConsoleEvent[] = [];
  let connection: ConnectionState = "connecting";
  let signals: LaneSignal[] = [];
  let signalFrames: SignalFrame[] = [];
  let calm = 0.6;
  let audio: AudioElection = { endpointId: null, ownerId: null };
  let socket: WebSocket | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function emit(): void {
    options.onState({ connection, lanes, queued, log, signals, signalFrames, calm, audio });
  }

  function scheduleReconnect(): void {
    if (closed) {
      return;
    }
    connection = "reconnecting";
    emit();
    timer = setTimeout(open, reconnectDelayMs);
  }

  function open(): void {
    if (closed) {
      return;
    }
    let next: WebSocket;
    try {
      next = new WebSocket(options.url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = next;
    next.addEventListener("open", () => {
      if (next !== socket || closed) {
        next.close();
        return;
      }
      // A socket alone cannot make the cached pre-disconnect signals current.
      emit();
    });
    next.addEventListener("message", (event) => {
      if (next !== socket || closed) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const message = parseServerMessage(parsed);
      const election = parseAudioElection(parsed);
      if (election !== null) {
        audio = election;
        emit();
        return;
      }
      if (message === null) {
        return;
      }
      if (message.type === "snapshot") {
        connection = "live";
        lanes = message.lanes;
        queued = message.queued;
        signals = [...message.signals];
        calm = message.calm;
        if (message.audio !== undefined) audio = message.audio;
        signalFrames = [{ serverTime: message.serverTime, signals }];
        // A fresh snapshot re-anchors the log: lanes are replaced, events
        // already shown stay, and anything unseen in the next frames appends.
        emit();
        return;
      }
      const fresh = message.events.filter((item) => {
        if (seenIds.has(item.id)) {
          return false;
        }
        seenIds.add(item.id);
        return true;
      });
      signals = [...message.signals];
      calm = message.calm;
      // Lane truth rides on every frame: a session that starts after this
      // socket connected has no snapshot of its own to arrive in, and a lane
      // freed by the daemon's idle timer produces no event either.
      if (message.lanes !== undefined) {
        lanes = message.lanes;
      }
      if (message.queued !== undefined) {
        queued = message.queued;
      }
      signalFrames = [...signalFrames, { serverTime: message.serverTime, signals }].slice(
        -MAX_SIGNAL_FRAMES,
      );
      if (fresh.length === 0) {
        emit();
        return;
      }
      log = [...log, ...fresh].slice(-MAX_LOG_EVENTS);
      emit();
    });
    const onGone = () => {
      if (next !== socket || closed) {
        return;
      }
      socket = null;
      scheduleReconnect();
    };
    next.addEventListener("close", onGone);
    next.addEventListener("error", onGone);
  }

  open();

  return {
    claimAudio(takeover = false) {
      if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "audio-claim", takeover }));
    },
    heartbeatAudio() {
      if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "audio-heartbeat" }));
    },
    releaseAudio() {
      if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "audio-release" }));
    },
    close() {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      socket?.close();
      socket = null;
    },
  };
}

/** The feed URL for this page: same host and port as the daemon serving it. */
export function defaultFeedUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}
