// Exercises bundled piano readiness and activity playback in Electron; must use isolated sessions and mute output.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { consolePage } from "./windows.js";

test("loads local piano recordings and follows a Codex interruption and resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearable-piano-mac-"));
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
    await expect(page.getByText("Audio ready · no active agents", { exact: true })).toBeVisible();
    const loaded = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => /\/(?:C[3-6]|Fs[3-5])-.*\.wav/.test(name)),
    );
    expect(new Set(loaded).size).toBe(7);
    const origin = new URL(page.url()).origin;
    const credits = await fetch(`${origin}/audio-credits.txt`);
    expect(credits.ok).toBe(true);
    expect(await credits.text()).toContain("Alexander Holm");
    const popover = shell.windows().find((window) => window.url().includes("view=popover"));
    if (!popover) throw new Error("The popover did not load");
    const running = page.getByText("Audio is running", { exact: true });
    const ready = page.getByText("Audio ready · no active agents", { exact: true });
    const working = popover.getByText("Working", { exact: true });
    const quiet = popover.getByText("Quiet", { exact: true });

    async function post(hook_event_name: string, turn_id = "piano-turn") {
      const response = await fetch(`${origin}/events`, {
        method: "POST",
        headers: { "x-hearable-agent": "codex", "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name,
          session_id: "piano-smoke",
          turn_id,
          tool_name: "Bash",
          tool_input: { command: "pwd" },
          tool_use_id: "piano-call",
        }),
      });
      expect(response.status).toBe(204);
    }

    await post("UserPromptSubmit");
    await expect(working).toBeVisible();
    await expect(running).toBeVisible();
    await post("PreToolUse");
    await post("Interrupt");
    await expect(quiet).toBeVisible();
    await expect(ready).toBeVisible();
    await post("PostToolUse");
    await expect(ready).toBeVisible();
    await post("UserPromptSubmit", "next-turn");
    await expect(working).toBeVisible();
    await expect(running).toBeVisible();
  } finally {
    await shell.close();
    await rm(dir, { recursive: true, force: true });
  }
});
