// packages/daemon/test/replayer.test.ts — the concurrent replayer: it reads
// recording files through the same ingest path live events take, rescales
// timestamps by speed, drives the injected engine clock, namespaces session
// ids per replay so a Claude Code file and a Codex file replayed together
// yield two lanes, and refuses schema versions it cannot read instead of
// guessing.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedEvent } from "@hearable/core";
import { afterEach, describe, expect, it } from "vitest";
import { createAdapterRegistry } from "../src/adapters.js";
import type { Scheduler, ServerMessage } from "../src/broadcast.js";
import { Broadcaster } from "../src/broadcast.js";
import type { Clock } from "../src/clock.js";
import { createIngest } from "../src/ingest.js";
import { LaneManager } from "../src/lanes.js";
import { createQuarantine } from "../src/quarantine.js";
import { createRecorder } from "../src/recorder.js";
import { formatRecordingHeader, RECORDING_SCHEMA_VERSION } from "../src/recording.js";
import {
  createReplayClock,
  type MutableClock,
  namespacesFor,
  type ReplayerDeps,
  replayRecordingFile,
  replayRecordingFiles,
  replayRecordings,
} from "../src/replayer.js";
import { Sessions } from "../src/sessions.js";
import { drillClaudeShapedAdapter, drillEvent, sessionStartEvent } from "./doubles.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class ManualScheduler implements Scheduler {
  schedule(): () => void {
    return () => {};
  }
}

/**
 * A scheduler plus wall clock the replayer's pacing hooks can drive
 * deterministically. `sleep` advances both the fake wall time and any
 * scheduled daemon timers, in due order, without real waiting.
 */
class DeterministicScheduler implements Scheduler {
  private wall = 0;
  private timers: { dueAt: number; fn: () => void; cancelled: boolean; seq: number }[] = [];
  private seq = 0;

  now(): number {
    return this.wall;
  }

  schedule(fn: () => void, ms: number): () => void {
    const timer = { dueAt: this.wall + ms, fn, cancelled: false, seq: this.seq++ };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** Advances wall time to `target`, firing due timers in due order. */
  async sleep(ms: number): Promise<void> {
    const target = this.wall + ms;
    for (;;) {
      this.timers.sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);
      const next = this.timers[0];
      if (next === undefined || next.cancelled || next.dueAt > target) {
        break;
      }
      this.timers.shift();
      this.wall = next.dueAt;
      next.fn();
      await Promise.resolve();
    }
    this.timers = this.timers.filter((timer) => !timer.cancelled);
    this.timers.sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);
    this.wall = target;
    await Promise.resolve();
  }

  /** Fires timers due by now without advancing time. */
  async flushDue(): Promise<void> {
    await this.sleep(0);
  }
}

type Harness = {
  deps: ReplayerDeps;
  recorded: NormalizedEvent[][];
  engineCalls: { events: NormalizedEvent[]; now: number }[];
  sessions: Sessions;
  lanes: LaneManager;
  clock: MutableClock;
  cleanup: () => void;
};

function harness(wallNow = 1_000_000): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "hearable-replay-"));
  tmpDirs.push(tmp);
  const clock = createReplayClock(undefined, () => wallNow);
  const daemonClock: Clock = () => clock.now();
  const sessions = new Sessions();
  const lanes = new LaneManager(3, 60_000, sessions, daemonClock);
  const quarantine = createQuarantine(tmp, daemonClock);
  const broadcaster = new Broadcaster(new ManualScheduler(), daemonClock);
  const recorded: NormalizedEvent[][] = [];
  const engineCalls: { events: NormalizedEvent[]; now: number }[] = [];
  const ingest = createIngest({
    adapters: createAdapterRegistry([drillClaudeShapedAdapter]),
    sessions,
    lanes,
    quarantine,
    broadcaster,
    clock: daemonClock,
    applyToEngine: (events, now) => engineCalls.push({ events: [...events], now }),
  });
  void recorded;
  return {
    deps: { ingest, clock },
    recorded,
    engineCalls,
    sessions,
    lanes,
    clock,
    cleanup: () => {},
  };
}

