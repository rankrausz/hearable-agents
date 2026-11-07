// Measures hooks with the installed shell up, quit, and killed; must keep the existing 50 ms budget.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test",
  testMatch: "relay.spec.ts",
  workers: 1,
  timeout: 60_000,
  reporter: "list",
});
