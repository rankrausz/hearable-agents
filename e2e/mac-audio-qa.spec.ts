// Numeric shell fader QA; must not change the scene or stand in for the owner's listen.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test("mac-volume-controls ramps the complete output without a step", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "hearable-fader-"));
  await build({
    stdin: {
      contents:
        'export { setShellVolume } from "./apps/web/src/popover/volume.ts"; export * as tone from "./apps/web/node_modules/tone/build/esm/index.js";',
      resolveDir: resolve("."),
    },
    outfile: join(dir, "fader.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
  });
  const bundle = await readFile(join(dir, "fader.js"));
  const server = createServer((req, res) => {
    res.setHeader("content-type", req.url === "/fader.js" ? "text/javascript" : "text/html");
    res.end(
      req.url === "/fader.js"
        ? bundle
        : '<script type="module">import * as qa from "/fader.js"; window.qa = qa;</script>',
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No QA port");
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => "qa" in window);
    const metrics = await page.evaluate(async () => {
      const { tone, setShellVolume } = (
        window as unknown as {
          qa: {
            tone: typeof import("../apps/web/node_modules/tone/build/esm/index.js");
            setShellVolume(volume: number, at: number): void;
          };
        }
      ).qa;
      const buffer = await tone.Offline(
        () => {
          new tone.Signal(0.5).connect(tone.getDestination());
          setShellVolume(0, 0.5);
          setShellVolume(1, 2);
          setShellVolume(0.4, 3.5);
        },
        5,
        1,
        48000,
      );
      const data = buffer.getChannelData(0);
      let jump = 0;
      for (let i = 1; i < data.length; i++)
        jump = Math.max(jump, Math.abs((data[i] ?? 0) - (data[i - 1] ?? 0)));
      return {
        jump,
        full: data[12000],
        half: data[48000],
        silent: data[85000],
        up: data[144000],
        reduced: data[230000],
      };
    });
    expect(metrics.full).toBeCloseTo(0.5, 3);
    expect(metrics.half).toBeCloseTo(0.25, 2);
    expect(metrics.silent).toBeCloseTo(0, 4);
    expect(metrics.up).toBeCloseTo(0.5, 3);
    expect(metrics.reduced).toBeCloseTo(0.2, 3);
    expect(metrics.jump).toBeLessThan(0.001);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});
