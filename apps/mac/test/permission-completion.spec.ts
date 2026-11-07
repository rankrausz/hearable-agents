// Reproduces the stale permission label through real hook mapping; must not invent a reply event.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("a normal Codex Stop clears the prior permission label and waiting tray", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearable-permission-stop-"));
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
    async function post(hook_event_name: string) {
      await fetch(`${origin}/events`, {
        method: "POST",
        headers: { "x-hearable-agent": "codex", "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name,
          session_id: "permission-completion",
          turn_id: "normal-turn",
          last_assistant_message: "The one-minute check is complete.",
        }),
      });
    }
    await post("UserPromptSubmit");
    await post("PermissionRequest");
    await expect(popover.getByText("Waiting for you: permission", { exact: true })).toBeVisible();
    await post("Stop");
    await expect(popover.getByText("Done", { exact: true })).toBeVisible();
    await expect(popover.getByText("Waiting for you: permission", { exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        shell.evaluate(
          ({ nativeImage }, path) =>
            (globalThis as unknown as { lastTrayImage: string }).lastTrayImage ===
            nativeImage.createFromPath(path).toDataURL(),
          resolve("apps/mac/assets/trayTemplate.png"),
        ),
      )
      .toBe(true);
  } finally {
    await shell.close();
    await rm(dir, { recursive: true, force: true });
  }
});
