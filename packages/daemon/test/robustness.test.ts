// packages/daemon/test/robustness.test.ts — HTTP/WS robustness drills for
// restart rehydration, clock jumps, same-repository sessions and subagents.
// What this is for: proving the daemon boundary keeps identity and lifecycle
// state coherent when delivery resumes after an outage. What it must not do:
// test core heuristics in isolation or create a second daemon protocol.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Scheduler, ServerMessage } from "../src/broadcast.js";
import type { DaemonConfig } from "../src/config.js";
import { type DaemonRuntime, startDaemon } from "../src/server.js";
import { drillClaudeShapedAdapter, drillEvent, sessionStartEvent } from "./doubles.js";

const runtimes: DaemonRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
  }
});

class FakeScheduler implements Scheduler {
  private nowValue = 0;
  private sequence = 0;
  callbackCount = 0;
  private readonly jobs: {
    dueAt: number;
    sequence: number;
    fn: () => void;
    cancelled: boolean;
  }[] = [];

  now(): number {
    return this.nowValue;
  }

  schedule(fn: () => void, ms: number): () => void {
    const job = {
      dueAt: this.nowValue + ms,
      sequence: this.sequence++,
      fn,
      cancelled: false,
    };
    this.jobs.push(job);
    return () => {
      job.cancelled = true;
    };
  }

  jumpTo(target: number): void {
    this.nowValue = target;
    for (;;) {
      this.jobs.sort((left, right) => left.dueAt - right.dueAt || left.sequence - right.sequence);
      const job = this.jobs[0];
      if (job === undefined || job.dueAt > target) {
        break;
      }
      this.jobs.shift();
      if (!job.cancelled) {
        this.callbackCount += 1;
        job.fn();
      }
    }
    this.jobs.splice(0, this.jobs.length, ...this.jobs.filter((candidate) => !candidate.cancelled));
  }
}

function config(dataDir: string, lanes = 3): DaemonConfig {
  return { host: "127.0.0.1", port: 0, lanes, laneReleaseAfterMs: 60_000, dataDir };
}

