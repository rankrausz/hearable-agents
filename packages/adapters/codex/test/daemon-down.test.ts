// packages/adapters/codex/test/daemon-down.test.ts — the Codex installer
// target's outage drill. What this is for: proving the exact relay command
// this adapter installs leaves the agent unaffected when the daemon is down.
// What it must not do: test relay timing or change the shared relay.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { measureRelayPayload } from "../../../adapter-kit/src/conformance/relay-timing.js";

const relayPath = fileURLToPath(
  new URL("../../../adapter-kit/src/relay/hearable-hook.mjs", import.meta.url),
);

function runRelay(): Promise<{ code: number | null; stdout: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(
      process.execPath,
      [relayPath, "--agent", "codex", "--url", "http://127.0.0.1:1"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout, elapsedMs: performance.now() - startedAt }),
    );
    child.stdin.end(
      JSON.stringify({ session_id: "codex-outage", hook_event_name: "SessionStart" }),
    );
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

describe("Codex daemon outage", () => {
  it("drops the hook event with exit 0 and no stdout", async () => {
    const result = await runRelay();
    const outageRuns = [result, await runRelay(), await runRelay()];
    for (const run of outageRuns) {
      expect(run.code).toBe(0);
      expect(run.stdout).toBe("");
      expect(run.elapsedMs).toBeGreaterThan(0);
    }
    expect(median(outageRuns.map((run) => run.elapsedMs))).toBeLessThan(50);
    const timing = await measureRelayPayload(
      {
        name: "codex-daemon-down-command",
        agentId: "codex",
        payload: JSON.stringify({ session_id: "codex-outage", hook_event_name: "SessionStart" }),
      },
      { samples: 1, retries: 5 },
    );
    expect(timing.medianMs).toBeLessThan(50);
  });
});
