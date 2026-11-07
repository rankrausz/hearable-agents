// packages/adapter-kit/vitest.config.ts — per-package test configuration so
// `pnpm --filter @hearable/adapter-kit test` runs exactly this package's
// unit tests. Vitest 5's built-in default exclude no longer skips build
// output, and `tsc --build` emits compiled tests into dist/, so dist must be
// excluded here explicitly, mirroring the root and core configurations. The
// conformance self-check (conformance/selfcheck.ts) is deliberately not a
// *.test.ts file: it runs under `pnpm conformance` via
// conformance/vitest.config.ts, not as a unit test.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  },
});