async function post(runtime: DaemonRuntime, events: readonly unknown[]): Promise<void> {
  const response = await fetch(`${runtime.url}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hearable-normalized": "1" },
    body: JSON.stringify(events),
  });
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
}

async function postRaw(
  runtime: DaemonRuntime,
  agent: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${runtime.url}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hearable-agent": agent },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
}

function connect(runtime: DaemonRuntime): { socket: WebSocket; frames: ServerMessage[] } {
  const socket = new WebSocket(`${runtime.url.replace(/^http/, "ws")}/ws`);
  const frames: ServerMessage[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as ServerMessage);
  });
  return { socket, frames };
}

function awaitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")), {
      once: true,
    });
  });
}

describe("daemon robustness", () => {
  it("rehydrates in-flight sessions after a daemon restart and snapshots them on WS connect", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hearable-restart-"));
    const firstScheduler = new FakeScheduler();
    const first = await startDaemon({
      config: config(dataDir, 2),
      adapters: [drillClaudeShapedAdapter],
      clock: () => firstScheduler.now(),
      scheduler: firstScheduler,
    });
    runtimes.push(first);
    const reconnecting = connect(first);
    await awaitOpen(reconnecting.socket);
    await post(first, [
      sessionStartEvent("restart-a"),
      sessionStartEvent("restart-b"),
      sessionStartEvent("restart-queued"),
    ]);
    expect(reconnecting.frames[0]?.type).toBe("snapshot");
    reconnecting.socket.close();
    await first.stop();
    runtimes.splice(runtimes.indexOf(first), 1);

    const secondScheduler = new FakeScheduler();
    const second = await startDaemon({
      config: config(dataDir, 2),
      adapters: [drillClaudeShapedAdapter],
      clock: () => secondScheduler.now(),
      scheduler: secondScheduler,
    });
    runtimes.push(second);
    await post(second, [
      sessionStartEvent("restart-a"),
      sessionStartEvent("restart-b"),
      sessionStartEvent("restart-queued"),
    ]);
    const client = connect(second);
    await awaitOpen(client.socket);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshot = client.frames[0] as Extract<ServerMessage, { type: "snapshot" }>;
    expect(
      snapshot.lanes.flatMap((lane) => lane.sessions.map((session) => session.sessionId)),
    ).toEqual(["restart-b", "restart-a"]);
    expect(snapshot.queued.map((session) => session.sessionId)).toEqual(["restart-queued"]);
    expect(snapshot.signals.map((signal) => signal.sessionId)).toEqual(["restart-b", "restart-a"]);
    client.socket.close();
  });

  it("advances once after a sleep-sized clock jump without replaying gesture frames", async () => {
    const scheduler = new FakeScheduler();
    const runtime = await startDaemon({
      config: config(mkdtempSync(join(tmpdir(), "hearable-sleep-"))),
      adapters: [drillClaudeShapedAdapter],
      clock: () => scheduler.now(),
      scheduler,
    });
    runtimes.push(runtime);
    const client = connect(runtime);
    await awaitOpen(client.socket);
    await post(runtime, [drillEvent({ sessionId: "sleep-session", kind: "turn.start" })]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const callbacksBeforeSleep = scheduler.callbackCount;
    scheduler.jumpTo(86_400_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const eventFrames = client.frames.filter((frame) => frame.type === "events");
    // The late wake may run the three daemon tickers plus one coalesced
    // signal flush, but it must not replay the 24-hour backlog of intervals.
    expect(scheduler.callbackCount - callbacksBeforeSleep).toBeLessThan(10);
    expect(eventFrames).toHaveLength(1);
    const gestures = eventFrames.flatMap((frame) =>
      (frame as Extract<ServerMessage, { type: "events" }>).signals.flatMap(
        (signal) => signal.gestures,
      ),
    );
    expect(new Set(gestures.map((gesture) => `${gesture.gesture}:${gesture.at}`)).size).toBe(
      gestures.length,
    );
    expect(eventFrames[0]?.serverTime).toBe(86_400_000);
    client.socket.close();
  });

  it("keeps concurrent sessions in one repository on separate lanes", async () => {
    const runtime = await startDaemon({
      config: config(mkdtempSync(join(tmpdir(), "hearable-same-repo-"))),
      adapters: [drillClaudeShapedAdapter],
    });
    runtimes.push(runtime);
    await postRaw(runtime, "claude-code", {
      session_id: "repo-session-a",
      hook_event_name: "SessionStart",
      cwd: "/repo",
    });
    await postRaw(runtime, "claude-code", {
      session_id: "repo-session-b",
      hook_event_name: "SessionStart",
      cwd: "/repo",
    });
    await postRaw(runtime, "claude-code", {
      session_id: "repo-session-a",
      hook_event_name: "UserPromptSubmit",
      cwd: "/repo",
    });
    await postRaw(runtime, "claude-code", {
      session_id: "repo-session-b",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/repo/b.ts" },
      cwd: "/repo",
    });
    const response = await fetch(`${runtime.url}/health`);
    const health = (await response.json()) as {
      lanes: { laneId: number; sessions: { sessionId: string; name: string }[] }[];
    };
    const occupied = health.lanes.filter((lane) => lane.sessions.length > 0);
    expect(occupied).toHaveLength(2);
    expect(occupied.flatMap((lane) => lane.sessions.map((session) => session.sessionId))).toEqual([
      "repo-session-b",
      "repo-session-a",
    ]);
    expect(occupied.map((lane) => lane.sessions[0]?.name)).toEqual(["repo", "repo"]);
    const client = connect(runtime);
    await awaitOpen(client.socket);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshot = client.frames[0] as Extract<ServerMessage, { type: "snapshot" }>;
    expect(snapshot.signals.map((signal) => signal.sessionId)).toEqual([
      "repo-session-b",
      "repo-session-a",
    ]);
    for (const lane of occupied) {
      const sessionId = lane.sessions[0]?.sessionId;
      expect(snapshot.signals).toContainEqual(
        expect.objectContaining({ laneId: lane.laneId, sessionId }),
      );
    }
    client.socket.close();
  });

  it("folds subagent start and stop into the parent lane through HTTP ingest", async () => {
    const runtime = await startDaemon({
      config: config(mkdtempSync(join(tmpdir(), "hearable-subagent-"))),
      adapters: [drillClaudeShapedAdapter],
    });
    runtimes.push(runtime);
    await postRaw(runtime, "claude-code", {
      session_id: "parent-session",
      hook_event_name: "SessionStart",
      cwd: "/repo",
    });
    await postRaw(runtime, "claude-code", {
      session_id: "parent-session",
      agent_id: "child-session",
      hook_event_name: "SubagentStart",
      cwd: "/repo",
    });
    const before = (await (await fetch(`${runtime.url}/health`)).json()) as {
      lanes: { sessions: { sessionId: string }[] }[];
    };
    expect(before.lanes.filter((lane) => lane.sessions.length > 0)).toHaveLength(1);
    expect(before.lanes[1]?.sessions.map((session) => session.sessionId)).toEqual([
      "parent-session",
      "child-session",
    ]);
    await postRaw(runtime, "claude-code", {
      session_id: "parent-session",
      agent_id: "child-session",
      hook_event_name: "SubagentStop",
      cwd: "/repo",
    });
    const after = (await (await fetch(`${runtime.url}/health`)).json()) as {
      lanes: { sessions: { sessionId: string }[] }[];
    };
    expect(after.lanes[1]?.sessions.map((session) => session.sessionId)).toEqual([
      "parent-session",
    ]);
  });
});
