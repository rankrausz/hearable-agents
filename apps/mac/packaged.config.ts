// Explicit installed-app checks; must never run during ordinary development smoke tests.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test",
  testMatch: "packaged.spec.ts",
  workers: 1,
  timeout: 30_000,
  reporter: "list",
});
