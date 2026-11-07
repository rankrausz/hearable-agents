// packages/daemon/src/server.ts — the daemon's HTTP and WebSocket surface.
// What this is for: node:http serving POST /events, GET /health and the built
// web app, plus `ws` pushing snapshots and coalesced event frames to browsers
// (docs/ARCHITECTURE.md §packages/daemon `server.ts`, §Data flow step 7); it
// also owns the single-instance lock and the lane idle-advance timer. What it
// must not do: interpret payload content (ingest.ts owns that), hold a browser
// open (no long-lived state here), or let one malformed request break ingest —
// POST /events always answers 204 after quarantine (docs/EVENTS.md §Wire format).

import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter } from "@hearable/adapter-kit";
import { WebSocket, WebSocketServer } from "ws";
import { createAdapterRegistry } from "./adapters.js";
import { AudioElection } from "./audio-election.js";
import type { Scheduler } from "./broadcast.js";
import { Broadcaster, defaultScheduler } from "./broadcast.js";
import { CalmSchema, createCalmStore } from "./calm.js";
import { type Clock, wallClock } from "./clock.js";
import type { DaemonConfig } from "./config.js";
import { createEngineOwner } from "./engine.js";
import { buildHealth } from "./health.js";
import {
  type ApplyToEngine,
  createIngest,
  type Ingest,
  type RecordEvents,
  type RecordRawEvents,
} from "./ingest.js";
import { LaneManager } from "./lanes.js";
import { acquireDaemonLock, DaemonAlreadyRunningError, lockFilePath } from "./lock.js";
import { createQuarantine } from "./quarantine.js";
import { Sessions } from "./sessions.js";

export const WS_PATH = "/ws";
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const LANE_ADVANCE_INTERVAL_MS = 1000;
export const ENGINE_ADVANCE_INTERVAL_MS = 500;

export type StartOptions = {
  config: DaemonConfig;
  adapters: readonly Adapter[];
  clock?: Clock;
  scheduler?: Scheduler;
  record?: RecordEvents;
  recordRaw?: RecordRawEvents;
  applyToEngine?: ApplyToEngine;
  webRoot?: string;
  lockPath?: string;
  /** Called once the server is listening, with the resolved port. */
  onReady?: (info: { port: number }) => void;
};

export type DaemonRuntime = {
  /** The port the daemon is actually listening on (resolved from port 0). */
  port: number;
  /** The base HTTP URL, for drill scripts and the CLI. */
  url: string;
  /**
   * The daemon's ingest handle. The replayer (p1-t11) feeds recorded files
   * through this same handle live events take, so replayed history is
   * broadcast and namespaced exactly like live traffic; nothing else should
   * reach into it.
   */
  ingest: Pick<Ingest, "handlePostEvents">;
  /** Stops timers, closes clients and the server, and releases the lock. */
  stop(): Promise<void>;
};

/** Reads the package version for /health without re-pinning a constant. */
function readDaemonVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

/** The repo-root web build the daemon serves by convention (docs/ARCHITECTURE.md, p1-t09). */
export function defaultWebRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/dist");
}

