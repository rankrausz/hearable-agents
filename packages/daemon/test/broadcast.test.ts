// packages/daemon/test/broadcast.test.ts — the coalescing rules of the event
// broadcaster: bursts within one flush window arrive as a single frame, flushes
// are at most every BROADCAST_INTERVAL_MS, and a flush with nothing buffered
// sends nothing.

import { describe, expect, it } from "vitest";
import type { Scheduler, ServerMessage } from "../src/broadcast.js";
import { BROADCAST_INTERVAL_MS, Broadcaster } from "../src/broadcast.js";
import type { Clock } from "../src/clock.js";
import { drillEvent } from "./doubles.js";

class ManualScheduler implements Scheduler {
  private readonly pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  schedule(fn: () => void, ms: number): () => void {
    const job = { fn, ms, cancelled: false };
    this.pending.push(job);
    return () => {
      job.cancelled = true;
    };
  }
  runAll(): void {
    for (const job of this.pending.splice(0)) {
      if (!job.cancelled) {
        job.fn();
      }
    }
  }
  count(): number {
    return this.pending.length;
  }
}

function fixture() {
  let now = 0;
  const clock: Clock = () => now;
  const scheduler = new ManualScheduler();
  const broadcaster = new Broadcaster(scheduler, clock);
  const frames: ServerMessage[] = [];
  broadcaster.target = { send: (msg) => frames.push(msg) };
  return { broadcaster, scheduler, frames, advance: (ms: number) => (now += ms) };
}

describe("broadcaster coalescing", () => {
  it("buffers a burst into a single frame at the interval boundary", () => {
    const fx = fixture();
    fx.broadcaster.push([drillEvent({ kind: "turn.start" })]);
    expect(fx.scheduler.count()).toBe(1);
    // More events before the window closes join the same pending flush.
    fx.broadcaster.push([drillEvent({ kind: "tool.start" }), drillEvent({ kind: "tool.end" })]);
    expect(fx.scheduler.count()).toBe(1);
    fx.advance(BROADCAST_INTERVAL_MS);
    fx.scheduler.runAll();
    expect(fx.frames).toHaveLength(1);
    const frame = fx.frames[0] as Extract<ServerMessage, { type: "events" }>;
    expect(frame.type).toBe("events");
    expect(frame.events).toHaveLength(3);
  });

  it("never dispatches more than one frame per flush window", () => {
    const fx = fixture();
    for (let i = 0; i < 10; i += 1) {
      fx.broadcaster.push([drillEvent({ kind: "turn.start", id: `t${i}` })]);
      fx.advance(10);
      fx.scheduler.runAll();
    }
    expect(fx.frames).toHaveLength(10);
    for (const frame of fx.frames) {
      expect(frame.type).toBe("events");
    }
  });

  it("flush() dispatches instantly when the buffer is held, and sends nothing when empty", () => {
    const fx = fixture();
    expect(fx.frames).toHaveLength(0);
    fx.broadcaster.flush();
    expect(fx.frames).toHaveLength(0);
    fx.broadcaster.push([drillEvent({ kind: "turn.start" })]);
    fx.broadcaster.flush();
    expect(fx.frames).toHaveLength(1);
  });

  it("dispose() cancels a pending flush", () => {
    const fx = fixture();
    fx.broadcaster.push([drillEvent({ kind: "turn.start" })]);
    fx.broadcaster.dispose();
    fx.advance(BROADCAST_INTERVAL_MS);
    fx.scheduler.runAll();
    expect(fx.frames).toHaveLength(0);
  });
});
