// packages/daemon/test/ws-broadcast.test.ts — the WebSocket broadcast
// protocol: a full snapshot on connect, coalesced event frames at ≤10 Hz,
// and a fresh snapshot after reconnect (the reconnect contract).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Scheduler, ServerMessage } from "../src/broadcast.js";
import { type DaemonRuntime, startDaemon } from "../src/server.js";
import { drillClaudeShapedAdapter, drillEvent, sessionStartEvent } from "./doubles.js";

const runtimes: DaemonRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
  }
});

async function startServer(): Promise<DaemonRuntime> {
  const runtime = await startDaemon({
    config: {
      host: "127.0.0.1",
      port: 0,
      lanes: 3,
      laneReleaseAfterMs: 60_000,
      dataDir: mkdtempSync(join(tmpdir(), "hearable-ws-")),
    },
    adapters: [drillClaudeShapedAdapter],
  });
  runtimes.push(runtime);
  return runtime;
}

function connect(url: string): { socket: WebSocket; messages: ServerMessage[] } {
  const wsUrl = url.replace(/^http/, "ws");
  const socket = new WebSocket(`${wsUrl}/ws`);
  const messages: ServerMessage[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as ServerMessage);
  });
  return { socket, messages };
}

function awaitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolvePromise();
      return;
    }
    socket.addEventListener("open", () => resolvePromise(), { once: true });
    socket.addEventListener("error", () => rejectPromise(new Error("websocket failed to open")), {
      once: true,
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const sleepMs = 250;

class ManualDaemonScheduler implements Scheduler {
  private current = 0;
  private sequence = 0;
  private readonly jobs: {
    dueAt: number;
    sequence: number;
    fn: () => void;
    cancelled: boolean;
  }[] = [];

  now(): number {
    return this.current;
  }

  schedule(fn: () => void, ms: number): () => void {
    const job = { dueAt: this.current + ms, sequence: this.sequence++, fn, cancelled: false };
    this.jobs.push(job);
    return () => {
      job.cancelled = true;
    };
  }

  advanceTo(target: number): void {
    for (;;) {
      this.jobs.sort((left, right) => left.dueAt - right.dueAt || left.sequence - right.sequence);
      const job = this.jobs[0];
      if (job === undefined || job.dueAt > target) {
        break;
      }
      this.jobs.shift();
      if (job.cancelled) {
        continue;
      }
      this.current = job.dueAt;
      job.fn();
    }
    this.current = target;
    this.jobs.splice(0, this.jobs.length, ...this.jobs.filter((job) => !job.cancelled));
  }
}

describe("WebSocket broadcast", () => {
  it("pushes a full snapshot on connect", async () => {
    const runtime = await startServer();
    const { socket, messages } = connect(runtime.url);
    await awaitOpen(socket);
    await sleep(50);
    expect(messages[0]?.type).toBe("snapshot");
    const snapshot = messages[0] as Extract<ServerMessage, { type: "snapshot" }>;
    expect(snapshot.lanes).toHaveLength(3);
    expect(snapshot.queued).toEqual([]);
    socket.close();
  });

  it("emits coalesced event frames at at most one frame per flush window", async () => {
    const runtime = await startServer();
    const { socket, messages } = connect(runtime.url);
    await awaitOpen(socket);
    // Three bursts land inside the same 100 ms window.
    for (const session of ["a", "b", "c"]) {
      await postEvents(runtime.url, [sessionStartEvent(session)]);
    }
    await sleep(500);
    const eventFrames = messages.filter((msg) => msg.type === "events");
    expect(eventFrames.length).toBeGreaterThanOrEqual(1);
    // Each burst was small and fast; the broadcaster must have coalesced them
    // into at most two frames rather than one per burst.
    expect(eventFrames.length).toBeLessThanOrEqual(2);
    const ids = eventFrames.flatMap((frame) =>
      (frame as Extract<ServerMessage, { type: "events" }>).events.map((event) => event.sessionId),
    );
    expect(new Set(ids)).toEqual(new Set(["a", "b", "c"]));
    expect(eventFrames.at(-1)?.signals[0]).toEqual(
      expect.objectContaining({
        prominence: expect.any(Number),
        foreground: expect.any(Boolean),
        gestures: expect.any(Array),
      }),
    );
    socket.close();
  });

  it("carries lane occupancy on event frames, without a reconnect", async () => {
    const runtime = await startServer();
    const { socket, messages } = connect(runtime.url);
    await awaitOpen(socket);
    await sleep(50);
    // The connect-time snapshot is the only lane truth this client will ever
    // be sent unless event frames carry it, and it predates the session.
    const snapshot = messages[0] as Extract<ServerMessage, { type: "snapshot" }>;
    expect(snapshot.lanes.every((lane) => lane.state === "free")).toBe(true);

    await postEvents(runtime.url, [sessionStartEvent("late-session")]);
    await sleep(sleepMs);

    const frames = messages.filter((msg) => msg.type === "events");
    const latest = frames.at(-1) as Extract<ServerMessage, { type: "events" }> | undefined;
    const laneSessions = (latest?.lanes ?? []).flatMap((lane) =>
      lane.sessions.map((ref) => ref.sessionId),
    );
    expect(laneSessions).toContain("late-session");
    expect(latest?.queued).toEqual([]);
    socket.close();
  });

  it("reports a lane freed by the idle timer on the next event frame", async () => {
    const scheduler = new ManualDaemonScheduler();
    const runtime = await startDaemon({
      config: {
        host: "127.0.0.1",
        port: 0,
        lanes: 3,
        laneReleaseAfterMs: 1_000,
        dataDir: mkdtempSync(join(tmpdir(), "hearable-ws-release-")),
      },
      adapters: [drillClaudeShapedAdapter],
      scheduler,
      clock: () => scheduler.now(),
    });
    runtimes.push(runtime);
    const { socket, messages } = connect(runtime.url);
    await awaitOpen(socket);
    await postEvents(runtime.url, [sessionStartEvent("expiring-session")]);
    await sleep(sleepMs);
    // Past the release window: the lane frees on a timer, so no event of its
    // own will ever tell the browser about it.
    scheduler.advanceTo(5_000);
    await sleep(sleepMs);

    const frames = messages.filter((msg) => msg.type === "events");
    const latest = frames.at(-1) as Extract<ServerMessage, { type: "events" }> | undefined;
    expect(latest?.lanes?.every((lane) => lane.state === "free")).toBe(true);
    socket.close();
  });

  it("sends a fresh full snapshot after a reconnect", async () => {
    const runtime = await startServer();
    const first = connect(runtime.url);
    await awaitOpen(first.socket);
    await sleep(50);
    await postEvents(runtime.url, [sessionStartEvent("reconnect-session")]);
    await postEvents(runtime.url, [
      drillEvent({ sessionId: "reconnect-session", kind: "turn.start" }),
      drillEvent({
        sessionId: "reconnect-session",
        kind: "permission.request",
        lifecycle: { reason: "permission", confidence: "observed" },
      }),
    ]);
    await sleep(sleepMs);
    first.socket.close();

    const second = connect(runtime.url);
    await awaitOpen(second.socket);
    await sleep(50);
    const snapshot = second.messages[0] as Extract<ServerMessage, { type: "snapshot" }> | undefined;
    expect(snapshot?.type).toBe("snapshot");
    const laneSessions = (snapshot?.lanes ?? []).flatMap((lane) =>
      lane.sessions.map((ref) => ref.sessionId),
    );
    expect(laneSessions).toContain("reconnect-session");
    expect(snapshot?.signals).toEqual([
      expect.objectContaining({
        sessionId: "reconnect-session",
        lifecycle: "waiting",
        waitingReason: "permission",
        activity: expect.any(Number),
        progress: expect.any(Number),
        struggle: expect.any(Number),
        mode: expect.objectContaining({ exploring: expect.any(Number) }),
        reasons: expect.any(Array),
        fidelity: null,
        prominence: expect.any(Number),
        foreground: expect.any(Boolean),
        gestures: expect.any(Array),
      }),
    ]);
    expect(snapshot?.calm).toBe(0.6);
    second.socket.close();
  });

  it("persists Calm through restart and changes active-lane prominence", async () => {
    const scheduler = new ManualDaemonScheduler();
    const dataDir = mkdtempSync(join(tmpdir(), "hearable-ws-calm-"));
    writeFileSync(join(dataDir, "calm.json"), JSON.stringify({ calm: 0.9 }));
    const runtime = await startDaemon({
      config: {
        host: "127.0.0.1",
        port: 0,
        lanes: 3,
        laneReleaseAfterMs: 60_000,
        dataDir,
      },
      adapters: [drillClaudeShapedAdapter],
      clock: () => scheduler.now(),
      scheduler,
    });
    runtimes.push(runtime);
    const client = connect(runtime.url);
    await awaitOpen(client.socket);
    await sleep(10);
    expect((client.messages[0] as Extract<ServerMessage, { type: "snapshot" }>).calm).toBe(0.9);

    await postEvents(runtime.url, [drillEvent({ sessionId: "calm-session", kind: "turn.start" })]);
    scheduler.advanceTo(100);
    await sleep(10);
    const persistedFrame = latestEventFrame(client.messages, 0.9);
    const quietProminence = persistedFrame?.signals.find(
      (signal) => signal.sessionId === "calm-session",
    )?.prominence;
    expect(quietProminence).toEqual(expect.any(Number));

    await postEvents(runtime.url, [
      drillEvent({ sessionId: "waiting-session", kind: "turn.start", id: "waiting-start" }),
      drillEvent({
        sessionId: "waiting-session",
        kind: "permission.request",
        id: "waiting-permission",
        lifecycle: { reason: "permission", confidence: "observed" },
      }),
    ]);
    scheduler.advanceTo(200);
    await sleep(10);
    const waitingBeforeCalm = latestSignalFor(client.messages, "waiting-session")?.prominence;
    expect(waitingBeforeCalm).toEqual(expect.any(Number));

    const response = await fetch(`${runtime.url}/calm`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ calm: 1 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ calm: 1 });
    scheduler.advanceTo(200);
    scheduler.advanceTo(300);
    await sleep(10);
    const calmFrame = latestEventFrame(client.messages, 1);
    expect(
      calmFrame?.signals.find((signal) => signal.sessionId === "calm-session")?.prominence,
    ).toBeLessThan(quietProminence as number);
    expect(latestSignalFor(client.messages, "waiting-session")?.prominence).toBeGreaterThanOrEqual(
      (waitingBeforeCalm as number) - 0.01,
    );
    client.socket.close();
  });

  it("falls back to default Calm and reports an actionable health warning", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hearable-ws-invalid-calm-"));
    writeFileSync(join(dataDir, "calm.json"), "not json");
    const runtime = await startDaemon({
      config: {
        host: "127.0.0.1",
        port: 0,
        lanes: 3,
        laneReleaseAfterMs: 60_000,
        dataDir,
      },
      adapters: [drillClaudeShapedAdapter],
    });
    runtimes.push(runtime);
    const health = (await (await fetch(`${runtime.url}/health`)).json()) as {
      calmWarning: string | null;
    };
    expect(health.calmWarning).toContain("using default Calm 0.6");
  });

  it("holds foreground against a louder challenger, then pre-empts on hold expiry or waiting", async () => {
    const scheduler = new ManualDaemonScheduler();
    const runtime = await startDaemon({
      config: {
        host: "127.0.0.1",
        port: 0,
        lanes: 3,
        laneReleaseAfterMs: 60_000,
        dataDir: mkdtempSync(join(tmpdir(), "hearable-ws-attention-")),
      },
      adapters: [drillClaudeShapedAdapter],
      clock: () => scheduler.now(),
      scheduler,
    });
    runtimes.push(runtime);
    const client = connect(runtime.url);
    await awaitOpen(client.socket);
    await sleep(10);

    await fetch(`${runtime.url}/calm`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ calm: 0 }),
    });
    scheduler.advanceTo(100);
    await postEvents(runtime.url, [drillEvent({ sessionId: "holder", kind: "turn.start" })]);
    scheduler.advanceTo(200);
    await sleep(10);
    expect(latestSignalFor(client.messages, "holder")?.foreground).toBe(true);

    scheduler.advanceTo(5_000);
    await postEvents(runtime.url, [
      drillEvent({ sessionId: "challenger", kind: "turn.start", id: "challenger-start" }),
      ...Array.from({ length: 4 }, (_, index) =>
        drillEvent({
          sessionId: "challenger",
          kind: "tool.fail",
          id: `challenger-fail-${index}`,
          tool: {
            name: "Bash",
            category: "exec",
            execKind: "run",
            fingerprint: "challenger-fingerprint",
            outcome: { ok: false },
          },
        }),
      ),
    ]);
    scheduler.advanceTo(5_100);
    await sleep(10);
    const challengedHolder = latestSignalFor(client.messages, "holder");
    const challenger = latestSignalFor(client.messages, "challenger");
    expect(challenger?.prominence).toBeGreaterThan(challengedHolder?.prominence ?? 1);
    expect(challengedHolder?.foreground).toBe(true);
    expect(challenger?.foreground).toBe(false);

    scheduler.advanceTo(16_000);
    await sleep(10);
    expect(
      latestSignalFor(client.messages, "challenger")?.foreground,
      JSON.stringify({
        holder: latestSignalFor(client.messages, "holder"),
        challenger: latestSignalFor(client.messages, "challenger"),
      }),
    ).toBe(true);
    expect(latestSignalFor(client.messages, "holder")?.foreground).toBe(false);

    scheduler.advanceTo(17_000);
    await postEvents(runtime.url, [
      drillEvent({ sessionId: "waiting", kind: "turn.start", id: "waiting-start" }),
      drillEvent({
        sessionId: "waiting",
        kind: "permission.request",
        lifecycle: { reason: "permission", confidence: "observed" },
      }),
    ]);
    scheduler.advanceTo(17_100);
    await sleep(10);
    expect(latestSignalFor(client.messages, "waiting")?.lifecycle).toBe("waiting");
    expect(latestSignalFor(client.messages, "waiting")?.foreground).toBe(true);
    expect(latestSignalFor(client.messages, "challenger")?.foreground).toBe(false);
    client.socket.close();
  });

  it("advances quiet and stale over HTTP and WS without another event", async () => {
    const scheduler = new ManualDaemonScheduler();
    const runtime = await startDaemon({
      config: {
        host: "127.0.0.1",
        port: 0,
        lanes: 3,
        laneReleaseAfterMs: 600_000,
        dataDir: mkdtempSync(join(tmpdir(), "hearable-ws-fake-clock-")),
      },
      adapters: [drillClaudeShapedAdapter],
      clock: () => scheduler.now(),
      scheduler,
    });
    runtimes.push(runtime);

    const client = connect(runtime.url);
    await awaitOpen(client.socket);
    await postEvents(runtime.url, [drillEvent({ sessionId: "timer-session", kind: "turn.start" })]);
    const health = (await (await fetch(`${runtime.url}/health`)).json()) as {
      lanesOccupied: number;
    };
    expect(health.lanesOccupied).toBe(1);
    scheduler.advanceTo(100);
    await waitForLifecycle(client, "active");

    scheduler.advanceTo(90_100);
    await waitForLifecycle(client, "quiet");

    scheduler.advanceTo(480_100);
    await waitForLifecycle(client, "stale");
    client.socket.close();
  });
});

