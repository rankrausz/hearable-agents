// packages/cli/test/live-drill.test.ts — the task's live drill, automated by
// spawning the actual `hearable` binary with a throwaway config (ephemeral
// port, temp data dir). It proves the real command surface end to end:
// `start` then a second `start` refusing plainly; the health and console root
// responses; `record --name drill --raw`
// accepting a normalized and a raw wire-form POST, `--stop` finalising a JSONL
// with a header line plus the raw sidecar; `replay <file> --speed 10` putting
// the replayed events on the real WebSocket feed; and an unreadable schema
// version failing loudly with the daemon lock released afterwards.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultLocalRecordingsDir } from "../src/run.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(PKG_ROOT, "src", "bin.ts");
const LOADER = join(PKG_ROOT, "src", "ts-loader.mjs");

const children: ChildProcess[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function spawnHearable(
  args: readonly string[],
  configFile: string,
  webRoot?: string,
): {
  child: ChildProcess;
  output: () => string;
  stderrText: () => string;
} {
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--experimental-transform-types", "--import", LOADER, BIN, ...args],
    {
      cwd: PKG_ROOT,
      env: {
        ...process.env,
        HEARABLE_CONFIG_FILE: configFile,
        // The drill is hermetic to the web build (p4-t08): the spawned daemon
        // serves this throwaway root, so its console assertions hold whether
        // or not apps/web/dist exists.
        ...(webRoot === undefined ? {} : { HEARABLE_WEB_ROOT: webRoot }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  let out = "";
  let errText = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    errText += chunk.toString("utf8");
  });
  return { child, output: () => out, stderrText: () => errText };
}

function waitForText(
  output: () => string,
  predicate: (text: string) => boolean,
  timeoutMs = 15000,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const poll = () => {
      const text = output();
      if (predicate(text)) {
        resolvePromise(text);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        rejectPromise(new Error(`timed out waiting for output:\n${text.slice(0, 400)}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise(child.exitCode);
      return;
    }
    child.once("exit", (code) => resolvePromise(code));
  });
}

function killGracefully(child: ChildProcess): Promise<number | null> {
  child.kill("SIGTERM");
  return waitForExit(child);
}

function newDataDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hearable-cli-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

/** A throwaway audio renderer root: empty by default, or with an index.html
 * written when a "built" console is wanted. The drill points the spawned
 * daemon here so its assertions never depend on the checkout's apps/web/dist. */
function newWebRoot(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hearable-cli-webroot-"));
  tmpDirs.push(dir);
  if (contents !== undefined) {
    writeFileSync(join(dir, "index.html"), contents, "utf8");
  }
  return dir;
}

function writeConfig(dataDir: string): string {
  const configFile = join(dataDir, "config.json");
  writeFileSync(configFile, JSON.stringify({ port: 0, dataDir }), "utf8");
  return configFile;
}

function firstUrl(text: string): string {
  const match = text.match(/http:\/\/\d+\.\d+\.\d+\.\d+:\d+/);
  if (match === null) {
    throw new Error(`no http URL printed in:\n${text}`);
  }
  return match[0] ?? "";
}

function recordingFileText(events: Array<Record<string, unknown>>): string {
  const header = JSON.stringify({
    hearable: "session",
    v: 1,
    recordedAt: 1,
    agent: "claude-code",
    annotations: "demo.annotations.json",
  });
  return `${header}\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

type WireMessage = { type: "snapshot" } | { type: "events"; events: Array<{ kind: string }> };

describe("live drill", () => {
  it("record --name --raw accepts both wire forms and --stop writes a JSONL with header plus sidecar", async () => {
    const dataDir = newDataDir("record");
    const configFile = writeConfig(dataDir);
    const record = spawnHearable(["record", "--name", "drill", "--raw"], configFile);
    const line = await waitForText(record.output, (text) => text.includes("is listening at"));
    const url = firstUrl(line);

    const normalized = await fetch(`${url}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hearable-normalized": "1" },
      body: JSON.stringify([
        {
          v: 1,
          id: "e-drill-1",
          ts: 1_700_000_000_000,
          receivedAt: 1_700_000_000_000,
          agent: "claude-code",
          sessionId: "drill",
          kind: "session.start",
        },
      ]),
    });
    expect(normalized.status).toBe(204);
    const raw = await fetch(`${url}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hearable-agent": "claude-code" },
      body: JSON.stringify({
        session_id: "drill-raw",
        hook_event_name: "SessionStart",
        cwd: "/repo",
      }),
    });
    expect(raw.status).toBe(204);

    const stop = spawnHearable(["record", "--name", "drill", "--stop"], configFile);
    expect(await waitForExit(stop.child)).toBe(0);
    expect(await waitForExit(record.child)).toBe(0);

    const recordingPath = join(defaultLocalRecordingsDir(), "drill.jsonl");
    const lines = readFileSync(recordingPath, "utf8").trim().split("\n");
    expect(lines[0]).toContain('"hearable":"session"');
    expect(lines[0]).toContain('"v":1');
    const events = lines.slice(1).map((entry) => JSON.parse(entry) as Record<string, unknown>);
    expect(events.map((event) => event.kind)).toEqual(["session.start", "session.start"]);
    // Session ids are re-keyed, never recorded verbatim.
    expect(events.map((event) => event.sessionId)).toEqual(["s1", "s2"]);
    const sidecar = readFileSync(join(defaultLocalRecordingsDir(), "drill.raw.jsonl"), "utf8");
    expect(sidecar.trim()).toContain('"hook_event_name":"SessionStart"');
    rmSync(recordingPath, { force: true });
    rmSync(join(defaultLocalRecordingsDir(), "drill.raw.jsonl"), { force: true });
  });

  it("start runs, a second start refuses plainly, and /health answers", async () => {
    const dataDir = newDataDir("start");
    const configFile = writeConfig(dataDir);
    const emptyWebRoot = newWebRoot();
    const first = spawnHearable(["start"], configFile, emptyWebRoot);
    const line = await waitForText(first.output, (text) =>
      text.includes("The hearable daemon is running at"),
    );
    const url = firstUrl(line);
    const health = (await (await fetch(`${url}/health`)).json()) as { status: string };
    expect(health.status).toBe("ok");
    // The empty-root half of the console contract: without a build the daemon
    // says exactly what to do, in its own unchanged words.
    const console = await fetch(`${url}/`);
    expect(console.status).toBe(404);
    expect(await console.text()).toBe(
      "Hearable is running, but the audio renderer build is not installed yet. Build apps/web and try again.",
    );

    const second = spawnHearable(["start"], configFile, emptyWebRoot);
    expect(await waitForExit(second.child)).toBe(1);
    expect(second.stderrText()).toContain("already running");

    expect(await killGracefully(first.child)).toBe(0);
  });

  it("start serves the built console from a populated web root", async () => {
    const dataDir = newDataDir("start-web");
    const configFile = writeConfig(dataDir);
    const builtWebRoot = newWebRoot("<!doctype html><title>hearable console</title>");
    const daemon = spawnHearable(["start"], configFile, builtWebRoot);
    const line = await waitForText(daemon.output, (text) =>
      text.includes("The hearable daemon is running at"),
    );
    const url = firstUrl(line);
    const console = await fetch(`${url}/`);
    expect(console.status).toBe(200);
    expect(await console.text()).toContain("hearable console");

    expect(await killGracefully(daemon.child)).toBe(0);
  });

  it("replay <file> --speed 10 feeds the live ingest and broadcasts on the WS feed", async () => {
    const dataDir = newDataDir("replay");
    const configFile = writeConfig(dataDir);
    const recordingPath = join(dataDir, "demo.jsonl");
    writeFileSync(
      recordingPath,
      recordingFileText([
        {
          v: 1,
          id: "e1",
          ts: 1000,
          receivedAt: 1000,
          agent: "claude-code",
          sessionId: "demo-s",
          kind: "session.start",
        },
        {
          v: 1,
          id: "e2",
          ts: 3000,
          receivedAt: 3000,
          agent: "claude-code",
          sessionId: "demo-s",
          kind: "turn.start",
        },
      ]),
      "utf8",
    );

    const replay = spawnHearable(["replay", recordingPath, "--speed", "10"], configFile);
    const line = await waitForText(replay.output, (text) =>
      text.includes("Replaying 1 file into the daemon at"),
    );
    const url = firstUrl(line);

    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error("WebSocket did not open in time")),
        5000,
      );
      timer.unref();
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });

    const kinds: string[] = [];
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`no events frame in time; saw ${JSON.stringify(kinds)}`)),
        5000,
      );
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String((event as MessageEvent).data)) as WireMessage;
        if (message.type === "events") {
          kinds.push(...message.events.map((entry) => entry.kind));
          if (kinds.length >= 2) {
            clearTimeout(timer);
            resolvePromise();
          }
        }
      });
    });
    expect(new Set(kinds)).toEqual(new Set(["session.start", "turn.start"]));
    socket.close();

    expect(replay.output()).toMatch(
      /Replayed .*demo\.jsonl: 2 events from claude-code as replay-1\./,
    );
    expect(replay.output()).toContain("at 10x speed");
    expect(await killGracefully(replay.child)).toBe(0);
  });

  it("replay refuses an unreadable schema version and leaves the lock free for a later start", async () => {
    const dataDir = newDataDir("badversion");
    const configFile = writeConfig(dataDir);
    const badFile = join(dataDir, "old.jsonl");
    writeFileSync(
      badFile,
      `${JSON.stringify({ hearable: "session", v: 999, recordedAt: 1, agent: "claude-code", annotations: "x" })}\n`,
      "utf8",
    );
    const replay = spawnHearable(["replay", badFile], configFile);
    expect(await waitForExit(replay.child)).toBe(1);
    expect(replay.stderrText()).toContain("schema version 999");
    // The failed replay released the lock: a fresh start binds without refusal.
    const again = spawnHearable(["start"], configFile);
    await waitForText(again.output, (text) => text.includes("The hearable daemon is running at"));
    expect(await killGracefully(again.child)).toBe(0);
  });
});
