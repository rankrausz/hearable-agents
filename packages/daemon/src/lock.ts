// packages/daemon/src/lock.ts — the single-instance guard. What this is for:
// ensuring only one hearable daemon runs per user per data directory, so a
// second `start` reports a plain-language message instead of stealing a port
// or corrupting state (docs/ARCHITECTURE.md §packages/daemon `lock.ts`). What
// it must not do: hold the lock after the daemon stops, or silently keep a
// stale lock when the previous daemon died — the owner pid is probed and a
// strictly stale lock is reclaimed.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Thrown when `start` detects an already-running daemon. */
export class DaemonAlreadyRunningError extends Error {}

export type DaemonLock = {
  /** Drops the lock; safe to call once the daemon has stopped. */
  release(): void;
};

const LOCK_VERSION = 1 as const;
const LOCK_FILE_NAME = "daemon.lock";

export function lockFilePath(dataDir: string): string {
  return `${dataDir}/${LOCK_FILE_NAME}`;
}

type LockContent = {
  v: typeof LOCK_VERSION;
  pid: number;
  port: number;
  startedAt: number;
};

/** True when a process with `pid` is alive; probing is best-effort per platform. */
function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process; anything else (e.g. EPERM) means it exists.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function writeLock(lockPath: string, content: LockContent): void {
  // `wx` fails if the file already exists; that is the race-safe claim.
  writeFileSync(lockPath, JSON.stringify(content), { flag: "wx" });
}

/**
 * Claims the daemon lock at `lockPath`, throwing DaemonAlreadyRunningError
 * when another live daemon holds it. A lock whose owner pid is dead is stale
 * and is reclaimed once. Never leaves a lock file behind on failure.
 */
export function acquireDaemonLock(options: {
  lockPath: string;
  port: number;
  startedAt: number;
}): DaemonLock {
  const { lockPath, port, startedAt } = options;
  const content: LockContent = { v: LOCK_VERSION, pid: process.pid, port, startedAt };
  try {
    writeLock(lockPath, content);
    return { release: () => unlinkLock(lockPath) };
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }

  const existing = readLockOrNull(lockPath);
  if (existing !== null && existing.pid > 0 && pidIsAlive(existing.pid)) {
    throw new DaemonAlreadyRunningError(
      `Another hearable daemon is already running (pid ${existing.pid} on port ${existing.port}). ` +
        `Stop that one first, or configure a different port in ~/.config/hearable/config.json.`,
    );
  }

  // The previous daemon is dead: reclaim its stale lock in one atomic swap so
  // two racing starts cannot both believe they won.
  const stalePath = `${lockPath}.stale-${process.pid}-${startedAt}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new DaemonAlreadyRunningError(
        "Another hearable daemon just started and holds the lock now. Stop it, then try again.",
      );
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // Lost the race to another starter; they own the lock now.
      throw new DaemonAlreadyRunningError(
        "Another hearable daemon just started and claimed the lock. Stop it, then try again.",
      );
    }
    throw error;
  }
  try {
    writeLock(lockPath, content);
  } catch {
    // Someone else won the gap. Restore nothing; the stale file is gone.
    throw new DaemonAlreadyRunningError(
      "Another hearable daemon started while reclaiming a stale lock. Stop it, then try again.",
    );
  }
  unlinkSync(stalePath);
  return { release: () => unlinkLock(lockPath) };
}

function readLockOrNull(lockPath: string): LockContent | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as LockContent;
    }
  } catch {
    // Unreadable lock: treat as not-a-live-daemon (stale by definition).
  }
  return null;
}

function unlinkLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone; a double release is not an error.
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
