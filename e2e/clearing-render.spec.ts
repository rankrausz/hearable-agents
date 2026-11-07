// e2e/clearing-render.spec.ts — the p3-t02 offline render smoke: the
// Clearing graph renders a short buffer in headless Chromium (Tone.Offline
// against the real Web Audio engine) without clicks. What this is for:
// proving the actual package graph (createScene through the master chain
// plus two apply() moves through applyToGraph) renders without clicks — no
// sample-to-sample jump above 0.3 full scale (fatigue rule 6) — with the
// master compressor/limiter in the path and the FM bell voice built. Peak
// is reported and bounded against a smoke-level ceiling with genuine
// headroom (see the assertion note); the exact fatigue-rule-1 level bound
// belongs to p3-t05. What it must not do: assert full fatigue rules, grow
// product assertions, or touch the network — the spec builds a
// self-contained single-file bundle of the audio package plus the pinned
// Tone.js with the repo's own Vite (the published ESM build keeps bare
// `standardized-audio-context`/`tslib` imports, which browsers cannot
// resolve), serves it from the page's own http:// origin (dynamic import
// from about:blank is origin-opaque and cannot fetch), and deletes the
// bundle afterwards.

import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "..");

const GRAPH_EXCERPT = `import { render } from "@hearable/core";
import { applyToGraph, createScene } from "./src/index.js";
import * as Tone from "tone";
export async function renderClearingExcerpt() {
  const lane = (laneId, mode, lifecycle) => ({
    laneId,
    lifecycle,
    mode,
    displayedMode: "exploring",
    activity: 0.8,
    progress: 0.2,
    struggle: 0.1,
    prominence: 0.5,
    foreground: false,
    gestures: [],
  });
  const first = render(
    [
      lane(0, { exploring: 0.6, editing: 0.2, testing: 0.2, other: 0 }, "active"),
      lane(1, { exploring: 0.2, editing: 0.6, testing: 0.2, other: 0 }, "active"),
      lane(2, { exploring: 0.2, editing: 0.2, testing: 0.6, other: 0 }, "waiting"),
    ],
    0.6,
  );
  let descriptor;
  const summary = { sampleRate: 0, length: 0, peak: 0, maxJump: 0, lanes: 0, graph: null };
  const buffer = await Tone.Offline(async () => {
    const graph = createScene(Tone, { laneCount: 3 });
    await graph.reverb.ready;
    descriptor = applyToGraph(graph, first);
    summary.lanes = graph.lanes.length;
    const second = render(
      [
        lane(0, { exploring: 0.1, editing: 0.8, testing: 0.1, other: 0 }, "active"),
        lane(1, { exploring: 0.2, editing: 0.6, testing: 0.2, other: 0 }, "waiting"),
        lane(2, { exploring: 0.2, editing: 0.2, testing: 0.6, other: 0 }, "active"),
      ],
      0.6,
    );
    applyToGraph(graph, second, descriptor);
    summary.graph = graph;
  }, 3);
  const channel = buffer.getChannelData(0);
  summary.sampleRate = buffer.sampleRate;
  summary.length = channel.length;
  let previous = channel[0] ?? 0;
  for (const sample of channel) {
    const magnitude = Math.abs(sample);
    if (magnitude > summary.peak) summary.peak = magnitude;
    const jump = Math.abs(sample - previous);
    if (jump > summary.maxJump) summary.maxJump = jump;
    previous = sample;
  }
  await summary.graph.dispose();
  return summary;
}
`;

/** Bundles the audio package plus the pinned Tone.js to one browser file. */
async function bundleForBrowser(outFile: string): Promise<void> {
  // Vite resolves bare imports (like "tone" and "@hearable/core") relative
  // to the entry: the entry must live under the build root, so it is
  // written into packages/audio (removed afterwards with the bundle output).
  const audioRoot = join(REPO_ROOT, "packages", "audio");
  const audioEntry = join(audioRoot, ".tmp-clearing-graph.entry.js");
  const audioOut = join(audioRoot, ".tmp-clearing");
  await writeFile(audioEntry, GRAPH_EXCERPT);
  await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'import { build } from "./apps/web/node_modules/vite/dist/node/index.js";',
        "await build({",
        '  root: "packages/audio",',
        '  logLevel: "silent",',
        "  build: {",
        '    outDir: ".tmp-clearing",',
        "    emptyOutDir: true,",
        "    minify: false,",
        '    lib: { entry: ".tmp-clearing-graph.entry.js", formats: ["es"], fileName: () => "clearing-bundle.mjs" },',
        "  },",
        "});",
      ].join("\n"),
    ],
    { cwd: REPO_ROOT },
  );
  const bundled = await readFile(join(audioOut, "clearing-bundle.mjs"), "utf8");
  await writeFile(outFile, bundled);
  await rm(audioEntry, { force: true });
  await rm(audioOut, { force: true, recursive: true });
}

test("the clearing graph renders a short buffer without clicks", async ({ page }) => {
  const bundleFile = join(REPO_ROOT, "e2e", ".tmp-clearing-bundle.mjs");
  await bundleForBrowser(bundleFile);
  try {
    const bundle = await readFile(bundleFile, "utf8");
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body>clearing render</body></html>");
        return;
      }
      if (pathname === "/clearing-bundle.mjs") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(bundle);
        return;
      }
      res.writeHead(404).end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      const result = await page.evaluate(async (baseUrl: string) => {
        const graph = await import(`${baseUrl}/clearing-bundle.mjs`);
        return graph.renderClearingExcerpt();
      }, `http://127.0.0.1:${port}`);

      expect(result.sampleRate).toBeGreaterThan(0);
      expect(result.length).toBeGreaterThan(result.sampleRate * 2);
      expect(result.lanes).toBe(3);
      expect(result.peak).toBeGreaterThan(0);
      // Smoke-level peak bound, not the fatigue-rule-1 level bound (p3-t05
      // owns that). The limiter is a 20:1 compressor with a 3 ms attack,
      // not a brickwall: on this render's unseeded Noise starts (Tone's
      // Noise begins its looped buffer at a Math.random offset, and the
      // shared reverb IR is itself generated from noise) plus offline
      // faster-than-realtime scheduling jitter, conductor runs measured
      // peaks from ~0.58 up to ~1.19 pre-fix and 0.728 on the 0.72 ceiling
      // post-fix. The ceiling here is the −3 dBFS limiter threshold
      // (~0.708 linear) plus a jitter margin covering that observed spread:
      // it guards against routing regressions that bypass the master chain
      // (which measured well above 1.0) without pretending a soft-knee
      // compressor guarantees a hard sample ceiling.
      expect(result.peak).toBeLessThanOrEqual(0.85);
      expect(result.maxJump).toBeLessThan(0.3);
      console.log(
        `clearing-render peak=${result.peak.toFixed(6)} maxJump=${result.maxJump.toFixed(6)}`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await rm(bundleFile, { force: true });
  }
});
