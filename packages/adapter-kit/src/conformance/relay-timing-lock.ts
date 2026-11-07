// packages/adapter-kit/src/conformance/relay-timing-lock.ts — serializes the
// spawn-heavy relay timing probes across Vitest workers. What this is for:
// keeping the harness from measuring unrelated worker contention as relay
// latency. What it must not do: change the relay deadline or hide a slow relay;
// every caller still measures real process wall time against the fixed budget.

import { open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK_PATH = join(tmpdir(), "hearable-adapter-kit-relay-timing.lock");
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;

async function removeStaleLock(): Promise<void> {
  try {
    const info = await stat(LOCK_PATH);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await rm(LOCK_PATH, { force: true });
    }
  } catch {
    // A missing lock is the normal acquisition race.
  }
}

async function acquireLock(): Promise<void> {
  for (;;) {
    try {
      const handle = await open(LOCK_PATH, "wx");
      await handle.close();
      return;
    } catch {
      await removeStaleLock();
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Run one relay timing probe while excluding other spawn-heavy probes. */
export async function withRelayTimingLock<T>(work: () => Promise<T>): Promise<T> {
  await acquireLock();
  try {
    return await work();
  } finally {
    await rm(LOCK_PATH, { force: true });
  }
}
