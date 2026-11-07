// Adopts or hosts the existing daemon; must never stop a daemon owned by another process.
import { readFileSync } from "node:fs";
import { claudeCodeAdapter } from "@hearable/claude-code";
import { codexAdapter } from "@hearable/codex";
import {
  DaemonAlreadyRunningError,
  type DaemonConfig,
  lockFilePath,
  startDaemon,
} from "@hearable/daemon";
import { z } from "zod";
import { daemonAction } from "./policy.js";

const Lock = z.object({
  v: z.literal(1),
  pid: z.number().int().positive(),
  port: z.number().int().min(0).max(65535),
});
const Health = z.object({
  status: z.literal("ok"),
  version: z.string(),
  lanes: z.array(z.unknown()),
  sessionsByAgent: z.record(z.string(), z.number()),
});

function readLock(config: DaemonConfig): { port: number; alive: boolean } | null {
  try {
    const lock = Lock.parse(JSON.parse(readFileSync(lockFilePath(config.dataDir), "utf8")));
    try {
      process.kill(lock.pid, 0);
      return { port: lock.port, alive: true };
    } catch (error) {
      return { port: lock.port, alive: (error as NodeJS.ErrnoException).code === "EPERM" };
    }
  } catch {
    return null;
  }
}

export async function hostDaemon(config: DaemonConfig, webRoot: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const lock = readLock(config);
    const port = lock?.alive && lock.port !== 0 ? lock.port : config.port;
    const host = config.host.includes(":") ? `[${config.host}]` : config.host;
    const url = `http://${host}:${port}`;
    let healthy = false;
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      healthy = response.ok && Health.safeParse(await response.json()).success;
    } catch {
      /* A live lock can precede the listening socket during startup. */
    }
    const action = daemonAction(healthy, lock?.alive ?? false);
    if (action === "adopt") return { url, owned: false, stop: async () => {} };
    if (action === "start") {
      try {
        const runtime = await startDaemon({
          config,
          webRoot,
          adapters: [claudeCodeAdapter, codexAdapter],
        });
        return { url: runtime.url, owned: true, stop: () => runtime.stop() };
      } catch (error) {
        if (
          !(error instanceof DaemonAlreadyRunningError) &&
          (error as NodeJS.ErrnoException).code !== "EADDRINUSE"
        )
          throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Hearable could not connect to the daemon. Check hearable doctor, then reopen the app.",
  );
}
