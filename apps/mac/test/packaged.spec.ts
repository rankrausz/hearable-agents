// Exercises a copied application from outside the checkout; must restore the OS login setting.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { consolePage as findConsole } from "./windows.js";

test("installed app serves its own assets, registers login, and stops its daemon", async () => {
  const executable = process.env.HEARABLE_MAC_EXECUTABLE;
  if (!executable) throw new Error("Set HEARABLE_MAC_EXECUTABLE to the installed Hearable binary.");
  const dir = await mkdtemp(join(tmpdir(), "hearable-installed-"));
  const config = join(dir, "config.json");
  await mkdir(join(dir, "app"));
  await writeFile(config, JSON.stringify({ port: 0, dataDir: dir }));
  const shell = await electron.launch({
    executablePath: executable,
    args: ["--mute-audio"],
    cwd: dir,
    env: {
      ...process.env,
      HEARABLE_MAC_TEST: "1",
      HEARABLE_MAC_CONFIG: config,
      HEARABLE_MAC_DATA_DIR: join(dir, "app"),
    },
  });
  let originalLogin: boolean | undefined;
  try {
    const consolePage = await findConsole(shell);
    await expect(consolePage.getByText("live", { exact: true })).toBeVisible();
    const identity = await shell.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged,
      path: app.getAppPath(),
      visible: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
      login: app.getLoginItemSettings().openAtLogin,
      tray: !(globalThis as unknown as { hearableTray: Electron.Tray }).hearableTray.isDestroyed(),
    }));
    expect(identity.packaged).toBe(true);
    expect(identity.tray).toBe(true);
    expect(identity.path).toContain("Hearable.app/Contents/Resources/app.asar");
    expect(identity.visible).toBe(false);
    originalLogin = identity.login;
    const url = new URL(consolePage.url()).origin;
    const index = await (await fetch(url)).text();
    expect(index).toContain('id="root"');
    const script = index.match(/src="([^"]+\.js)"/u)?.[1];
    expect(script).toBeDefined();
    expect((await fetch(`${url}${script}`)).ok).toBe(true);
    const icon = await fetch(`${url}/hearable-icon.svg`);
    expect(icon.ok).toBe(true);
    const at = Date.now();
    await fetch(`${url}/events`, {
      method: "POST",
      headers: { "x-hearable-agent": "claude-code", "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "installed-smoke",
        cwd: "/test/installed-smoke",
      }),
    });
    const popover = shell.windows().find((page) => page.url().includes("view=popover"));
    if (!popover) throw new Error("The installed popover did not load");
    await expect(popover.getByText("Claude Code", { exact: true })).toBeVisible();
    expect(Date.now() - at).toBeLessThan(1000);
    await consolePage.evaluate(() =>
      (
        window as unknown as {
          hearableShell: {
            commandAudio(command: { type: "enabled"; enabled: boolean }): Promise<void>;
          };
        }
      ).hearableShell.commandAudio({ type: "enabled", enabled: true }),
    );
    await expect(consolePage.getByText("Audio is running", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const login = await shell.evaluate(({ app }) => {
      app.setLoginItemSettings({ openAtLogin: true });
      return app.getLoginItemSettings();
    });
    console.log(
      `Installed login check: ${JSON.stringify({ openAtLogin: login.openAtLogin, status: login.status })}`,
    );
    expect(login.openAtLogin || login.status === "requires-approval").toBe(true);
    await shell.evaluate(
      ({ app }, enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
      originalLogin,
    );
    expect(await shell.evaluate(({ app }) => app.getLoginItemSettings().openAtLogin)).toBe(
      originalLogin,
    );
    originalLogin = undefined;
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
    if (originalLogin !== undefined)
      await shell
        .evaluate(
          ({ app }, enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
          originalLogin,
        )
        .catch(() => {});
    await shell.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
