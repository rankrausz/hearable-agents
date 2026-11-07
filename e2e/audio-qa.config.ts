// e2e/audio-qa.config.ts — Playwright config for `pnpm audio:qa` only. What
// this is for: running the audio QA spec without the web preview server the
// smoke specs need, so a stale or foreign preview on the shared port can never
// feed a render, and so workers spread the per-scenario tests across cores.
// What it must not do: change any bound, seed or scenario — those live in the
// spec and the audio package.

import { defineConfig } from "@playwright/test";

const workersFromEnv = process.env.AUDIO_QA_WORKERS;

export default defineConfig({
  // Paths resolve against this file, which lives inside e2e/.
  testDir: ".",
  testMatch: /(?:audio-qa|mac-audio-qa)\.spec\.ts$/,
  fullyParallel: true,
  reporter: "list",
  ...(workersFromEnv === undefined ? {} : { workers: Number(workersFromEnv) }),
  use: {
    headless: true,
  },
});
