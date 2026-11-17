#!/usr/bin/env node
// packages/adapter-kit/src/relay/hearable-hook.mjs — the hearable-hook relay:
// the one command-hook binary every hook-based adapter (Claude Code, Codex,
// Cursor) points at. It reads the raw hook payload from stdin and POSTs it,
// bytes untouched, to the daemon's POST /events with the adapter id in the
// x-hearable-agent header (docs/EVENTS.md §Wire format). It must never hurt
// the agent (AGENTS.md rule 2): it exits 0 in all circumstances, finishes in
// tens of milliseconds, writes nothing to stdout, and runs from this exact
// committed file with no build step (ADR 0014). Its only import is Node's
// own http client — measured faster per fresh process than the lazily loaded
// global fetch against the < 50 ms budget — and it must never grow another
// dependency, nor parse, validate or transform the payload: the daemon owns
// validation and quarantine, and this file is a dumb, fast pipe.

// Read the HTTP client directly to avoid initializing the full ESM namespace
// on each hook invocation. Older Node versions on the agent's PATH use the import.
const { request: httpRequest } =
  process.getBuiltinModule?.("node:http") ?? (await import("node:http"));

// Reading stdin and posting it share a deadline on Node's process clock.
// Reserve the rest of the 50 ms wall-clock target for launch overhead and
// teardown. A fast startup leaves more time for localhost delivery, while
// a slow startup spends that time before the relay begins reading.
const DELIVERY_DEADLINE_MS = 33;
const BUNDLED_MAC_RELAY = process.env.HEARABLE_MAC_BUNDLED_RELAY === "1";

// The read may not spend the whole budget: a producer that never closes
// stdin must not starve the POST of its slice of the deadline.
const READ_BUDGET_MS = 6;

function remainingBudgetMs() {
  return Math.max(1, DELIVERY_DEADLINE_MS - performance.now());
}

/**
 * Parses the relay's two flags. This is the single documented mechanism by
 * which the relay learns the adapter id (sent as the x-hearable-agent
 * header) and the daemon URL; installers embed both into the hook command
 * they write (docs/ARCHITECTURE.md §The hook relay). Unknown tokens are
 * ignored so a future flag can never break an already-installed hook.
 */
function parseFlags(argv) {
  const flags = { agent: undefined, url: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--agent") {
      flags.agent = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--url") {
      flags.url = argv[index + 1];
      index += 1;
    }
  }
  return flags;
}

/**
 * Reads stdin to end-of-file, or until the delivery budget runs out,
 * whichever comes first, and resolves with whatever arrived. Never rejects
 * and never waits past the deadline. When the deadline fires, stdin is
 * destroyed and thereby detached: a producer that keeps the pipe open can
 * neither keep this process alive nor keep its buffer growing.
 */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(Buffer.concat(chunks));
    };
    process.stdin.on("data", (chunk) => {
      chunks.push(chunk);
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(
      () => {
        process.stdin.destroy();
        finish();
      },
      Math.min(remainingBudgetMs(), READ_BUDGET_MS),
    ).unref();
  });
}

// One bounded line on stderr, naming the drop reason. The agent may show
// stderr in verbose logs; it must never delay exit, and stdout stays silent
// because the agent may parse it.
function noteDrop(reason) {
  console.error(`hearable-hook: event dropped (${reason})`);
}

function reasonFor(error) {
  if (error instanceof Error && typeof error.code === "string" && error.code !== "") {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown error";
}

/**
 * Sends the payload once and resolves with a drop reason, or undefined when
 * the daemon accepted the request. The response body is never read: the
 * daemon never returns an error body to a hook, and the relay has nothing to
 * do with a status code. `Connection: close` makes the socket, and therefore
 * the process, end as soon as the daemon has answered.
 */
function post(flags, body) {
  return new Promise((resolve) => {
    let outcome;
    let decided = false;
    const decide = (reason) => {
      if (!decided) {
        decided = true;
        outcome = reason;
      }
    };
    let request;
    // An explicit timer on whatever remains of the shared budget — not only
    // a socket timeout — so the process ends inside the budget even if the
    // connection itself stalls.
    let timer = setTimeout(() => {
      decide("TimeoutError");
      if (request !== undefined) {
        request.destroy();
      }
    }, remainingBudgetMs());
    timer.unref();
    try {
      const target = new URL("/events", flags.url);
      request = httpRequest(
        {
          hostname: target.hostname.replace(/^\[|\]$/g, ""),
          port: target.port === "" ? undefined : Number(target.port),
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hearable-agent": flags.agent,
            // Separate transport metadata: the raw payload remains byte-exact.
            "x-hearable-focus": Buffer.from(
              JSON.stringify({
                pid: process.ppid,
                termProgram: process.env.TERM_PROGRAM?.slice(0, 256),
                termSessionId: process.env.TERM_SESSION_ID?.slice(0, 256),
                itermSessionId: process.env.ITERM_SESSION_ID?.slice(0, 256),
                remote: Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
              }),
            ).toString("base64url"),
            "content-length": body.length,
            connection: "close",
          },
        },
        (response) => {
          decide();
          response.resume();
        },
      );
      if (BUNDLED_MAC_RELAY) {
        // Keep the full send budget. After the OS takes the complete request,
        // give loopback a moment to respond without waiting on daemon work.
        request.once("finish", () => {
          clearTimeout(timer);
          timer = setTimeout(
            () => {
              decide();
              request?.destroy();
            },
            Math.min(remainingBudgetMs(), 2),
          ).unref();
        });
      }
      request.on("error", (error) => {
        decide(reasonFor(error));
      });
      request.on("close", () => {
        clearTimeout(timer);
        resolve(outcome);
      });
      request.end(body);
    } catch (error) {
      clearTimeout(timer);
      resolve(reasonFor(error));
    }
  });
}

/**
 * Delivers one hook payload. Resolves in every circumstance; drops the event
 * with a stderr note when delivery is impossible or too slow. An empty stdin
 * is a hook misfire with nothing to deliver; a malformed payload is still
 * forwarded so the daemon can quarantine it.
 */
async function deliver(flags, body) {
  if (body.length === 0) {
    return;
  }
  if (flags.agent === undefined || flags.url === undefined) {
    noteDrop("the hook command must set both --agent <adapter id> and --url <daemon url>");
    return;
  }
  const outcome = await post(flags, body);
  if (outcome !== undefined) {
    noteDrop(outcome);
  }
}

async function main() {
  const body = await readStdin();
  await deliver(parseFlags(process.argv.slice(2)), body);
  process.exitCode = 0;
}

// The contract is exit 0 in all circumstances (AGENTS.md rule 2), so even a
// failure outside main — an EPIPE while writing the stderr note, for example
// — must not turn into a nonzero exit. These handlers stay silent because
// stderr itself may be the broken pipe.
process.on("uncaughtException", () => {
  process.exitCode = 0;
});
process.on("unhandledRejection", () => {
  process.exitCode = 0;
});

main().catch(() => {
  process.exitCode = 0;
});
