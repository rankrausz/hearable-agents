// Checks live compact UI and captures required states; must not synthesize a listening verdict.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDaemon } from "@hearable/daemon";
import { _electron as electron, expect, test } from "@playwright/test";

test("shows live lanes within one second and controls the hidden console", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearable-popover-"));
  const config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({ port: 0, dataDir: dir }));
  const shell = await electron.launch({
    args: [resolve("apps/mac"), "--mute-audio"],
    env: {
      ...process.env,
      HEARABLE_MAC_TEST: "1",
      HEARABLE_MAC_CONFIG: config,
      HEARABLE_MAC_DATA_DIR: join(dir, "app"),
    },
  });
  try {
    await shell.firstWindow();
    await expect.poll(() => shell.windows().length).toBe(2);
    const popover = shell.windows().find((page) => page.url().includes("view=popover"));
    expect(popover).toBeDefined();
    if (!popover) throw new Error("The popover did not load");
    await shell.evaluate(() =>
      (globalThis as unknown as { hearableTray: { emit(event: string): void } }).hearableTray.emit(
        "click",
      ),
    );
    await expect(popover.getByText("Connected", { exact: true })).toBeVisible();
    const screenshots = resolve("test-results/mac-captures");
    await mkdir(screenshots, { recursive: true });
    async function capture(name: string) {
      if (!popover) return;
      for (const colorScheme of ["light", "dark"] as const) {
        await popover.emulateMedia({ colorScheme });
        await popover.screenshot({
          path: join(screenshots, `active-portraits-${name}-${colorScheme}.png`),
        });
      }
    }
    await expect(popover.getByRole("checkbox", { name: "Open at login" })).toBeDisabled();
    await capture("empty");
    await shell.evaluate(() => {
      const tray = (globalThis as unknown as { hearableTray: Electron.Tray }).hearableTray;
      const original = tray.setImage.bind(tray);
      tray.setImage = (image) => {
        Object.assign(globalThis, {
          lastTrayImage: typeof image === "string" ? image : image.toDataURL(),
        });
        original(image);
      };
    });
    const origin = new URL(popover.url()).origin;
    async function post(sessionId: string, agent: string, kind: string) {
      const at = Date.now();
      await fetch(`${origin}/events`, {
        method: "POST",
        headers: { "x-hearable-normalized": "1", "content-type": "application/json" },
        body: JSON.stringify([
          {
            v: 1,
            id: `${sessionId}-${kind}`,
            ts: at,
            receivedAt: at,
            agent,
            sessionId,
            kind,
            ...(kind === "permission.request"
              ? { lifecycle: { reason: "permission", confidence: "observed" } }
              : {}),
          },
        ]),
      });
    }
    const start = performance.now();
    await post("mac-smoke-claude", "claude-code", "turn.start");
    await expect(popover.getByText("Working", { exact: true })).toBeVisible({ timeout: 1000 });
    expect(performance.now() - start).toBeLessThan(1000);
    await capture("one-working");
    await post("mac-smoke-codex", "codex", "turn.start");
    await post("mac-smoke-script", "emit", "turn.start");
    await post("mac-smoke-claude", "claude-code", "permission.request");
    await expect(popover.getByText("Waiting for you: permission", { exact: true })).toBeVisible();
    await expect(popover.getByRole("article")).toHaveCount(3);
    await expect
      .poll(() =>
        shell
          .evaluate(
            ({ nativeImage }, path) => ({
              actual: (globalThis as unknown as { lastTrayImage: string }).lastTrayImage,
              expected: nativeImage.createFromPath(path).toDataURL(),
            }),
            resolve("apps/mac/assets/trayWaitingTemplate.png"),
          )
          .then((images) => images.actual === images.expected),
      )
      .toBe(true);
    await capture("three-waiting");
    await popover.getByRole("slider", { name: "Calm", exact: true }).fill("0.75");
    await expect(popover.locator("output").first()).toHaveText("75%");
    await popover.getByRole("button", { name: "Audio Off", exact: true }).click();
    await expect(popover.getByText("Audio is running", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await popover.getByRole("slider", { name: "Volume", exact: true }).fill("0.4");
    await expect(popover.locator("output").nth(1)).toHaveText("40%");
    await popover.getByRole("button", { name: "Audio On", exact: true }).click();
    await expect(popover.getByText("Audio is off", { exact: true })).toBeVisible();
    await expect(popover.getByRole("button", { name: "Open console" })).toHaveCount(0);
  } finally {
    await shell.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("renders live lanes and Calm in a browser without shell controls", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "hearable-popover-browser-"));
  const daemon = await startDaemon({
    config: { host: "127.0.0.1", port: 0, lanes: 4, laneReleaseAfterMs: 300_000, dataDir: dir },
    adapters: [],
    webRoot: resolve("apps/mac/dist/web"),
  });
  try {
    await page.goto(`${daemon.url}/?view=popover`);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByRole("slider", { name: "Calm", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open console" })).toHaveCount(0);
    await expect(page.getByRole("slider", { name: "Volume", exact: true })).toHaveCount(0);
  } finally {
    await daemon.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
