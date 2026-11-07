// packages/core/vitest.config.ts — per-package test configuration so
// `pnpm --filter @hearable/core test` runs exactly this package's tests.
// Vitest 5's built-in default exclude no longer skips build output, and
// `tsc --build` emits compiled tests into dist/, so dist must be excluded here
// explicitly, mirroring the root vitest.config.ts. This config must not grow
// project definitions or test includes beyond packages/core; multi-package
// runs belong to the root vitest.config.ts.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  },
});
