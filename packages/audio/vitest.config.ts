// packages/audio/vitest.config.ts — per-package test configuration so
// `pnpm --filter @hearable/audio test` runs exactly this package's tests.
// Mirrors the root and core configs: Vitest 5 no longer skips build output,
// so dist is excluded explicitly. Audio tests never touch the Web Audio API:
// they assert on the pure ramp planner and the scene constants. Offline and
// browser renders belong to `pnpm audio:qa` (p3-t05) and the sandbox (p3-t06),
// not to unit tests. This config must not grow project definitions or test
// includes beyond packages/audio.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  },
});