function latestSignal(
  messages: readonly ServerMessage[],
):
  | Extract<ServerMessage, { type: "events" }>["signals"][number]
  | Extract<ServerMessage, { type: "snapshot" }>["signals"][number]
  | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const signal = messages[index]?.signals[0];
    if (signal !== undefined) {
      return signal;
    }
  }
  return undefined;
}

function latestSignalFor(
  messages: readonly ServerMessage[],
  sessionId: string,
): Extract<ServerMessage, { type: "events" }>["signals"][number] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const signal = messages[index]?.signals.find((candidate) => candidate.sessionId === sessionId);
    if (signal !== undefined) return signal;
  }
  return undefined;
}

function latestEventFrame(
  messages: readonly ServerMessage[],
  calm: number,
): Extract<ServerMessage, { type: "events" }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === "events" && message.calm === calm) return message;
  }
  return undefined;
}

function waitForLifecycle(
  client: { socket: WebSocket; messages: ServerMessage[] },
  lifecycle: string,
): Promise<void> {
  return new Promise((resolvePromise) => {
    const check = () => {
      if (latestSignal(client.messages)?.lifecycle === lifecycle) {
        client.socket.removeEventListener("message", check);
        resolvePromise();
      }
    };
    client.socket.addEventListener("message", check);
    check();
  });
}

async function postEvents(url: string, events: unknown[]): Promise<void> {
  await fetch(`${url}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hearable-normalized": "1" },
    body: JSON.stringify(events),
  });
}
