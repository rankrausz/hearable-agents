// packages/adapter-kit/test/relay.test.ts — black-box behaviour tests for the
// hearable-hook relay, spawned exactly as an agent spawns it: a child node
// process with the payload on stdin, against a real local HTTP stub. What
// this is for: proving the contract AGENTS.md rule 2 demands — exit 0 in
// every circumstance, nothing on stdout, the raw payload delivered with the
// adapter id header — including every failure mode the daemon or the hook
// can produce, and the per-event wall-time budget on the paths where the
// relay is the only thing that can bound it (stalled daemon, producer that
// never closes stdin). What it must not do: import the relay as a module (it
// must stay a plain script). The steady-state budget measurement itself
// lives in src/relay/measure-relay-timing.mjs, which p1-t07 turns into the
// conformance timing suite.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withRelayTimingLock } from "../src/conformance/relay-timing-lock.js";

const relayPath = fileURLToPath(new URL("../src/relay/hearable-hook.mjs", import.meta.url));

// The path package.json exposes as the hearable-hook bin — the file installers
// put on the agent's hook command line, launched directly, shebang first.
const binPath = (() => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    bin?: Record<string, string>;
  };
  const bin = manifest.bin?.["hearable-hook"];
  if (bin === undefined) {
    throw new Error("package.json does not expose a hearable-hook bin");
  }
  return fileURLToPath(new URL(`../${bin}`, import.meta.url));
})();

// A representative Claude Code PreToolUse payload.
const payload = JSON.stringify({
  session_id: "sess-1",
  hook_event_name: "PreToolUse",
  cwd: "/repo",
  tool_name: "Read",
  tool_input: { file_path: "/repo/src/index.ts" },
});

type RecordedRequest = {
  method: string;
  path: string;
  agentHeader: string | undefined;
  body: string;
  focusHeader: string | undefined;
};

type Stub = {
  url: string;
  readonly requests: readonly RecordedRequest[];
  close: () => Promise<void>;
};

/**
 * Starts a stub daemon on an ephemeral port. `status` is what every request
 * is answered with; `"never"` accepts connections but never responds, which
 * is how a hung daemon behaves.
 */
async function startStub(status: number | "never"): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (status === "never") {
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      // A header value may be typed as repeated; the relay sends one value,
      // so joining keeps the recorded shape simple and honest.
      const agentHeader = request.headers["x-hearable-agent"];
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        agentHeader: Array.isArray(agentHeader) ? agentHeader.join(", ") : agentHeader,
        body,
        focusHeader: request.headers["x-hearable-focus"] as string | undefined,
      });
      response.statusCode = status;
      response.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stub did not listen on a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type RelayRun = {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
};

/**
 * Runs the relay once as `node <file>` — the way an agent's hook command
 * invokes it — with the payload on stdin. With `leaveStdinOpen` the parent
 * never ends the pipe, which is how a hook producer that stalls (or buffers
 * forever) behaves.
 */
function runRelay(
  args: readonly string[],
  stdin: string | null,
  leaveStdinOpen = false,
): Promise<RelayRun> {
  return runRelayCommand([process.execPath, relayPath, ...args], stdin, leaveStdinOpen);
}

/**
 * Runs the exposed hearable-hook bin directly — no node, shebang first — the
 * way a hook command line that points at the binary behaves. Fails when the
 * checked-in file mode does not survive checkout as executable.
 */
function runBinRelay(args: readonly string[], stdin: string | null): Promise<RelayRun> {
  return runRelayCommand([binPath, ...args], stdin, false);
}

function runRelayCommand(
  command: readonly string[],
  stdin: string | null,
  leaveStdinOpen: boolean,
): Promise<RelayRun> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command[0] ?? "", command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      child.stdin.destroy();
      resolve({ code, stdout, stderr, ms: performance.now() - started });
    });
    if (stdin !== null) {
      child.stdin.write(stdin);
    }
    if (!leaveStdinOpen) {
      child.stdin.end();
    }
  });
}

