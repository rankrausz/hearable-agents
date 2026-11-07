// packages/daemon/test/single-instance.test.ts — one daemon per user: a
// second `start` detects the running daemon and fails with a plain-language
// message instead of stealing the port, and stop() releases the lock so a
// later start succeeds.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Scheduler } from "../src/broadcast.js";
import { DaemonAlreadyRunningError } from "../src/lock.js";
import { type DaemonRuntime, startDaemon } from "../src/server.js";
import { drillClaudeShapedAdapter } from "./doubles.js";

/** Counts scheduled work that is still pending, so a refused start can be
 * shown to leave nothing behind that would keep the process alive. */
function countingScheduler(): Scheduler & { pending: () => number } {
  let pending = 0;
  return {
    schedule(fn, ms) {
      pending += 1;
      let live = true;
      const timer = setTimeout(() => {
        live = false;
        pending -= 1;
        fn();
      }, ms);
      return () => {
        if (live) {
          live = false;
          pending -= 1;
          clearTimeout(timer);
        }
      };
    },
    pending: () => pending,
  };
}

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "hearable-lock-"));
}

function baseConfig(dataDir: string, port = 0) {
  return { host: "127.0.0.1" as const, port, lanes: 3, laneReleaseAfterMs: 60_000, dataDir };
}

describe("single instance", () => {
  it("refuses a second daemon on the same data dir with a plain-language message", async () => {
    const dataDir = tempDataDir();
    const first = await startDaemon({
      config: baseConfig(dataDir),
      adapters: [drillClaudeShapedAdapter],
    });
    try {
      let caught: unknown;
      try {
        await startDaemon({ config: baseConfig(dataDir), adapters: [drillClaudeShapedAdapter] });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DaemonAlreadyRunningError);
      expect((caught as Error).message).toMatch(/already running/i);
      // The first daemon is unaffected and still serving.
      const response = await fetch(`${first.url}/health`);
      expect(response.status).toBe(200);
    } finally {
      await first.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses a second daemon that collides on the port even with a different data dir", async () => {
    const firstData = tempDataDir();
    const secondData = tempDataDir();
    const first = await startDaemon({
      config: baseConfig(firstData),
      adapters: [drillClaudeShapedAdapter],
    });
    try {
      let caught: unknown;
      try {
        await startDaemon({
          config: baseConfig(secondData, first.port),
          adapters: [drillClaudeShapedAdapter],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DaemonAlreadyRunningError);
      expect((caught as Error).message).toMatch(/already in use/i);
    } finally {
      await first.stop();
      rmSync(firstData, { recursive: true, force: true });
      rmSync(secondData, { recursive: true, force: true });
    }
  });

  it("can start again once the first daemon has stopped", async () => {
    const dataDir = tempDataDir();
    const first = await startDaemon({
      config: baseConfig(dataDir),
      adapters: [drillClaudeShapedAdapter],
    });
    await first.stop();
    const second: DaemonRuntime = await startDaemon({
      config: baseConfig(dataDir),
      adapters: [drillClaudeShapedAdapter],
    });
    await second.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("leaves no timer running when it refuses, so a refused start can exit", async () => {
    const dataDir = tempDataDir();
    const otherData = tempDataDir();
    const first = await startDaemon({
      config: baseConfig(dataDir),
      adapters: [drillClaudeShapedAdapter],
    });
    try {
      const lockRefused = countingScheduler();
      await expect(
        startDaemon({
          config: baseConfig(dataDir),
          adapters: [drillClaudeShapedAdapter],
          scheduler: lockRefused,
        }),
      ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
      expect(lockRefused.pending()).toBe(0);

      const portRefused = countingScheduler();
      await expect(
        startDaemon({
          config: baseConfig(otherData, first.port),
          adapters: [drillClaudeShapedAdapter],
          scheduler: portRefused,
        }),
      ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
      expect(portRefused.pending()).toBe(0);
    } finally {
      await first.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(otherData, { recursive: true, force: true });
    }
  });
});