export async function startDaemon(options: StartOptions): Promise<DaemonRuntime> {
  const { config, adapters } = options;
  const clock = options.clock ?? wallClock;
  const scheduler = options.scheduler ?? defaultScheduler;
  const webRoot = options.webRoot ?? defaultWebRoot();
  const lockPath = options.lockPath ?? lockFilePath(config.dataDir);
  const startedAt = clock();
  const daemonVersion = readDaemonVersion();

  mkdirSync(config.dataDir, { recursive: true });

  const registry = createAdapterRegistry(adapters);
  const sessions = new Sessions();
  const lanes = new LaneManager(config.lanes, config.laneReleaseAfterMs, sessions, clock);
  const engine = createEngineOwner(lanes, sessions, registry);
  const calmStore = createCalmStore(config.dataDir);
  engine.setCalm(calmStore.get(), startedAt);
  const quarantine = createQuarantine(config.dataDir, clock);
  const broadcaster = new Broadcaster(scheduler, clock);
  const ingest = createIngest({
    adapters: registry,
    sessions,
    lanes,
    quarantine,
    broadcaster,
    clock,
    record: options.record,
    recordRaw: options.recordRaw,
    applyToEngine:
      options.applyToEngine ??
      ((events, now) => {
        engine.apply(events, now);
      }),
    engineSignals: options.applyToEngine === undefined ? () => engine.snapshot() : undefined,
    engineCalm: options.applyToEngine === undefined ? () => engine.calm() : undefined,
  });

  const makeHealth = () =>
    buildHealth({
      daemonVersion,
      startedAt,
      now: clock(),
      quarantineCount: quarantine.count(),
      laneSnapshot: lanes.snapshot(),
      lanesTotal: config.lanes,
      sessions,
      calmWarning: calmStore.warning(),
    });

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, {
      webRoot,
      ingest,
      health: makeHealth,
      sessions,
      calm: calmStore,
      engine,
      clock,
      broadcaster,
    });
  });

  const lock = acquireDaemonLock({ lockPath, port: config.port, startedAt });
  try {
    await listen(httpServer, config.host, config.port);
  } catch (error) {
    lock.release();
    throw error;
  }
  const boundPort = resolveBoundPort(httpServer);

  // Built only once the lock and port are held: its sweep timer re-arms
  // forever, so constructing it earlier left a refused `start` unable to exit.
  const audioElection = new AudioElection(clock, scheduler, (socket, message) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  });

  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
  broadcaster.laneSource = () => lanes.snapshot();
  broadcaster.target = {
    send(msg) {
      const payload = JSON.stringify(msg);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    },
  };
  wss.on("connection", (socket) => {
    const endpointId = audioElection.connect(socket, false);
    // A full snapshot on connect is the reconnect contract: a reconnecting
    // browser resyncs from this message, then event frames resume live.
    socket.send(
      JSON.stringify({
        type: "snapshot",
        ...lanes.snapshot(),
        signals: engine.snapshot(),
        calm: engine.calm(),
        serverTime: clock(),
        audio: { endpointId, ownerId: audioElection.owner() },
      }),
    );
    socket.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      const type = (message as { type?: unknown }).type;
      if (type === "audio-claim") {
        audioElection.claim(endpointId, (message as { takeover?: unknown }).takeover === true);
      } else if (type === "audio-heartbeat") {
        audioElection.heartbeat(endpointId);
      } else if (type === "audio-release") {
        audioElection.release(endpointId);
      }
    });
    socket.on("close", () => audioElection.disconnect(endpointId));
  });

  // One self-rescheduling ticker; its cancel handle is refreshed on every
  // reschedule so stop() always cancels the timer that is actually pending.
  let idleTickerCancel: () => void = () => {};
  let engineTickerCancel: () => void = () => {};
  const runIdleTicker = () => {
    idleTickerCancel = scheduler.schedule(() => {
      lanes.advance();
      runIdleTicker();
    }, LANE_ADVANCE_INTERVAL_MS);
  };
  runIdleTicker();
  const runEngineTicker = () => {
    engineTickerCancel = scheduler.schedule(() => {
      const now = clock();
      const signals = engine.advance(now);
      broadcaster.pushSignals(signals, engine.calm());
      runEngineTicker();
    }, ENGINE_ADVANCE_INTERVAL_MS);
  };
  runEngineTicker();

  if (options.onReady !== undefined) {
    options.onReady({ port: boundPort });
  }

  return {
    port: boundPort,
    // IPv6 loopback hosts are bracketed so the URL (`http://[::1]:4876`) is
    // actually fetchable instead of the invalid `http://::1:4876`.
    url: `http://${formatUrlHost(config.host)}:${boundPort}`,
    ingest,
    async stop() {
      idleTickerCancel();
      engineTickerCancel();
      broadcaster.dispose();
      audioElection.dispose();
      await closeWebSockets(wss);
      await closeHttpServer(httpServer);
      lock.release();
    },
  };
}

/** Formats a bind host into a URL host, bracketing IPv6 literals. */
function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function resolveBoundPort(httpServer: HttpServer): number {
  const address = httpServer.address();
  if (typeof address === "object" && address !== null && typeof address.port === "number") {
    return address.port;
  }
  return 0;
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    webRoot: string;
    ingest: ReturnType<typeof createIngest>;
    health: () => ReturnType<typeof buildHealth>;
    sessions: Sessions;
    calm: ReturnType<typeof createCalmStore>;
    engine: ReturnType<typeof createEngineOwner>;
    clock: Clock;
    broadcaster: Broadcaster;
  },
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const method = req.method ?? "GET";

  if (method === "POST" && url.pathname === "/events") {
    await handlePostEvents(req, res, deps);
    return;
  }
  if (method === "GET" && url.pathname === "/session-focus") {
    // Native shell lookup only. Never include these hints in WS, health, or recordings.
    const peer = req.socket.remoteAddress;
    if (
      (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") ||
      req.headers.origin
    ) {
      writeJson(res, 403, { error: "Session focus is available only to the local app." });
      return;
    }
    res.setHeader("cache-control", "no-store");
    const session = deps.sessions.get(url.searchParams.get("sessionId") ?? "");
    if (!session || session.agent !== url.searchParams.get("agent") || !session.focus) {
      writeJson(res, 404, {
        error: "This session has no local window information. Wait for its next hook event.",
      });
      return;
    }
    const focus = session.focus;
    const target = await focus;
    if (deps.sessions.get(session.sessionId) !== session || session.focus !== focus) {
      writeJson(res, 409, { error: "The session changed. Try opening it again." });
      return;
    }
    writeJson(res, 200, target);
    return;
  }
  if (method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, deps.health());
    return;
  }
  if (method === "PUT" && url.pathname === "/calm") {
    await handleCalm(req, res, deps);
    return;
  }
  if (method === "GET" || method === "HEAD") {
    await serveStatic(req, res, deps.webRoot);
    return;
  }
  writeJson(res, 405, { error: `Method ${method} is not supported at ${url.pathname}.` });
}