// Every spawn-based test gets a generous wall-clock limit so a relay that
// wrongly hangs fails the test instead of stalling the suite.
const generousTimeoutMs = 10_000;

describe("the hearable-hook relay", () => {
  it(
    "delivers the raw payload to POST /events with the adapter id header, silently",
    async () => {
      const stub = await startStub(204);
      try {
        const run = await runRelay(["--agent", "claude-code", "--url", stub.url], payload);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe("");
        expect(stub.requests).toHaveLength(1);
        const request = stub.requests[0];
        const focus = JSON.parse(
          Buffer.from(request?.focusHeader ?? "", "base64url").toString("utf8"),
        );
        expect(focus.pid).toBe(process.pid);
        expect(
          Object.keys(focus).every((key) =>
            ["pid", "termProgram", "termSessionId", "itermSessionId", "remote"].includes(key),
          ),
        ).toBe(true);
        if (request === undefined) {
          throw new Error("the stub recorded no request");
        }
        expect(request.method).toBe("POST");
        expect(request.path).toBe("/events");
        expect(request.agentHeader).toBe("claude-code");
        expect(request.body).toBe(payload);
      } finally {
        await stub.close();
      }
    },
    generousTimeoutMs,
  );

  it(
    "runs when launched directly as the exposed bin, proving the checked-in executable mode survives",
    async () => {
      const stub = await startStub(204);
      try {
        const run = await runBinRelay(["--agent", "claude-code", "--url", stub.url], payload);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe("");
        expect(stub.requests).toHaveLength(1);
        const request = stub.requests[0];
        if (request === undefined) {
          throw new Error("the stub recorded no request");
        }
        expect(request.body).toBe(payload);
      } finally {
        await stub.close();
      }
    },
    generousTimeoutMs,
  );

  it(
    "forwards the adapter id it was given, so each adapter's payloads route to its map",
    async () => {
      const stub = await startStub(204);
      try {
        await runRelay(["--agent", "codex", "--url", stub.url], payload);
        const request = stub.requests[0];
        if (request === undefined) {
          throw new Error("the stub recorded no request");
        }
        expect(request.agentHeader).toBe("codex");
      } finally {
        await stub.close();
      }
    },
    generousTimeoutMs,
  );

  it(
    "exits 0 and writes nothing to stdout when the daemon is unreachable",
    async () => {
      // A port that was open a moment ago and is closed now: the reliable way
      // to get a connection refusal.
      const stub = await startStub(204);
      const unreachableUrl = stub.url;
      await stub.close();
      const run = await runRelay(["--agent", "claude-code", "--url", unreachableUrl], payload);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe("");
    },
    generousTimeoutMs,
  );

  it(
    "exits 0 and writes nothing to stdout when the daemon answers with an error",
    async () => {
      const stub = await startStub(500);
      try {
        const run = await runRelay(["--agent", "claude-code", "--url", stub.url], payload);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe("");
        expect(stub.requests).toHaveLength(1);
      } finally {
        await stub.close();
      }
    },
    generousTimeoutMs,
  );

  it(
    "exits 0, sends nothing and writes nothing to stdout when stdin is empty",
    async () => {
      const stub = await startStub(204);
      try {
        const run = await runRelay(["--agent", "claude-code", "--url", stub.url], null);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe("");
        expect(stub.requests).toHaveLength(0);
      } finally {
        await stub.close();
      }
    },
    generousTimeoutMs,
  );

  it(
    "exits 0 and forwards the bytes untouched when stdin is malformed",
    async () => {
      const malformed = "this is not json";
      const stub = await startStub(204);
      try {
        const run = await runRelay(["--agent", "claude-code", "--url", stub.url], malformed);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe("");
        // Forwarded, not dropped locally: the daemon owns validation and
        // quarantine (docs/ARCHITECTURE.md §Failure behaviour).
        const request = stub.requests[0];
        if (request === undefined) {
          throw new Error("the stub recorded no request");
        }
        expect(request.body).toBe(malformed);
      } finally {
        await stub.close();
      }
    },
    generousTimeoutMs,
  );

  it("exits 0 inside the per-event budget when the daemon accepts the connection but never answers", {
    timeout: generousTimeoutMs,
    retry: 2,
  }, async () => {
    // Load-robust budget assertion: spawn-to-exit includes process start,
    // so machine load can exceed 50 ms without the relay misbehaving. The
    // median of several spawns absorbs one-off spikes, and the vitest retry
    // absorbs a sustained spike that shifts a whole median; a real
    // deadline-logic violation exceeds the budget on every spawn of every
    // attempt and still fails. The 50 ms budget itself is unchanged (docs/ARCHITECTURE.md
    // §4).
    await withRelayTimingLock(async () => {
      const stub = await startStub("never");
      try {
        const samples: number[] = [];
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const run = await runRelay(["--agent", "claude-code", "--url", stub.url], payload);
          expect(run.code).toBe(0);
          expect(run.stdout).toBe("");
          samples.push(run.ms);
        }
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
        // The real budget, not a hang guard: spawn to exit, including
        // process start, must stay under 50 ms (docs/ARCHITECTURE.md) even when the
        // daemon stalls.
        expect(median).toBeLessThan(50);
      } finally {
        await stub.close();
      }
    });
  });

  it("exits 0 inside the per-event budget when the producer never closes an empty stdin", {
    timeout: generousTimeoutMs,
  }, async () => {
    // Load-robust budget assertion: spawn-to-exit includes process start,
    // so one machine-load spike can exceed 50 ms without the relay
    // misbehaving. The median of several spawns stays under budget under
    // load, while a real deadline-logic violation exceeds it on every
    // spawn and still fails. The 50 ms budget itself is unchanged (docs/ARCHITECTURE.md
    // §4), and no vitest retry is needed because the median absorbs spikes.
    await withRelayTimingLock(async () => {
      const stub = await startStub(204);
      try {
        const samples: number[] = [];
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const run = await runRelay(["--agent", "claude-code", "--url", stub.url], null, true);
          expect(run.code).toBe(0);
          expect(run.stdout).toBe("");
          samples.push(run.ms);
        }
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
        // The deadline detached stdin instead of leaving the process (and
        // its buffer) alive on an open pipe; nothing was buffered, so
        // nothing was delivered.
        expect(median).toBeLessThan(50);
        expect(stub.requests).toHaveLength(0);
      } finally {
        await stub.close();
      }
    });
  });

  it("exits 0 inside the per-event budget when the producer writes but never closes stdin", {
    timeout: generousTimeoutMs,
    retry: 2,
  }, async () => {
    // Load-robust budget assertion: spawn-to-exit includes process start,
    // so machine load can exceed 50 ms without the relay misbehaving. The
    // median of several spawns absorbs one-off spikes, and the vitest retry
    // absorbs a sustained spike that shifts a whole median; a real
    // deadline-logic violation exceeds the budget on every spawn of every
    // attempt and still fails. The 50 ms budget itself is unchanged (docs/ARCHITECTURE.md
    // §4).
    await withRelayTimingLock(async () => {
      const stub = await startStub(204);
      try {
        const samples: number[] = [];
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const run = await runRelay(["--agent", "claude-code", "--url", stub.url], payload, true);
          expect(run.code).toBe(0);
          expect(run.stdout).toBe("");
          samples.push(run.ms);
        }
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
        // Whatever arrived before the deadline is forwarded, the pipe is
        // detached, and the process ends inside the budget instead of
        // buffering an open stdin forever.
        expect(median).toBeLessThan(50);
      } finally {
        await stub.close();
      }
    });
  });

  it(
    "drops the event rather than misrouting it when the adapter id flag is missing",
    async () => {
      const stub = await startStub(204);
      try {
        const run = await runRelay(["--url", stub.url], payload);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe("");
        expect(stub.requests).toHaveLength(0);
        // The documented bounded stderr note names the problem.
        expect(run.stderr).toContain("hearable-hook");
      } finally {
        await stub.close();
      }
    },
    generousTimeoutMs,
  );
});
