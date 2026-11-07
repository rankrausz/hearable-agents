#!/usr/bin/env node
// packages/adapter-kit/src/relay/measure-relay-timing.mjs — the committed
// timing method for the hook relay: against local stubs it times sequential
// real spawns of hearable-hook.mjs (payload on stdin, wall time from spawn
// to exit, including process start) on the success path and on the two
// paths where only the relay's own deadline can bound the exit — a daemon
// that accepts and never answers, and a producer that never closes stdin —
// and fails when any phase's p95 is not under the budget. What this is for:
// proving the relay keeps the < 50 ms per-event budget in the happy path
// AND in its worst cases (docs/ARCHITECTURE.md, §5 Phase 1), and recording the exact
// method the relay-timing conformance suite (p1-t07) reuses. What it must
// not do: measure anything but the real relay process (no in-process
// shortcuts) or vary the payload per run — one representative hook payload
// keeps the numbers comparable over time.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const relayPath = join(dirname(fileURLToPath(import.meta.url)), "hearable-hook.mjs");

// A representative Claude Code PreToolUse payload — the shape every hook
// adapter sends. Fixed so measurements stay comparable across machines and
// time.
const PAYLOAD = JSON.stringify({
  session_id: "timing-check",
  hook_event_name: "PreToolUse",
  cwd: "/repo",
  tool_name: "Read",
  tool_input: { file_path: "/repo/src/index.ts" },
});

function readNumberFlag(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const argv = process.argv.slice(2);
const warmups = readNumberFlag(argv, "warmup", 10);
const runs = readNumberFlag(argv, "runs", 100);
const failureRuns = readNumberFlag(argv, "failure-runs", 50);
const budgetMs = readNumberFlag(argv, "budget", 50);

/**
 * Spawns the relay once, the way an agent does, and resolves with its exit
 * code, stdout and wall time from just before spawn to process exit. With
 * `leaveStdinOpen` the parent never ends the pipe, which is how a producer
 * that stalls behaves.
 */
function timeOneSpawn(url, leaveStdinOpen) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [relayPath, "--agent", "claude-code", "--url", url], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      child.stdin.destroy();
      resolve({ code, stdout, ms: performance.now() - started });
    });
    child.stdin.write(PAYLOAD);
    if (!leaveStdinOpen) {
      child.stdin.end();
    }
  });
}

function startStub(neverResponds) {
  const server = createServer((request, response) => {
    if (neverResponds) {
      return;
    }
    request.resume();
    response.statusCode = 204;
    response.end();
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the stub did not listen on a TCP port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

const responding = await startStub(false);
const stalled = await startStub(true);

// The success path plus the two worst cases the relay's deadline must bound.
const phases = [
  {
    name: "successful local stub",
    url: responding.url,
    leaveStdinOpen: false,
    warmupCount: warmups,
    runCount: runs,
  },
  {
    name: "stalled daemon that accepts but never answers",
    url: stalled.url,
    leaveStdinOpen: false,
    warmupCount: 0,
    runCount: failureRuns,
  },
  {
    name: "producer that never closes stdin",
    url: responding.url,
    leaveStdinOpen: true,
    warmupCount: 0,
    runCount: failureRuns,
  },
];

try {
  console.log(
    `relay timing: sequential spawns of hearable-hook.mjs (wall time per event, ` +
      `spawn to exit, including process start), budget: p95 under ${budgetMs} ms in every phase`,
  );
  let overBudget = 0;
  let broken = 0;
  for (const phase of phases) {
    for (let index = 0; index < phase.warmupCount; index += 1) {
      await timeOneSpawn(phase.url, phase.leaveStdinOpen);
    }
    const samples = [];
    for (let index = 0; index < phase.runCount; index += 1) {
      const sample = await timeOneSpawn(phase.url, phase.leaveStdinOpen);
      if (sample.code !== 0 || sample.stdout !== "") {
        broken += 1;
      }
      samples.push(sample.ms);
    }
    samples.sort((a, b) => a - b);
    const percentile = (fraction) =>
      samples[Math.min(samples.length - 1, Math.ceil(fraction * samples.length) - 1)];
    const p50 = percentile(0.5);
    const p95 = percentile(0.95);
    const max = samples[samples.length - 1];
    if (p95 >= budgetMs) {
      overBudget += 1;
    }
    console.log(
      `${phase.name}: ${phase.runCount} runs | p50 ${p50.toFixed(1)} ms | p95 ${p95.toFixed(1)} ms | max ${max.toFixed(1)} ms`,
    );
  }

  if (broken > 0) {
    console.error(`relay timing: FAILED — ${broken} runs exited nonzero or wrote to stdout`);
    process.exitCode = 1;
  } else if (overBudget > 0) {
    console.error(
      `relay timing: FAILED — ${overBudget} of ${phases.length} phases are not under the ` +
        `${budgetMs} ms budget; the relay or its deadline needs attention before the ` +
        `conformance suite runs`,
    );
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
} finally {
  responding.close();
  stalled.close();
}
