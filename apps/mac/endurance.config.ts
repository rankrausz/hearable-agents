// Explicit long-run checks; must not run an hour of playback during ordinary smoke tests.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test",
  testMatch: "endurance.spec.ts",
  workers: 1,
  timeout: 4_200_000,
  reporter: "list",
});