function recordingText(agent: string, events: NormalizedEvent[]): string {
  const header = formatRecordingHeader({
    agent,
    recordedAt: 999,
    annotations: "x.annotations.json",
  });
  return `${header}\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function writeRecording(agent: string, events: NormalizedEvent[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hearable-replay-file-"));
  tmpDirs.push(dir);
  const filePath = join(dir, `${agent}.jsonl`);
  writeFileSync(filePath, recordingText(agent, events), "utf8");
  return filePath;
}

describe("replayer", () => {
  it("feeds recording files through the live ingest path with rescaled timestamps", async () => {
    const fx = harness();
    const events = [
      sessionStartEvent("orig-s"),
      drillEvent({ sessionId: "orig-s", kind: "turn.start", ts: 2000, receivedAt: 2000 }),
      drillEvent({
        sessionId: "orig-s",
        kind: "turn.end",
        ts: 3000,
        receivedAt: 3000,
        lifecycle: { reason: "completed", confidence: "observed" },
      }),
    ];
    const filePath = writeRecording("claude-code", events);
    const summaries = await replayRecordingFiles([filePath], fx.deps, { speed: 10 });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.eventCount).toBe(3);
    expect(summaries[0]?.agent).toBe("claude-code");
    // Speed 10: a 2000 ms recording spans 200 ms of engine time from the anchor.
    expect((summaries[0]?.lastTs ?? 0) - (summaries[0]?.firstTs ?? 0)).toBe(200);
    // The sessions registry saw the replayed events, namespaced per replay.
    expect(fx.sessions.has("replay-1:s1")).toBe(false);
    expect(fx.sessions.has("replay-1:orig-s")).toBe(true);
    // The engine clock was driven: every engine call saw replay time.
    expect(fx.engineCalls.length).toBeGreaterThan(0);
    for (const call of fx.engineCalls) {
      expect(call.now).toBeGreaterThanOrEqual(summaries[0]?.firstTs ?? 0);
      expect(call.now).toBeLessThanOrEqual(summaries[0]?.lastTs ?? 0);
    }
    fx.cleanup();
  });

  it("replays two files together into two lanes with namespaced sessions", async () => {
    const fx = harness();
    const claudeEvents = [
      sessionStartEvent("claude-session"),
      drillEvent({ sessionId: "claude-session", kind: "turn.start", ts: 1000, receivedAt: 1000 }),
    ];
    const codexEvents = [
      sessionStartEvent("codex-session", "codex"),
      drillEvent({
        sessionId: "codex-session",
        kind: "turn.start",
        agent: "codex",
        ts: 1000,
        receivedAt: 1000,
      }),
    ];
    const claudeFile = writeRecording("claude-code", claudeEvents);
    const codexFile = writeRecording("codex", codexEvents);
    const summaries = await replayRecordingFiles([claudeFile, codexFile], fx.deps, { speed: 10 });
    expect(summaries).toHaveLength(2);
    expect(fx.lanes.occupiedCount()).toBe(2);
    expect(fx.sessions.has("replay-1:claude-session")).toBe(true);
    expect(fx.sessions.has("replay-2:codex-session")).toBe(true);
    const agents = fx.sessions
      .all()
      .map((record) => record.agent)
      .sort();
    expect(agents).toEqual(["claude-code", "codex"]);
    expect(summaries[0]?.namespace).toBe("replay-1");
    expect(summaries[1]?.namespace).toBe("replay-2");
    fx.cleanup();
  });

  it("round-trips record output: replaying a recorded file restores the lane and event order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearable-roundtrip-"));
    tmpDirs.push(dir);
    const filePath = join(dir, "roundtrip.jsonl");
    const recorder = createRecorder({ filePath, agent: "claude-code" });
    recorder.record([
      sessionStartEvent("live-session"),
      drillEvent({ sessionId: "live-session", kind: "turn.start", ts: 1100, receivedAt: 1100 }),
      drillEvent({
        sessionId: "live-session",
        kind: "turn.end",
        ts: 1200,
        receivedAt: 1200,
        lifecycle: { reason: "completed", confidence: "observed" },
      }),
    ]);
    const fx = harness();
    const summaries = await replayRecordingFiles([filePath], fx.deps, { speed: 10 });
    expect(summaries[0]?.eventCount).toBe(3);
    const kinds = fx.engineCalls.flatMap((call) => call.events.map((event) => event.kind));
    expect(kinds).toEqual(["session.start", "turn.start", "turn.end"]);
    const laneSessions = fx.lanes.snapshot().lanes.flatMap((lane) => lane.sessions);
    expect(laneSessions.map((ref) => ref.sessionId)).toContain("replay-1:s1");
    fx.cleanup();
  });

  it("refuses a recording whose schema version it cannot read, with a plain-language error", async () => {
    const fx = harness();
    const header = JSON.stringify({
      hearable: "session",
      v: 999,
      recordedAt: 1,
      agent: "claude-code",
      annotations: "x.annotations.json",
    });
    await expect(
      replayRecordings([{ label: "old.jsonl", text: `${header}\n` }], fx.deps, { speed: 10 }),
    ).rejects.toThrow(/schema version 999/);
    await expect(
      replayRecordings([{ label: "old.jsonl", text: `${header}\n` }], fx.deps, { speed: 10 }),
    ).rejects.toThrow(/cannot read/);
    // Nothing was ingested: the bad file fails before any event is fed.
    expect(fx.engineCalls).toHaveLength(0);
    fx.cleanup();
  });

  it("rejects a non-positive speed with a plain-language error", async () => {
    const fx = harness();
    const filePath = writeRecording("claude-code", [sessionStartEvent("s")]);
    await expect(replayRecordingFiles([filePath], fx.deps, { speed: 0 })).rejects.toThrow(
      /greater than zero/,
    );
    fx.cleanup();
  });

  it("keeps subagent folding inside its own replay namespace", async () => {
    const fx = harness();
    const events = [
      drillEvent({ sessionId: "parent", kind: "session.start", ts: 1000, receivedAt: 1000 }),
      drillEvent({
        id: "sub-1",
        ts: 1100,
        receivedAt: 1100,
        sessionId: "child",
        parentSessionId: "parent",
        kind: "subagent.start",
      }),
    ];
    const summaries = await replayRecordings(
      [{ label: "sub.jsonl", text: recordingText("claude-code", events) }],
      fx.deps,
      { speed: 1 },
    );
    expect(summaries[0]?.eventCount).toBe(2);
    const child = fx.sessions.get("replay-1:child");
    expect(child?.parentSessionId).toBe("replay-1:parent");
    fx.cleanup();
  });

  it("hands the shared clock back to live wall time after a replay", async () => {
    const fx = harness(9_000_000);
    const filePath = writeRecording("claude-code", [sessionStartEvent("s")]);
    await replayRecordingFiles([filePath], fx.deps, { speed: 10, anchorNow: 1_000 });
    // During the replay the clock visited replay time; afterwards it reads
    // live wall time again, so the next live event gets a wall receivedAt.
    expect(fx.clock.now()).toBe(9_000_000);
    fx.cleanup();
  });

  it("keeps the clock parked at replay time for offline callers that opt out", async () => {
    const fx = harness(9_000_000);
    const filePath = writeRecording("claude-code", [sessionStartEvent("s")]);
    const summaries = await replayRecordingFiles([filePath], fx.deps, {
      speed: 1,
      anchorNow: 2_000,
      restoreClock: false,
    });
    expect(summaries[0]?.lastTs).toBe(2_000);
    expect(fx.clock.now()).toBe(2_000);
    fx.cleanup();
  });

  it("restores the clock even when the replay fails mid-way", async () => {
    const fx = harness(9_000_000);
    await expect(
      replayRecordings(
        [
          { label: "good.jsonl", text: recordingText("claude-code", [sessionStartEvent("s")]) },
          {
            label: "bad.jsonl",
            text: `${JSON.stringify({ hearable: "session", v: 999, recordedAt: 1, agent: "claude-code", annotations: "x.annotations.json" })}\n`,
          },
        ],
        fx.deps,
        { speed: 1 },
      ),
    ).rejects.toThrow(/schema version 999/);
    // Claim happened for the good file, then parsing the bad file threw
    // before any ingest — and the clock still handed back to live time.
    expect(fx.clock.now()).toBe(9_000_000);
    expect(fx.engineCalls).toHaveLength(0);
    fx.cleanup();
  });

  it("allocates unique namespaces across separate replay calls with no caller wiring", async () => {
    const fx = harness();
    // No `namespaces` on deps: both calls resolve the scope bound to the
    // daemon's ingest, so the second call cannot reuse `replay-1`.
    const first = writeRecording("claude-code", [sessionStartEvent("a")]);
    const second = writeRecording("codex", [sessionStartEvent("a", "codex")]);
    const firstSummary = await replayRecordingFiles([first], fx.deps, { speed: 10 });
    const secondSummary = await replayRecordingFiles([second], fx.deps, { speed: 10 });
    expect(firstSummary[0]?.namespace).toBe("replay-1");
    expect(secondSummary[0]?.namespace).toBe("replay-2");
    expect(fx.sessions.has("replay-1:a")).toBe(true);
    expect(fx.sessions.has("replay-2:a")).toBe(true);
    expect(fx.lanes.occupiedCount()).toBe(2);
    fx.cleanup();
  });

  it("rejects a duplicate caller-provided namespace instead of merging lanes", async () => {
    const fx = harness();
    const file = writeRecording("claude-code", [sessionStartEvent("a")]);
    await replayRecordingFiles([file], { ...fx.deps, clock: fx.clock }, { speed: 10 });
    await expect(
      replayRecordings(
        [
          {
            label: "again.jsonl",
            text: recordingText("claude-code", [sessionStartEvent("b")]),
            namespace: "replay-1",
          },
        ],
        fx.deps,
        { speed: 10 },
      ),
    ).rejects.toThrow(/already used/);
    fx.cleanup();
  });

  it("passes the single-file namespace through to the replay", async () => {
    const fx = harness();
    const filePath = writeRecording("claude-code", [sessionStartEvent("solo")]);
    const summary = await replayRecordingFile(filePath, fx.deps, { speed: 10, namespace: "demo" });
    expect(summary.namespace).toBe("demo");
    expect(fx.sessions.has("demo:solo")).toBe(true);
    fx.cleanup();
  });

  it("binds one namespace scope to the daemon ingest across calls", () => {
    const fx = harness();
    expect(namespacesFor(fx.deps.ingest)).toBe(namespacesFor(fx.deps.ingest));
    fx.cleanup();
  });

  it("keeps lanes occupied and flushes event frames during a slow multi-batch replay", async () => {
    const scheduler = new DeterministicScheduler();
    const tmp = mkdtempSync(join(tmpdir(), "hearable-replay-paced-"));
    tmpDirs.push(tmp);
    // The daemon clock and the pacing wall clock both read the deterministic
    // scheduler, so sleeps advance timers and receivedAt stays honest.
    const clock = createReplayClock(undefined, () => scheduler.now());
    const daemonClock: Clock = () => clock.now();
    const sessions = new Sessions();
    // Idle release far beyond the replay span: any freed lane is a pacing bug.
    const lanes = new LaneManager(3, 60_000, sessions, daemonClock);
    const quarantine = createQuarantine(tmp, daemonClock);
    const broadcaster = new Broadcaster(scheduler, daemonClock);
    const frames: ServerMessage[] = [];
    broadcaster.target = {
      send: (msg) => {
        frames.push(msg);
      },
    };
    const ingest = createIngest({
      adapters: createAdapterRegistry([drillClaudeShapedAdapter]),
      sessions,
      lanes,
      quarantine,
      broadcaster,
      clock: daemonClock,
      applyToEngine: () => {},
    });
    const engineNow = 1_000_000;
    // Two files, each with two batches 500 engine-ms apart: without pacing,
    // all four batches feed synchronously and the 100 ms broadcast flush
    // never fires mid-replay.
    const claudeEvents = [
      sessionStartEvent("claude-session"),
      drillEvent({ sessionId: "claude-session", kind: "turn.start", ts: 1500, receivedAt: 1500 }),
    ];
    const codexEvents = [
      sessionStartEvent("codex-session", "codex"),
      drillEvent({
        sessionId: "codex-session",
        kind: "turn.start",
        agent: "codex",
        ts: 1500,
        receivedAt: 1500,
      }),
    ];
    clock.set(engineNow);
    const replay = replayRecordings(
      [
        { label: "claude.jsonl", text: recordingText("claude-code", claudeEvents) },
        { label: "codex.jsonl", text: recordingText("codex", codexEvents) },
      ],
      { ingest, clock },
      {
        speed: 1,
        anchorNow: engineNow,
        restoreClock: false,
        wallNow: () => scheduler.now(),
        sleep: (ms) => scheduler.sleep(ms),
      },
    );
    // Let the first batches land, then drive the broadcast flush while the
    // later batches are still waiting on the pacing sleep.
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.flushDue();
    // Mid-replay: both replay namespaces hold a lane and at least one event
    // frame was flushed, instead of every receivedAt jumping to the final
    // replay timestamp with zero frames.
    expect(lanes.occupiedCount()).toBe(2);
    const laneSessions = lanes.snapshot().lanes.flatMap((lane) => lane.sessions);
    expect(laneSessions.map((ref) => ref.sessionId)).toContain("replay-1:claude-session");
    expect(laneSessions.map((ref) => ref.sessionId)).toContain("replay-2:codex-session");
    expect(frames.filter((frame) => frame.type === "events")).not.toHaveLength(0);
    await replay;
    expect(lanes.occupiedCount()).toBe(2);
  });

  it("keeps waiting when the wall clock jumps backward during a pacing sleep", async () => {
    const fx = harness();
    const events = [
      sessionStartEvent("rollback-s"),
      drillEvent({ sessionId: "rollback-s", kind: "turn.start", ts: 2000, receivedAt: 2000 }),
    ];
    // session.start at ts 1000, turn.start at ts 2000: two batches 1000
    // engine-ms apart at speed 1.
    let wall = 0;
    const sleeps: number[] = [];
    const summaries = await replayRecordings(
      [{ label: "rollback.jsonl", text: recordingText("claude-code", events) }],
      fx.deps,
      {
        speed: 1,
        anchorNow: 0,
        restoreClock: false,
        wallNow: () => wall,
        sleep: (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 1) {
            // A wall-clock rollback mid-wait (NTP step, suspend/resume): the
            // first sleep ends with wall time earlier than when it began.
            wall = -5000;
          } else {
            wall += ms;
          }
          return Promise.resolve();
        },
      },
    );
    // The recheck recomputes the remaining wait instead of feeding after one
    // sleep: batch two is due at wall 1000, the first sleep ends at -5000,
    // so the second sleep covers the full remaining 6000.
    expect(sleeps).toEqual([1000, 6000]);
    expect(wall).toBe(1000);
    expect(summaries[0]?.eventCount).toBe(2);
    expect(fx.engineCalls).toHaveLength(2);
    fx.cleanup();
  });

  it("matches the current recording schema version", () => {
    expect(RECORDING_SCHEMA_VERSION).toBe(1);
  });
});
