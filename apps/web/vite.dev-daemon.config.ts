// apps/web/vite.dev-daemon.config.ts — library-mode bundle for `pnpm dev`.
// What this is for: bundling packages/daemon/src/index.ts plus its workspace
// imports into one ESM file, next to the daemon package. What it must not do:
// serve anything or watch — this is a one-shot build, not a dev server.

import { defineConfig } from "vite";

const outDir = process.env.HEARABLE_DEV_OUTDIR;
if (!outDir) {
  throw new Error("HEARABLE_DEV_OUTDIR is not set. Run scripts/dev-daemon.mjs instead.");
}

export default defineConfig({
  build: {
    outDir,
    emptyOutDir: true,
    lib: {
      entry: "../../scripts/dev-daemon-entry.ts",
      formats: ["es"],
      fileName: () => "dev-daemon.mjs",
    },
    rollupOptions: {
      // ws stays external: bundling it pulls the browser stub (ws/package.json
      // `browser` field). zod bundles cleanly, so it is included.
      external: [/^node:/, "ws"],
    },
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  logLevel: "error",
});
