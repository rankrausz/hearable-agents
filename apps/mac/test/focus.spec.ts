// Checks the real portrait/IPC boundary with isolated sessions; must not focus an owner's app.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("opens an agent from its portrait and explains missing or remote window information", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearable-focus-smoke-"));
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
    await expect
      .poll(() => shell.windows().some((page) => page.url().includes("view=popover")))
      .toBe(true);
    const popover = shell.windows().find((page) => page.url().includes("view=popover"));
    if (!popover) throw new Error("The popover did not load");
    await expect(popover.getByText("Connected", { exact: true })).toBeVisible();
    const origin = new URL(popover.url()).origin;
    async function post(headers = {}) {
      await fetch(`${origin}/events`, {
        method: "POST",
        headers: { "x-hearable-agent": "codex", ...headers },
        body: JSON.stringify({
          session_id: "focus-smoke",
          cwd: "/repo/focus-project",
          hook_event_name: "UserPromptSubmit",
        }),
      });
    }
    await post();
    await shell.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes("view=popover"),
      );
      window?.show();
      window?.focus();
    });
    const open = popover.getByRole("button", { name: "Open Codex, focus-project", exact: true });
    await open.click();
    await expect(
      popover.getByRole("status").filter({ hasText: "no window information" }),
    ).toBeVisible();
    await post({
      "x-hearable-focus": Buffer.from(JSON.stringify({ pid: 123, remote: true })).toString(
        "base64url",
      ),
    });
    await open.focus();
    await popover.keyboard.press("Enter");
    await expect(popover.getByRole("status").filter({ hasText: "remote machine" })).toBeVisible();
    await expect(open).toBeEnabled();
    // A synthetic agent runs under this isolated Electron app. The real relay
    // captures its ancestry; native activation must not escape to the test runner's host.
    const probe = join(dir, "focus-probe.mjs");
    await writeFile(
      probe,
      `// Isolated focus probe; must not connect to owner sessions.
import { spawnSync } from "node:child_process";
spawnSync(process.execPath, [process.argv[2], "--agent", "codex", "--url", process.argv[3]], {
  input: JSON.stringify({ session_id: "native-probe", cwd: "/repo/native-probe", hook_event_name: "UserPromptSubmit" }),
  stdio: ["pipe", "ignore", "ignore"]
});
setInterval(() => {}, 1000);
`,
    );
    await shell.evaluate(
      async (_electron, { probe, relay, origin }) => {
        const { spawn } = process.getBuiltinModule("node:child_process");
        const child = spawn(process.execPath, [probe, relay, origin], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SSH_CONNECTION: "", SSH_TTY: "" },
          stdio: "ignore",
        });
        Object.assign(globalThis, { focusProbe: child });
      },
      { probe, relay: resolve("packages/adapter-kit/src/relay/hearable-hook.mjs"), origin },
    );
    try {
      const nativeOpen = popover.getByRole("button", {
        name: "Open Codex, native-probe",
        exact: true,
      });
      await expect(nativeOpen).toBeVisible();
      const response = await fetch(`${origin}/session-focus?agent=codex&sessionId=native-probe`);
      const target = (await response.json()) as { processes: { pid: number }[] };
      expect(target.processes.length).toBeGreaterThan(0);
      await nativeOpen.click();
      await expect(
        popover.getByRole("status").filter({ hasText: "Opened Electron." }),
      ).toBeVisible();
    } finally {
      await shell.evaluate(() =>
        (globalThis as unknown as { focusProbe: { kill(): void } }).focusProbe.kill(),
      );
    }
    // Validation and lookup never accept a URL, app name, or shell command from a page.
    expect(
      await popover.evaluate(async () => {
        try {
          await (
            window as unknown as {
              hearableShell: { openAgent(agent: string, sessionId: string): Promise<unknown> };
            }
          ).hearableShell.openAgent("", "invalid");
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
  } finally {
    await shell.close();
    await rm(dir, { recursive: true, force: true });
  }
});
