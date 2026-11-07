// packages/daemon/test/server.test.ts — the real HTTP surface: POST /events
// always 204 with an empty body, GET /health reports the documented fields,
// and static web serving follows the convention (serve apps/web/dist when its
// index.html is present, plain 404 otherwise — a directory of tsc compiler
// output alone is not a build), all against a started daemon on an ephemeral
// port with a throwaway data directory.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonConfig } from "../src/config.js";
import type { HealthReport } from "../src/health.js";
import { type DaemonRuntime, startDaemon } from "../src/server.js";
import { drillClaudeShapedAdapter, sessionStartEvent } from "./doubles.js";

const runtimes: DaemonRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
  }
});

async function startServer(overrides?: Partial<DaemonConfig>): Promise<{ runtime: DaemonRuntime }> {
  const runtime = await startDaemon({
    config: {
      host: "127.0.0.1",
      port: 0,
      lanes: 3,
      laneReleaseAfterMs: 60_000,
      dataDir: mkdtempSync(join(tmpdir(), "hearable-server-")),
      ...overrides,
    },
    adapters: [drillClaudeShapedAdapter],
    // Hermetic web root: a path that does not exist, inside a temp dir, so
    // static-serving behaviour in these tests never depends on whether
    // apps/web/dist exists locally (e.g. after a root typecheck emits the
    // console build). The positive static-serving test below passes its
    // own real build dir explicitly.
    webRoot: join(mkdtempSync(join(tmpdir(), "hearable-no-webroot-")), "missing"),
  });
  runtimes.push(runtime);
  return { runtime };
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return { status: response.status, text: await response.text() };
}

async function getHealth(url: string): Promise<HealthReport> {
  const response = await fetch(`${url}/health`);
  return (await response.json()) as HealthReport;
}

/** True when this machine has the IPv6 loopback `::1` to bind to. */
function ipv6LoopbackAvailable(): boolean {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv6" && address.address === "::1") {
        return true;
      }
    }
  }
  return false;
}

describe("POST /events", () => {
  it("answers 204 with an empty body for the raw wire form", async () => {
    const { runtime } = await startServer();
    const result = await post(
      `${runtime.url}/events`,
      JSON.stringify({ session_id: "s-http-raw", hook_event_name: "SessionStart" }),
      { "x-hearable-agent": "claude-code" },
    );
    expect(result.status).toBe(204);
    expect(result.text).toBe("");
    const health = await getHealth(runtime.url);
    expect(health.quarantineCount).toBe(0);
    expect(health.lanesOccupied).toBe(1);
  });

  it("answers 204 with an empty body for the normalized wire form", async () => {
    const { runtime } = await startServer();
    const result = await post(
      `${runtime.url}/events`,
      JSON.stringify([sessionStartEvent("s-http-norm")]),
      { "x-hearable-normalized": "1" },
    );
    expect(result.status).toBe(204);
    expect(result.text).toBe("");
    const health = await getHealth(runtime.url);
    expect(health.sessionsByAgent["claude-code"]).toBe(1);
  });

  it("answers 204 even for malformed garbage and increments the quarantine count", async () => {
    const { runtime } = await startServer();
    const result = await post(`${runtime.url}/events`, "garbage not json", {
      "x-hearable-agent": "claude-code",
    });
    expect(result.status).toBe(204);
    expect(result.text).toBe("");
    const health = await getHealth(runtime.url);
    expect(health.quarantineCount).toBe(1);
  });

  it("answers 204 for an oversized body instead of dropping the connection", async () => {
    const { runtime } = await startServer();
    const big = "x".repeat(6 * 1024 * 1024);
    const result = await post(`${runtime.url}/events`, big, { "x-hearable-normalized": "1" });
    expect(result.status).toBe(204);
    expect(result.text).toBe("");
    const health = await getHealth(runtime.url);
    expect(health.quarantineCount).toBe(1);
  });
});

