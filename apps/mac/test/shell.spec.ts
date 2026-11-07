// Exercises real windows and daemon ownership; must not touch owner config or claim owner audio.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDaemon } from "@hearable/daemon";
import { _electron as electron, expect, test } from "@playwright/test";
import { consolePage } from "./windows.js";

test("adopts a running daemon, isolates its console, and hides on close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearable-mac-"));
  const daemon = await startDaemon({
    config: { host: "127.0.0.1", port: 0, lanes: 4, laneReleaseAfterMs: 300_000, dataDir: dir },
    adapters: [],
    webRoot: resolve("apps/mac/dist/web"),
  });
  const config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({ port: daemon.port, dataDir: dir }));
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
    const page = await consolePage(shell);
    await expect(page.getByRole("heading", { name: "Hearable", exact: true })).toBeVisible();
    expect(
      await shell.evaluate(({ BrowserWindow, app }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => !window.webContents.getURL().includes("view=popover"),
        );
        return {
          visible: window?.isVisible(),
          dock: app.dock?.isVisible(),
          backgroundThrottling: window?.webContents.backgroundThrottling,
        };
      }),
    ).toMatchObject({
      visible: false,
      dock: false,
      backgroundThrottling: false,
    });
    expect(
      await shell.evaluate(() => {
        const tray = (globalThis as unknown as { hearableTray: { isDestroyed(): boolean } })
          .hearableTray;
        return tray && !tray.isDestroyed();
      }),
    ).toBe(true);
    expect(
      await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
    ).toBe("undefined");
    expect(
      await page.evaluate(
        () =>
          "openConsole" in ((window as unknown as { hearableShell?: object }).hearableShell ?? {}),
      ),
    ).toBe(false);
    await shell.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.getURL().includes("view=popover"))
        ?.close(),
    );
    expect(
      await shell.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => !window.webContents.getURL().includes("view=popover"))
          ?.isVisible(),
      ),
    ).toBe(false);
    const lock = JSON.parse(await readFile(join(dir, "daemon.lock"), "utf8"));
    expect(lock.pid).toBe(process.pid);
    await shell.close();
    expect((await fetch(`${daemon.url}/health`)).ok).toBe(true);
  } finally {
    await shell.close().catch(() => {});
    await daemon.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("starts its own daemon and releases it on quit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearable-mac-owned-"));
  const config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({ port: 0, dataDir: dir }));
  await mkdir(join(dir, "app"));
  await writeFile(join(dir, "app/preferences.json"), JSON.stringify({ audioEnabled: true }));
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
    const page = await consolePage(shell);
    await expect(page.getByRole("heading", { name: "Hearable", exact: true })).toBeVisible();
    await expect(page.getByText("Audio ready · no active agents", { exact: true })).toBeVisible();
    const url = new URL(page.url()).origin;
    expect((await fetch(`${url}/health`)).ok).toBe(true);
    await shell.close();
    await expect
      .poll(() =>
        fetch(`${url}/health`).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    await expect(readFile(join(dir, "daemon.lock"))).rejects.toThrow();
  } finally {
    await shell.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
