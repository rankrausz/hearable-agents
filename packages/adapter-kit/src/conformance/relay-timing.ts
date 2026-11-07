// packages/adapter-kit/src/conformance/relay-timing.ts — the shared wall-time
// measurement behind the relay-timing conformance cases: sequential spawns of
// the real hearable-hook binary against a local stub daemon, wall time from
// spawn to exit per event, with retry-and-median semantics. What this is for:
// proving every adapter's payloads travel the command-hook path inside the
// 50 ms per-event budget docs/ARCHITECTURE.md demands, reusing the committed method of
// src/relay/measure-relay-timing.mjs (the same binary, the same spawn shape,
// the same immediately-answering stub) with fewer samples and best-of-retries
// medians so one cold-start spike cannot fail a healthy relay. What it must
// not do: loosen the budget (loosening is a docs/ARCHITECTURE.md scope decision for the
// human), parse the payload, or know which agent a payload came from — agent
// identity travels only as the relay's --agent flag value, which the
// adapter's suite supplies as data.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { withRelayTimingLock } from "./relay-timing-lock.js";
import { RELAY_TIMING_BUDGET_MS, type RelayTimingPayload } from "./suites.js";

/**
 * Options for one payload measurement. Every field is a repeat count —
 * never behaviour, never the budget — so the public suite stays
 * data-shaped. The budget is fixed at `RELAY_TIMING_BUDGET_MS`; the
 * retry-and-median counts are the only noise mechanism. `relayPath` is the
 * one exception, and it is not part of the public suite: it defaults to
 * the committed binary and only the kit's own tests override it, to prove
 * the measurement fails a deliberately slow stub relay and passes a fast
 * one.
 */
export type RelayTimingOptions = {
  /** Timed spawns per attempt; defaults to 5, enough for a median. */
  readonly samples?: number;
  /** Attempts per payload; the best median wins. Defaults to 5. */
  readonly retries?: number;
  /** The relay binary to spawn; defaults to the kit's committed hearable-hook.mjs. */
  readonly relayPath?: string;
};

/** What one payload measurement observed: the winning median and the budget it met. */
export type RelayTimingMeasurement = {
  /** The payload name from the suite, for the case report. */
  readonly payloadName: string;
  /** The best attempt's median wall time per event, spawn to exit. */
  readonly medianMs: number;
  /** Which attempt produced the winning median (1-based). */
  readonly attempts: number;
};

const DEFAULT_SAMPLES = 5;
// Five attempts, not three: the budget holds comfortably on an idle machine
// (medians in the 30s of ms), and what pushes a median past 50 ms is the rest
// of `pnpm test` spawning processes at the same moment. More attempts filter
// that contention without moving the budget.
const DEFAULT_RETRIES = 5;

/** The committed relay binary every command-hook installer points at (ADR 0014). */
function committedRelayPath(): string {
  return fileURLToPath(new URL("../relay/hearable-hook.mjs", import.meta.url));
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

type RelaySpawn = {
  code: number | null;
  stdout: string;
  ms: number;
};

/**
 * Spawns the relay once the way an agent does — payload on stdin, adapter id
 * and daemon URL as flags — and resolves with its exit code, stdout and wall
 * time from just before spawn to exit.
 */
function spawnRelayOnce(
  relayPath: string,
  agentId: string,
  url: string,
  payload: string,
): Promise<RelaySpawn> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [relayPath, "--agent", agentId, "--url", url], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      child.stdin.destroy();
      resolve({ code, stdout, ms: performance.now() - started });
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

type TimingStub = {
  url: string;
  close: () => Promise<void>;
};

/** A stub daemon that answers 204 immediately — the healthy local delivery. */
function startTimingStub(): Promise<TimingStub> {
  const server = createServer((request, response) => {
    request.resume();
    response.statusCode = 204;
    response.end();
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the relay-timing stub did not listen on a TCP port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Measures one payload through the real relay: sequential timed spawns
 * against a local stub, the median of each attempt, the best attempt's
 * median checked against the fixed 50 ms budget. Resolves with the winning
 * measurement; throws with a plain-language message when the relay
 * misbehaves (nonzero exit, stdout output) or the best median exceeds the
 * budget.
 */
export async function measureRelayPayload(
  payload: RelayTimingPayload,
  options?: RelayTimingOptions,
): Promise<RelayTimingMeasurement> {
  const samples = options?.samples ?? DEFAULT_SAMPLES;
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const relayPath = options?.relayPath ?? committedRelayPath();
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error(
      `relay-timing payload "${payload.name}": samples must be a positive integer, got ${samples}`,
    );
  }
  if (!Number.isInteger(retries) || retries < 1) {
    throw new Error(
      `relay-timing payload "${payload.name}": retries must be a positive integer, got ${retries}`,
    );
  }
  return withRelayTimingLock(async () => {
    const stub = await startTimingStub();
    try {
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        const times: number[] = [];
        for (let sample = 0; sample < samples; sample += 1) {
          const outcome = await spawnRelayOnce(
            relayPath,
            payload.agentId,
            stub.url,
            payload.payload,
          );
          if (outcome.code !== 0) {
            throw new Error(
              `relay-timing payload "${payload.name}": the relay exited with code ${outcome.code} — the relay must exit 0 in all circumstances (AGENTS.md rule 2)`,
            );
          }
          if (outcome.stdout !== "") {
            throw new Error(
              `relay-timing payload "${payload.name}": the relay wrote to stdout — the relay must stay silent there because the agent may parse it`,
            );
          }
          times.push(outcome.ms);
        }
        const median = medianOf(times);
        if (median < best) {
          best = median;
        }
        if (median < RELAY_TIMING_BUDGET_MS) {
          return { payloadName: payload.name, medianMs: median, attempts: attempt };
        }
      }
      throw new Error(
        `relay-timing payload "${payload.name}": median wall time ${best.toFixed(1)} ms per event over ${samples} spawns (best of ${retries} attempts) exceeds the ${RELAY_TIMING_BUDGET_MS} ms budget — the relay or its deadline needs attention before this adapter can pass`,
      );
    } finally {
      await stub.close();
    }
  });
}
