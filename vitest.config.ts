// Root Vitest configuration. Vitest 5 runs the workspace via `test.projects`;
// the `vitest.workspace.ts` file was removed in Vitest 4, so this config file
// replaces it. Each package is one inline project that inherits the root
// options below. Projects are listed explicitly so package directories that
// are not packages yet (packages/adapters, the biome config holder) are never
// treated as one. The list is the Phase 1 surface (core, the kit, the daemon,
// the CLI, the web console and both reference adapters) plus the Phase 3
// audio package, so one root `pnpm test` proves the pipeline green (p1-t12).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    projects: [
      { test: { name: "@hearable/mac", root: "apps/mac", include: ["test/**/*.test.ts"] } },
      {
        test: {
          name: "@hearable/core",
          root: "packages/core",
        },
      },
      {
        test: {
          name: "@hearable/audio",
          root: "packages/audio",
        },
      },
      {
        test: {
          name: "@hearable/adapter-kit",
          root: "packages/adapter-kit",
        },
      },
      {
        test: {
          name: "@hearable/daemon",
          root: "packages/daemon",
        },
      },
      {
        test: {
          name: "@hearable/cli",
          root: "packages/cli",
        },
      },
      {
        test: {
          name: "@hearable/web",
          root: "apps/web",
        },
      },
      {
        test: {
          name: "@hearable/claude-code",
          root: "packages/adapters/claude-code",
        },
      },
      {
        test: {
          name: "@hearable/codex",
          root: "packages/adapters/codex",
        },
      },
    ],
  },
});
