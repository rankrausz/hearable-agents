// Exercises a copied application from outside the checkout; must restore the OS login setting.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { consolePage as findConsole } from "./windows.js";

test("installed app serves its own assets, registers login, and stops its daemon", async () => {
  const executable = process.env.HEARABLE_MAC_EXECUTABLE;
  if (!executable) throw new Error("Set HEARABLE_MAC_EXECUTABLE to the installed Hearable binary.");
  const dir = await mkdtemp(join(tmpdir(), "hearable-installed-"));
  const profile = join(dir, "app");
  await mkdir(profile);
  await writeFile(join(profile, "daemon.json"), JSON.stringify({ port: 0, dataDir: dir }));
  const env = { ...process.env };
  delete env.HEARABLE_MAC_CONFIG;
  const shell = await electron.launch({
    executablePath: executable,
    args: ["--mute-audio"],
    cwd: dir,
    env: {
      ...env,
      HEARABLE_MAC_TEST: "1",
      HEARABLE_MAC_DATA_DIR: profile,
    },
  });
  let originalLogin: boolean | undefined;
  try {
    const consolePage = await findConsole(shell);
    await expect(consolePage.getByText("live", { exact: true })).toBeAttached();
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
    const lock = JSON.parse(await readFile(join(dir, "daemon.lock"), "utf8"));
    expect(lock.pid).toBe(shell.process().pid);
    const index = await (await fetch(url)).text();
    expect(index).toContain('id="root"');
    const script = index.match(/src="([^"]+\.js)"/u)?.[1];
    expect(script).toBeDefined();
    expect((await fetch(`${url}${script}`)).ok).toBe(true);
    const icon = await fetch(`${url}/hearable-icon.svg`);
    expect(icon.ok).toBe(true);
    const popover = shell.windows().find((page) => page.url().includes("view=popover"));
    if (!popover) throw new Error("The installed popover did not load");
    await shell.evaluate(() =>
      (globalThis as unknown as { hearableTray: Electron.Tray }).hearableTray.emit("click"),
    );
    await expect(popover.getByText("Connected", { exact: true })).toBeVisible();
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
    await expect(consolePage.getByRole("status")).toHaveText("Audio is running", {
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

test("connects both agents using only the packaged app", async () => {
  const executablePath = process.env.HEARABLE_MAC_EXECUTABLE;
  if (!executablePath)
    throw new Error("Set HEARABLE_MAC_EXECUTABLE to the installed Hearable binary.");
  const dir = await mkdtemp(join(tmpdir(), "hearable-setup-"));
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const profile = join(dir, "app");
  await mkdir(profile);
  await writeFile(join(profile, "daemon.json"), JSON.stringify({ port, dataDir: dir }));
  const env = { ...process.env };
  delete env.HEARABLE_MAC_CONFIG;
  const isolatedEnv = {
    ...env,
    HOME: dir,
    CODEX_HOME: join(dir, "codex"),
    HEARABLE_MAC_TEST: "1",
    HEARABLE_MAC_DATA_DIR: profile,
  };
  const shell = await electron.launch({
    executablePath,
    args: ["--mute-audio"],
    cwd: dir,
    env: isolatedEnv,
  });
  try {
    await findConsole(shell);
    await shell.evaluate(({ dialog }) => {
      const replies = [0, 1, 0, 2, 0];
      dialog.showMessageBox = async () => ({
        response: replies.shift() ?? 0,
        checkboxChecked: false,
      });
      (globalThis as unknown as { remainingDialogs: () => number }).remainingDialogs = () =>
        replies.length;
      (globalThis as unknown as { hearableTray: Electron.Tray }).hearableTray.emit("click");
    });
    const popover = shell.windows().find((page) => page.url().includes("view=popover"));
    if (!popover) throw new Error("The installed popover did not load");
    const button = popover.getByRole("button", { name: "Connect an agent" });
    const remaining = () =>
      shell.evaluate(() =>
        (globalThis as unknown as { remainingDialogs: () => number }).remainingDialogs(),
      );
    const claude = join(dir, ".claude/settings.json");
    const codex = join(dir, "codex/hooks.json");
    await button.click();
    await expect.poll(remaining).toBe(4);
    await expect(readFile(claude)).rejects.toHaveProperty("code", "ENOENT");
    await expect(readFile(codex)).rejects.toHaveProperty("code", "ENOENT");

    for (const [name, config, remainingCount] of [
      ["Claude Code", claude, 2],
      ["Codex", codex, 0],
    ] as const) {
      await button.click();
      await expect.poll(remaining).toBe(remainingCount);
      const settings = JSON.parse(await readFile(config, "utf8"));
      const command = settings.hooks.UserPromptSubmit[0].hooks[0].command as string;
      expect(command).toContain("hook-runtime/hearable-hook");
      const elapsed = await new Promise<number>((done, reject) => {
        const start = performance.now();
        const child = spawn("/bin/sh", ["-c", command], {
          cwd: dir,
          env: { PATH: "/usr/bin:/bin" },
          stdio: ["pipe", "pipe", "ignore"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0 && stdout === "") done(performance.now() - start);
          else reject(new Error(`Unexpected relay result: ${code}, ${stdout}`));
        });
        child.stdin.end(
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            session_id: `packaged-${name}`,
            cwd: "/test/hook-setup",
            prompt: "Packaged hook smoke",
          }),
        );
      });
      console.log(`${name} packaged hook: ${elapsed.toFixed(1)} ms`);
      await expect(popover.getByText(name, { exact: true })).toBeVisible();

      const missing = command.replaceAll("hook-runtime/hearable-hook", "hook-runtime/missing-hook");
      const skipped = spawnSync("/bin/sh", ["-c", missing], {
        cwd: dir,
        env: { PATH: "/usr/bin:/bin" },
        input: "ignored",
        encoding: "utf8",
        timeout: 1000,
      });
      expect({ status: skipped.status, stdout: skipped.stdout, stderr: skipped.stderr }).toEqual({
        status: 0,
        stdout: "",
        stderr: "",
      });
    }
  } finally {
    await shell.close();
    await rm(dir, { recursive: true, force: true });
  }
});
