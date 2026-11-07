// apps/web/vite.config.ts — Vite dev server for the bare web console.
// What this is for: serving the React lane view in dev and building
// apps/web/dist, which the daemon serves at `/` by convention (docs/ARCHITECTURE.md,
// task p1-t09). What it must not do: proxy or rewrite daemon traffic — the
// browser connects to the daemon WebSocket directly.

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // In `pnpm dev` the page comes from Vite but the data comes from the
      // daemon next door, so same-origin /ws and /events resolve here.
      "/ws": {
        target: "ws://127.0.0.1:4876",
        ws: true,
      },
      "/events": "http://127.0.0.1:4876",
      "/health": "http://127.0.0.1:4876",
      "/calm": "http://127.0.0.1:4876",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The nature-bed WAV rides the web build as a bundler-resolved ?url
    // asset (revp3t15): the emitted .wav lands in dist/assets beside the
    // JS, and the daemon serves it with audio/wav (see serveStatic).
    assetsInlineLimit: 0,
  },
});