describe("GET /health", () => {
  it("reports liveness, version, quarantine count, lane and adapter counts", async () => {
    const { runtime } = await startServer();
    await post(`${runtime.url}/events`, JSON.stringify([sessionStartEvent("s-health-a")]), {
      "x-hearable-normalized": "1",
    });
    await post(`${runtime.url}/events`, JSON.stringify([sessionStartEvent("s-health-b")]), {
      "x-hearable-normalized": "1",
    });
    const health = await getHealth(runtime.url);
    expect(health.status).toBe("ok");
    expect(health.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(health.quarantineCount).toBe(0);
    expect(health.lanesTotal).toBe(3);
    expect(health.lanesOccupied).toBe(2);
    expect(health.lanes).toHaveLength(3);
    expect(health.sessionsByAgent).toEqual({ "claude-code": 2 });
  });

  it("reports extra sessions as queued when all lanes are occupied", async () => {
    const { runtime } = await startServer();
    for (const session of ["q-a", "q-b", "q-c", "q-d", "q-e"]) {
      await post(`${runtime.url}/events`, JSON.stringify([sessionStartEvent(session)]), {
        "x-hearable-normalized": "1",
      });
    }
    const health = await getHealth(runtime.url);
    expect(health.lanesOccupied).toBe(3);
    expect(health.queued.map((ref) => ref.sessionId)).toEqual(["q-d", "q-e"]);
    expect(health.sessionsByAgent).toEqual({ "claude-code": 5 });
  });
});

describe("bind host", () => {
  // IPv6 loopback is not present on every machine (e.g. some containers); skip
  // rather than let the environment decide the verdict.
  it.skipIf(!ipv6LoopbackAvailable())(
    "formats an IPv6 loopback URL with brackets and serves requests over it",
    async () => {
      const { runtime } = await startServer({ host: "::1" });
      expect(runtime.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
      const response = await fetch(`${runtime.url}/health`);
      expect(response.status).toBe(200);
      const health = (await response.json()) as HealthReport;
      expect(health.status).toBe("ok");
    },
  );

  it("keeps a plain host in the URL for the default loopback bind", async () => {
    const { runtime } = await startServer();
    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${runtime.url}/health`);
    expect(response.status).toBe(200);
  });
});

describe("daemon runtime surface", () => {
  it("exposes the live ingest handle, so replay feeds the same path browsers see", async () => {
    const { runtime } = await startServer();
    expect(typeof runtime.ingest.handlePostEvents).toBe("function");
    const reason = runtime.ingest.handlePostEvents({
      normalized: true,
      agentHeader: null,
      bodyText: JSON.stringify([sessionStartEvent("s-runtime")]),
    });
    expect(reason).toBeNull();
    const health = await getHealth(runtime.url);
    expect(health.lanesOccupied).toBe(1);
  });
});

describe("static web serving", () => {
  it("serves index.html from the configured web root and falls back for unknown routes", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "hearable-webroot-"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>hearable</title>");
    const second = await startDaemon({
      config: {
        host: "127.0.0.1",
        port: 0,
        lanes: 3,
        laneReleaseAfterMs: 60_000,
        dataDir: mkdtempSync(join(tmpdir(), "hearable-static-")),
      },
      adapters: [drillClaudeShapedAdapter],
      webRoot,
    });
    runtimes.push(second);
    const root = await fetch(`${second.url}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("<title>hearable</title>");
    const fallback = await fetch(`${second.url}/some/client/route`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("<title>hearable</title>");
    rmSync(webRoot, { recursive: true, force: true });
  });

  it("answers a plain 404 when the web build does not exist", async () => {
    const { runtime } = await startServer();
    const response = await fetch(`${runtime.url}/`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("audio renderer build is not installed yet");
  });

  it("answers a plain 404 when the web root holds compiler output but no built shell", async () => {
    // Root `tsc --build` emits compiler output into apps/web/dist, so a web
    // root can exist without index.html. That state must read as "no build",
    // not as a broken console.
    const webRoot = mkdtempSync(join(tmpdir(), "hearable-tsc-output-"));
    writeFileSync(join(webRoot, "main.js"), "void 0;");
    const tscOutput = await startDaemon({
      config: {
        host: "127.0.0.1",
        port: 0,
        lanes: 3,
        laneReleaseAfterMs: 60_000,
        dataDir: mkdtempSync(join(tmpdir(), "hearable-tsc-data-")),
      },
      adapters: [drillClaudeShapedAdapter],
      webRoot,
    });
    runtimes.push(tscOutput);
    const response = await fetch(`${tscOutput.url}/`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("audio renderer build is not installed yet");
    rmSync(webRoot, { recursive: true, force: true });
  });

  it("serves bundled wav assets as audio/wav", async () => {
    // revp3t15: the nature-bed WAV rides the web build as a ?url asset,
    // so the daemon must serve .wav with the audio type the fetch path
    // decodes — never the octet-stream fallback.
    const webRoot = mkdtempSync(join(tmpdir(), "hearable-wav-"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>hearable</title>");
    writeFileSync(join(webRoot, "nature-bed-soft-rain-12s.wav"), "RIFFfake");
    const withWav = await startDaemon({
      config: {
        host: "127.0.0.1",
        port: 0,
        lanes: 3,
        laneReleaseAfterMs: 60_000,
        dataDir: mkdtempSync(join(tmpdir(), "hearable-wav-data-")),
      },
      adapters: [drillClaudeShapedAdapter],
      webRoot,
    });
    runtimes.push(withWav);
    const response = await fetch(`${withWav.url}/nature-bed-soft-rain-12s.wav`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    rmSync(webRoot, { recursive: true, force: true });
  });

  it("serves the PWA manifest with its manifest content type", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "hearable-manifest-"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>hearable</title>");
    writeFileSync(
      join(webRoot, "manifest.webmanifest"),
      JSON.stringify({ name: "Hearable", display: "standalone", start_url: "/", icons: [] }),
    );
    const withManifest = await startDaemon({
      config: {
        host: "127.0.0.1",
        port: 0,
        lanes: 3,
        laneReleaseAfterMs: 60_000,
        dataDir: mkdtempSync(join(tmpdir(), "hearable-manifest-data-")),
      },
      adapters: [drillClaudeShapedAdapter],
      webRoot,
    });
    runtimes.push(withManifest);
    const response = await fetch(`${withManifest.url}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/manifest+json");
    expect((await response.json()) as { display: string }).toMatchObject({ display: "standalone" });
    rmSync(webRoot, { recursive: true, force: true });
  });
});
