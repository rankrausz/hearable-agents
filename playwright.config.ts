// Root Playwright configuration for Hearable Agents. This harness exists so
// Phase 3 audio QA (Tone.Offline renders) and Phase 4 UI smoke tests have a
// place to land. Product smoke assertions live in the specs, and the preview
// web server below serves the built console for those browser checks.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // The audio QA runs under its own config (e2e/audio-qa.config.ts via
  // `pnpm audio:qa`): it needs no preview server and takes minutes per test.
  testIgnore: /audio-qa\.spec\.ts$/,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  reporter: "list",
  use: {
    headless: true,
  },
  webServer: {
    command:
      "pnpm --filter @hearable/web exec vite build && pnpm --filter @hearable/web exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
  // A fresh clone must run `pnpm exec playwright install chromium` once, or
  // `pnpm test:e2e` fails with Playwright's own plain-language error pointing
  // at the command to download browsers ("Executable doesn't exist ... Please
  // run the following command to download new browsers").
});
