// scripts/dev.mjs — `pnpm dev` for Phase 1: run the daemon and the web dev
// server together. What this is for: one command that starts the daemon (so
// `POST /events` and `/ws` work) and Vite (so the console reloads live) from
// a clean clone after install. What it must not do: install anything, build
// anything, or hide child output — both processes inherit stdio, and a
// non-zero exit from either ends the command with that code.

import { spawn } from "node:child_process";

const DAEMON_URL = process.env.HEARABLE_DAEMON_URL ?? "http://127.0.0.1:4876";
const WEB_PORT = process.env.HEARABLE_WEB_PORT ?? "5173";

const children = [];

function run(name, command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.push({ name, child });
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const reason =
      signal !== null && signal !== undefined ? `signal ${signal}` : `exit code ${code ?? 0}`;
    console.error(`${name} stopped (${reason}). Stopping the other process.`);
    shutdown(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`${name} could not start: ${error.message}.`);
    shutdown(1);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const { child } of children) {
    child.kill("SIGTERM");
  }
  process.exitCode = code;
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

// The daemon serves the production build at `/` when it exists; the Vite dev
// server is the iteration surface. The daemon runs from TypeScript sources
// with type stripping (Node ≥ 22.12, already the repo floor), so `pnpm dev`
// on a clean clone needs no build step beyond `pnpm install`.
const nodeArgs = ["--experimental-strip-types", "--no-warnings", "scripts/dev-daemon.mjs"];
run("daemon", "node", nodeArgs);
run(
  "web",
  "pnpm",
  ["--filter", "@hearable/web", "exec", "vite", "--port", WEB_PORT, "--strictPort"],
  {
    env: { ...process.env },
  },
);

console.error(`Hearable dev: daemon at ${DAEMON_URL}, web at http://127.0.0.1:${WEB_PORT}.`);
console.error("The web dev server proxies /events and /ws to the daemon.");