async function handleCalm(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    calm: ReturnType<typeof createCalmStore>;
    engine: ReturnType<typeof createEngineOwner>;
    clock: Clock;
    broadcaster: Broadcaster;
  },
): Promise<void> {
  const body = await readBody(req, 1024);
  let parsed: unknown;
  try {
    parsed = body === null ? null : (JSON.parse(body) as unknown);
  } catch {
    writeJson(res, 400, { error: "Calm must be JSON with a number from 0 to 1." });
    return;
  }
  const value =
    typeof parsed === "object" && parsed !== null && "calm" in parsed
      ? (parsed as { calm: unknown }).calm
      : undefined;
  const result = CalmSchema.safeParse(value);
  if (!result.success) {
    writeJson(res, 400, { error: "Calm must be a number from 0 to 1." });
    return;
  }
  try {
    deps.calm.set(result.data);
  } catch {
    writeJson(res, 500, { error: "Calm could not be saved. Check the daemon data directory." });
    return;
  }
  const signals = deps.engine.setCalm(result.data, deps.clock());
  deps.broadcaster.pushSignals(signals, result.data);
  writeJson(res, 200, { calm: result.data });
}

async function handlePostEvents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    ingest: ReturnType<typeof createIngest>;
  },
): Promise<void> {
  const normalized = readHeader(req.headers["x-hearable-normalized"]);
  const agentHeader = readHeader(req.headers["x-hearable-agent"]);
  const bodyText = await readBody(req, MAX_BODY_BYTES);
  deps.ingest.handlePostEvents({
    normalized: normalized === "1",
    agentHeader,
    bodyText,
    focusHeader: readHeader(req.headers["x-hearable-focus"]),
  });
  // The wire contract: every POST /events answers 204 with an empty body,
  // whatever the payload looked like (docs/EVENTS.md §Wire format).
  res.writeHead(204);
  res.end();
}

function readHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value === undefined || value === "" ? null : value;
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) {
        // Keep draining so the request finishes cleanly and we can still
        // answer 204; the payload is discarded, not buffered.
        return;
      }
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        resolvePromise(null);
        return;
      }
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => resolvePromise(null));
  });
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  webRoot: string,
): Promise<void> {
  // A present directory is not a built console: `tsc --build` emits compiler
  // output into apps/web/dist, so only index.html (which only vite writes)
  // counts as an installed build.
  if (!existsSync(join(webRoot, "index.html"))) {
    writeText(
      res,
      404,
      "Hearable is running, but the audio renderer build is not installed yet. Build apps/web and try again.",
    );
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(webRoot, relativePath);
  const rootPrefix = resolve(webRoot) + sep;
  if (!target.startsWith(rootPrefix) && target !== resolve(webRoot)) {
    writeText(res, 403, "That path is outside the web app. Nothing here.");
    return;
  }
  let filePath = target;
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
  }
  if (!existsSync(filePath)) {
    // SPA fallback: unknown client routes render the shell, which decides.
    filePath = join(webRoot, "index.html");
    if (!existsSync(filePath)) {
      writeText(res, 404, "That page was not found.");
      return;
    }
  }
  const contentType = contentTypeFor(filePath);
  res.writeHead(200, { "content-type": contentType });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      writeText(res, 404, "That file could not be read.");
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

function contentTypeFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    map: "application/json",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    wav: "audio/wav",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    webmanifest: "application/manifest+json",
  };
  return types[ext] ?? "application/octet-stream";
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  writeText(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function writeText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(text);
}

function listen(httpServer: HttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    httpServer.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        rejectPromise(
          new DaemonAlreadyRunningError(
            `Port ${port} is already in use — another hearable daemon (or another program) is listening there. ` +
              `Stop it, or configure a different port in ~/.config/hearable/config.json.`,
          ),
        );
        return;
      }
      rejectPromise(error);
    });
    httpServer.once("listening", resolvePromise);
    httpServer.listen(port, host);
  });
}

async function closeWebSockets(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
  await new Promise<void>((resolvePromise) => {
    wss.close(() => resolvePromise());
  });
}

async function closeHttpServer(httpServer: HttpServer): Promise<void> {
  if (!httpServer.listening) {
    return;
  }
  await new Promise<void>((resolvePromise) => {
    httpServer.close(() => resolvePromise());
  });
}
