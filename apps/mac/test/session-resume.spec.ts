// Checks reopened chats through real Codex mapping and portraits; never touches owner sessions.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("opening a quiet Codex chat does not show work until a new prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearable-session-resume-"));
  const config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({ port: 0, dataDir: dir }));
  const executable = process.env.HEARABLE_MAC_EXECUTABLE;
  const shell = await electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [...(executable ? [] : [resolve("apps/mac")]), "--mute-audio"],
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
    await shell.evaluate(() =>
      (globalThis as unknown as { hearableTray: Electron.Tray }).hearableTray.emit("click"),
    );
    await expect(popover.getByText("Connected", { exact: true })).toBeVisible();
    const origin = new URL(popover.url()).origin;
    async function post(hook_event_name: string, extra: Record<string, unknown> = {}) {
      const response = await fetch(`${origin}/events`, {
        method: "POST",
        headers: { "x-hearable-agent": "codex", "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name,
          session_id: "reopened-chat",
          cwd: "/test/reopened-chat",
          ...extra,
        }),
      });
      expect(response.status).toBe(204);
    }
    const portrait = popover.getByRole("article").filter({ hasText: "reopened-chat" });
    await post("SessionStart", { source: "startup" });
    await expect(portrait).toHaveAttribute("data-active", "false");
    await post("UserPromptSubmit", { turn_id: "original-turn" });
    await expect(portrait).toHaveAttribute("data-active", "true");
    await post("PostCompact", { trigger: "auto" });
    await expect(portrait).toHaveAttribute("data-active", "false");
    await expect(portrait.getByText("Quiet", { exact: true })).toBeVisible();
    await portrait.hover();
    await portrait.getByRole("button", { name: "Hide reopened-chat", exact: true }).click();
    await expect(portrait).toHaveCount(0);
    await post("SessionStart", { source: "resume" });
    // A subsequent session proves the resume passed through the feed before asserting absence.
    await post("SessionStart", {
      source: "resume",
      session_id: "resume-sentinel",
      cwd: "/test/resume-sentinel",
    });
    await expect(popover.getByRole("article").filter({ hasText: "resume-sentinel" })).toBeVisible();
    await expect(popover.getByRole("article")).toHaveCount(1);
    await expect(portrait).toHaveCount(0);
    await post("UserPromptSubmit", { turn_id: "new-turn" });
    await expect(portrait).toHaveAttribute("data-active", "true");
    await expect(portrait.getByText("Working", { exact: true })).toBeVisible();
    await post("Stop", { turn_id: "new-turn", last_assistant_message: "Complete." });
    await expect(portrait.getByText("Done", { exact: true })).toBeVisible();
    await post("SessionStart", { source: "resume", cwd: "/test/reopened-done" });
    await expect(portrait).toHaveCount(0);
    const done = popover.getByRole("article").filter({ hasText: "reopened-done" });
    await expect(done.getByText("Done", { exact: true })).toBeVisible();
    await expect(done).toHaveAttribute("data-active", "false");
  } finally {
    await shell.close();
    await rm(dir, { recursive: true, force: true });
  }
});
