#!/usr/bin/env node
// packages/cli/src/bin.ts — the executable entry for `hearable`. What this
// is for: running the command dispatcher against the real daemon functions
// and exiting with its exit code, without forking or daemonizing (a
// foreground daemon stays up until SIGINT/SIGTERM, so the printed URL lives
// exactly as long as the process). What it must not do: parse flags (parse.ts
// owns that) or implement any daemon behaviour.
//
// Invoked with `pnpm --filter @hearable/cli hearable …` (or directly with
// `node --experimental-transform-types --import ./src/ts-loader.mjs
// src/bin.ts`); root binary-name registration belongs to p1-t12. Run straight
// from TypeScript sources via Node's type transformation and the ts-loader
// resolve hook — no build step. `--experimental-transform-types` (not plain
// stripping) because the daemon's classes use constructor parameter
// properties, which strip-only mode refuses.

import { realDeps, runHearable } from "./run.js";

const exitCode = await runHearable(process.argv.slice(2), realDeps());
process.exitCode = exitCode;
