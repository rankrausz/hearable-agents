// packages/daemon/test/live-drill.test.ts — the task's live drill, automated:
// start the daemon, POST one raw Claude-shaped payload and one normalized
// batch, observe 204s, lanes in /health, and WS frames in a minimal client
// script; then the malformed-payload drill: garbage still gets 204, the
// quarantine file grows and /health counts it. This spins the real HTTP + WS
// server on an ephemeral port with a throwaway data directory and a drill
// adapter, so it exercises exactly the code live hooks contact.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/broadcast.js";
import type { HealthReport } from "../src/health.js";
import { quarantineDirectory } from "../src/quarantine.js";
import { type DaemonRuntime, startDaemon } from "../src/server.js";
import { drillClaudeShapedAdapter, drillEvent, sessionStartEvent } from "./doubles.js";

const runtimes: DaemonRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function connectWs(url: string): {
  socket: WebSocket;
  frames: ServerMessage[];
  waitFor(predicate: (frame: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
} {
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
  const frames: ServerMessage[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as ServerMessage);
  });
  const waitFor = (predicate: (frame: ServerMessage) => boolean, timeoutMs = 2000) =>
    new Promise<ServerMessage>((resolvePromise, rejectPromise) => {
      const started = Date.now();
      const poll = () => {
        const match = frames.find(predicate);
        if (match !== undefined) {
          resolvePromise(match);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          rejectPromise(
            new Error(`timed out waiting for a matching frame (got ${frames.length} frames)`),
          );
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
  return { socket, frames, waitFor };
}

describe("live drill", () => {
  it("ingests a raw and a normalized payload, shows lanes in /health and pushes WS frames", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hearable-drill-"));
    const runtime = await startDaemon({
      config: { host: "127.0.0.1", port: 0, lanes: 3, laneReleaseAfterMs: 60_000, dataDir },
      adapters: [drillClaudeShapedAdapter],
    });
    runtimes.push(runtime);
    console.log(`\nlive drill: daemon started on ${runtime.url}`);

    const rawResponse = await fetch(`${runtime.url}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hearable-agent": "claude-code" },
      body: JSON.stringify({
        session_id: "drill-claude",
        hook_event_name: "SessionStart",
        cwd: "/repo",
      }),
    });
    const normalizedResponse = await fetch(`${runtime.url}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hearable-normalized": "1" },
      body: JSON.stringify([
        sessionStartEvent("drill-normalized"),
        drillEvent({ sessionId: "drill-normalized", kind: "turn.start" }),
      ]),
    });

    expect(rawResponse.status).toBe(204);
    expect(await rawResponse.text()).toBe("");
    expect(normalizedResponse.status).toBe(204);
    expect(await normalizedResponse.text()).toBe("");
    console.log("live drill: raw POST → 204, normalized POST → 204 (empty bodies)");

    const health = (await (await fetch(`${runtime.url}/health`)).json()) as HealthReport;
    expect(health.status).toBe("ok");
    expect(health.quarantineCount).toBe(0);
    expect(health.lanesOccupied).toBe(2);
    const laneSessions = health.lanes.flatMap((lane) => lane.sessions.map((ref) => ref.sessionId));
    expect(laneSessions).toEqual(expect.arrayContaining(["drill-claude", "drill-normalized"]));
    expect(health.sessionsByAgent).toEqual({ "claude-code": 2 });
    console.log(
      `live drill: /health shows 2 occupied lanes, lanes=${JSON.stringify(health.lanes)}`,
    );

    const client = connectWs(runtime.url);
    const socketOpen = new Promise<void>((resolvePromise) =>
      socketAddOpen(client.socket, resolvePromise),
    );
    await socketOpen;
    await sleep(50);
    const snapshot = client.frames[0] as Extract<ServerMessage, { type: "snapshot" }> | undefined;
    expect(snapshot?.type).toBe("snapshot");
    const snapshotSessions = (snapshot?.lanes ?? []).flatMap((lane) =>
      lane.sessions.map((ref) => ref.sessionId),
    );
    expect(snapshotSessions).toEqual(expect.arrayContaining(["drill-claude", "drill-normalized"]));
    console.log(
      `live drill: WS client connected, snapshot on connect = ${JSON.stringify(snapshot?.lanes)}`,
    );

    await fetch(`${runtime.url}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hearable-normalized": "1" },
      body: JSON.stringify([drillEvent({ sessionId: "drill-normalized", kind: "tool.start" })]),
    });
    const eventFrame = await client.waitFor(
      (frame) =>
        frame.type === "events" &&
        frame.events.some(
          (event) => event.sessionId === "drill-normalized" && event.kind === "tool.start",
        ),
    );
    const events = (eventFrame as Extract<ServerMessage, { type: "events" }>).events;
    expect(events.map((event) => event.kind)).toContain("tool.start");
    console.log(`live drill: WS frame after POST: ${JSON.stringify(events)}`);

    client.socket.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("handles malformed payloads: 204, quarantine file grows, /health counts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hearable-drill-bad-"));
    const runtime = await startDaemon({
      config: { host: "127.0.0.1", port: 0, lanes: 3, laneReleaseAfterMs: 60_000, dataDir },
      adapters: [drillClaudeShapedAdapter],
    });
    runtimes.push(runtime);
    console.log(`\nmalformed drill: daemon started on ${runtime.url}`);

    const response = await fetch(`${runtime.url}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hearable-agent": "claude-code" },
      body: "{ definitely not json",
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    console.log("malformed drill: garbage POST → 204");

    const dir = quarantineDirectory(dataDir);
    const files = readdirSync(dir);
    expect(files).toContain("quarantine.jsonl");
    const body = readFileSync(join(dir, "quarantine.jsonl"), "utf8");
    expect(body).toContain("not valid JSON");
    console.log(`malformed drill: quarantine file wrote a line (${body.trim().slice(0, 80)}…)`);

    const health = (await (await fetch(`${runtime.url}/health`)).json()) as HealthReport;
    expect(health.quarantineCount).toBe(1);
    console.log(`malformed drill: /health quarantineCount=${health.quarantineCount}`);
    rmSync(dataDir, { recursive: true, force: true });
  });
});

function socketAddOpen(socket: WebSocket, resolvePromise: () => void): void {
  if (socket.readyState === WebSocket.OPEN) {
    resolvePromise();
    return;
  }
  socket.addEventListener("open", resolvePromise, { once: true });
}
