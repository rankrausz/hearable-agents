// packages/adapters/codex/vitest.config.ts — per-package test
// configuration so `pnpm --filter @hearable/codex test` runs exactly this
// package's tests. Mirrors the other packages: build output is excluded,
// and the shared ignore list keeps node_modules, git internals and dist
// out of every run.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  },
});
