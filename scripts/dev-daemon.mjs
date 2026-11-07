// scripts/dev-daemon.mjs — dev entry point for `pnpm dev`, run from the repo
// root. What this is for: starting the daemon with the same live adapters as
// `hearable start` next to the Vite dev server, so the web console can show
// real agent sessions during dogfooding. What it must not do: install hooks
// or mutate agent configuration.
//
// The daemon runs from a bundle built with the web workspace's Vite (already
// a repo dependency). Bundling is the honest option: the daemon's dist output
// imports the workspace by bare `@hearable/*` names, which only resolve from
// inside packages/daemon/node_modules, and the workspace `exports` point at
// TypeScript sources (not compiled output). `ws` stays external and resolves
// from packages/daemon/node_modules because the bundle lands next to the
// daemon package; the version lookup is patched to the same directory.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const bundleDir = mkdtempSync(join(tmpdir(), "hearable-dev-"));
const build = spawnSync(
  "pnpm",
  ["--filter", "@hearable/web", "exec", "vite", "build", "--config", "vite.dev-daemon.config.ts"],
  {
    cwd: join(root, "apps/web"),
    stdio: "inherit",
    env: { ...process.env, HEARABLE_DEV_OUTDIR: bundleDir },
  },
);
if (build.status !== 0) {
  console.error("Could not bundle the daemon. Fix the errors above and try again.");
  process.exit(build.status ?? 1);
}

// The bundle lives next to the daemon package while it runs: bare `ws`
// resolves from packages/daemon/node_modules, and the version lookup finds
// package.json. Removed on shutdown; gitignored so it never lands in a review.
const bundlePath = join(root, "packages/daemon/dev-daemon.bundle.mjs");
copyFileSync(join(bundleDir, "dev-daemon.mjs"), bundlePath);
const bundled = readFileSync(bundlePath, "utf8").replace(
  '("../package.json")',
  `(${JSON.stringify(join(root, "packages/daemon/package.json"))})`,
);
writeFileSync(bundlePath, bundled);

const { LIVE_ADAPTERS, loadConfig, startDaemon } = await import(pathToFileURL(bundlePath).href);
const config = loadConfig();
const runtime = await startDaemon({ config, adapters: LIVE_ADAPTERS });
console.error(`Hearable daemon listening on ${runtime.url}.`);

const shutdown = async (signal) => {
  console.error(`Received ${signal}. Stopping the daemon.`);
  await runtime.stop();
  rmSync(bundlePath, { force: true });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
