// apps/web/src/feed.test.ts — the plain client contract: a dropped socket
// reconnects, and the snapshot on reconnect replaces lane state while queued
// event ids seen before the drop are not shown twice.

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectFeed, type FeedState } from "./feed.js";
import type { ConsoleEvent } from "./protocol.js";

type HandlerMap = Record<string, ((event: { data?: string }) => void)[]>;

class FakeSocket {
  static instances: FakeSocket[] = [];
  static openAll(): void {
    for (const socket of [...FakeSocket.instances]) {
      socket.open();
    }
  }
  readonly handlers: HandlerMap = {};
  sentClose = false;
  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, handler: (event: { data?: string }) => void): void {
    this.handlers[type] = [...(this.handlers[type] ?? []), handler];
  }
  close(): void {
    this.sentClose = true;
  }
  open(): void {
    for (const handler of this.handlers.open ?? []) {
      handler({});
    }
  }
  receive(payload: unknown): void {
    for (const handler of this.handlers.message ?? []) {
      handler({ data: JSON.stringify(payload) });
    }
  }
  drop(): void {
    for (const handler of this.handlers.close ?? []) {
      handler({});
    }
  }
}

function laneSession(sessionId: string, name: string) {
  return {
    sessionId,
    agent: "claude-code",
    name,
    firstSeenAt: 1,
    lastActivityAt: 2,
  };
}

function snapshot(lanes: { laneId: number; sessions: ReturnType<typeof laneSession>[] }[]) {
  return {
    type: "snapshot",
    lanes: lanes.map((lane) => ({
      laneId: lane.laneId,
      state: lane.sessions.length > 0 ? "active" : "free",
      sessions: lane.sessions,
    })),
    queued: [],
    serverTime: 3,
  };
}

function event(id: string, sessionId: string): ConsoleEvent {
  return {
    id,
    ts: 4,
    receivedAt: 4,
    agent: "claude-code",
    sessionId,
    kind: "session.start",
  };
}

describe("the plain feed client", () => {
  afterEach(() => {
    FakeSocket.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reconnects after a drop and resyncs lanes from the new snapshot without repeating seen events", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const states: FeedState[] = [];
    const feed = connectFeed({
      url: "ws://127.0.0.1:1/ws",
      onState: (state) => states.push(state),
      reconnectDelayMs: 1000,
    });

    FakeSocket.openAll();
    expect(states.at(-1)?.connection).toBe("connecting");
    FakeSocket.instances[0]?.receive(
      snapshot([{ laneId: 0, sessions: [laneSession("s-a", "a")] }]),
    );
    FakeSocket.instances[0]?.receive({
      type: "events",
      events: [event("e-1", "s-a")],
      serverTime: 5,
    });
    expect(states.at(-1)?.log.map((item) => item.id)).toEqual(["e-1"]);
    expect(states.at(-1)?.calm).toBe(0.6);

    FakeSocket.instances[0]?.drop();
    expect(states.at(-1)?.connection).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]?.open();
    expect(states.at(-1)?.connection).toBe("reconnecting");
    FakeSocket.instances[1]?.receive(
      snapshot([{ laneId: 0, sessions: [laneSession("s-b", "b")] }]),
    );
    expect(states.at(-1)?.connection).toBe("live");
    // The reconnect snapshot replaces lanes; the log keeps what was shown.
    expect(states.at(-1)?.lanes[0]?.sessions[0]?.sessionId).toBe("s-b");
    expect(states.at(-1)?.log.map((item) => item.id)).toEqual(["e-1"]);

    // A repeat of the pre-drop event frame is filtered; a new event appends.
    FakeSocket.instances[1]?.receive({
      type: "events",
      events: [event("e-1", "s-a"), event("e-2", "s-b")],
      serverTime: 6,
    });
    expect(states.at(-1)?.log.map((item) => item.id)).toEqual(["e-1", "e-2"]);

    feed.close();
    expect(FakeSocket.instances[1]?.sentClose).toBe(true);
  });
});
