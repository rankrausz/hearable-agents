// Verifies local transport metadata and its privacy boundary; must not inspect real agent payloads.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { parseFocusOrigin, parseFocusProcesses, processAncestry } from "../src/focus-origin.js";
import { startDaemon } from "../src/server.js";
import { drillClaudeShapedAdapter, sessionStartEvent } from "./doubles.js";

const origin = {
  pid: 123,
  termProgram: "iTerm.app",
  itermSessionId: "w0t0p0:unique",
  remote: true,
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
it("ignores malformed focus hints without changing event ingestion", () => {
  for (const value of [
    null,
    "bad",
    encode({ pid: 0 }),
    encode({ ...origin, secret: "no" }),
    encode({ pid: 1, termProgram: "bad\nvalue" }),
    "x".repeat(2049),
  ])
    expect(parseFocusOrigin(value)).toBeNull();
  expect(parseFocusOrigin(encode(origin))).toEqual(origin);
});
it("parses executable paths with spaces and follows ancestry without cycles", () => {
  const processes = parseFocusProcesses(` 30 20 ttys003 Thu Oct 29 12:00:00 2026 /usr/bin/codex
 20 10 ttys003 Thu Oct  9 12:00:00 2026 -zsh
 10 1 ?? Thu Oct 29 12:00:00 2026 /Applications/Test host.app/Contents/MacOS/Test host
 malformed`);
  expect(processAncestry(30, processes).map((row) => row.pid)).toEqual([30, 20, 10]);
  expect(processes[1]?.startedAt).toBe("Thu Oct 9 12:00:00 2026");
  expect(processes[2]?.executable).toContain("Test host.app");
  const first = processes[0];
  if (!first) throw new Error("Expected a parsed process");
  expect(processAncestry(30, [{ ...first, ppid: 30 }])).toHaveLength(1);
  expect(processAncestry(999, processes)).toEqual([]);
});

describe("session focus lookup", () => {
  it("keeps focus hints out of health, public lanes, and both recording seams", async () => {
    const recorded: unknown[] = [];
    const raw: string[] = [];
    const daemon = await startDaemon({
      config: {
        host: "127.0.0.1",
        port: 0,
        lanes: 3,
        laneReleaseAfterMs: 60_000,
        dataDir: mkdtempSync(join(tmpdir(), "hearable-focus-")),
      },
      adapters: [drillClaudeShapedAdapter],
      record: (events) => recorded.push(...events),
      recordRaw: (text) => raw.push(text),
    });
    const lookup = (agent = "claude-code", id = "focus") =>
      `${daemon.url}/session-focus?${new URLSearchParams({ agent, sessionId: id })}`;
    try {
      const body = JSON.stringify({
        session_id: "focus",
        hook_event_name: "SessionStart",
        cwd: "/private/repo",
      });
      const response = await fetch(`${daemon.url}/events`, {
        method: "POST",
        headers: { "x-hearable-agent": "claude-code", "x-hearable-focus": encode(origin) },
        body,
      });
      expect(response.status).toBe(204);
      expect(await (await fetch(lookup())).json()).toEqual({ origin, processes: [] });
      expect((await fetch(lookup("codex"))).status).toBe(404);
      expect((await fetch(lookup("claude-code", "unknown"))).status).toBe(404);
      expect(
        (await fetch(lookup(), { headers: { origin: "https://outside.example" } })).status,
      ).toBe(403);
      const snapshot = await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`${daemon.url.replace("http:", "ws:")}/ws`);
        socket.once("message", (data) => {
          resolve(String(data));
          socket.close();
        });
        socket.once("error", reject);
      });
      expect(snapshot).not.toContain("itermSessionId");
      expect(snapshot).not.toContain("processes");
      const health = JSON.stringify(await (await fetch(`${daemon.url}/health`)).json());
      for (const secret of ["itermSessionId", "termProgram", "private/repo", "processes"]) {
        expect(health).not.toContain(secret);
        expect(JSON.stringify(recorded)).not.toContain(secret);
      }
      expect(raw).toEqual([body]);
      // Normalized producers can supply the same transport hint. Replayers do not.
      await fetch(`${daemon.url}/events`, {
        method: "POST",
        headers: { "x-hearable-normalized": "1", "x-hearable-focus": encode(origin) },
        body: JSON.stringify([sessionStartEvent("normalized")]),
      });
      expect((await fetch(lookup("claude-code", "normalized"))).status).toBe(200);
      await fetch(`${daemon.url}/events`, {
        method: "POST",
        headers: { "x-hearable-normalized": "1" },
        body: JSON.stringify([{ ...sessionStartEvent("focus"), kind: "session.end" }]),
      });
      expect((await fetch(lookup())).status).toBe(404);
    } finally {
      await daemon.stop();
    }
  });
});
