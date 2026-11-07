// packages/adapters/claude-code/vitest.config.ts — per-package test
// configuration so `pnpm --filter @hearable/claude-code test` runs exactly
// this package's tests. Mirrors the daemon and adapter-kit configs: dist must
// be excluded explicitly because `tsc --build` emits compiled tests there.
// Root registration belongs to p1-t12; until then per-package runs are the
// contract (see the adapter fixture conformance contract).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  },
});
