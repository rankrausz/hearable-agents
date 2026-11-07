// Native shell smoke checks; must use isolated daemon and app data, never owner sessions.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test",
  testMatch: "**/*.spec.ts",
  testIgnore: ["**/packaged.spec.ts", "**/endurance.spec.ts", "**/relay.spec.ts"],
  workers: 1,
  timeout: 30_000,
  reporter: "list",
});
