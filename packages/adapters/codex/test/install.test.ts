// packages/adapters/codex/test/install.test.ts — behaviour tests for the
// Codex hooks.json installer: a first install adds every event, a second
// install reports no change, uninstall restores pre-existing user content
// byte-for-byte, and uninstalling a pristine config leaves it untouched.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_HOOK_EVENTS, installCodex, uninstallCodex } from "../src/install.js";

const DAEMON_URL = "http://127.0.0.1:3939";

let dirs: string[] = [];
async function throwawayDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-install-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe("the Codex installer", () => {
  it("installs every mapped event pointing at the relay", async () => {
    const configDir = await throwawayDir();
    const result = await installCodex({ configDir, daemonUrl: DAEMON_URL });
    expect(result.changed).toBe(true);
    const config = JSON.parse(await readFile(join(configDir, "hooks.json"), "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    for (const event of CODEX_HOOK_EVENTS) {
      expect(config.hooks[event]?.length).toBe(1);
    }
    expect(JSON.stringify(config)).toContain("hearable-hook --agent codex");
    expect(JSON.stringify(config)).toContain(DAEMON_URL);
  });

  it("reports no change on a second install", async () => {
    const configDir = await throwawayDir();
    await installCodex({ configDir, daemonUrl: DAEMON_URL });
    const before = await readFile(join(configDir, "hooks.json"), "utf8");
    const second = await installCodex({ configDir, daemonUrl: DAEMON_URL });
    expect(second.changed).toBe(false);
    expect(await readFile(join(configDir, "hooks.json"), "utf8")).toBe(before);
  });

  it("preserves pre-existing user content through install and uninstall", async () => {
    const configDir = await throwawayDir();
    const pristine = `{\n  "description": "mine",\n  "hooks": {\n    "Stop": [\n      {\n        "matcher": "",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "echo done",\n            "timeout": 5\n          }\n        ]\n      }\n    ]\n  }\n}\n`;
    await writeFile(join(configDir, "hooks.json"), pristine, "utf8");
    await installCodex({ configDir, daemonUrl: DAEMON_URL });
    const installed = JSON.parse(await readFile(join(configDir, "hooks.json"), "utf8")) as {
      hooks: { Stop: unknown[] };
    };
    expect(installed.hooks.Stop.length).toBe(2);
    await uninstallCodex({ configDir, daemonUrl: DAEMON_URL });
    expect(await readFile(join(configDir, "hooks.json"), "utf8")).toBe(pristine);
  });

  it("restores compact pre-existing formatting byte-for-byte", async () => {
    const configDir = await throwawayDir();
    const pristine = `{"hooks":{"Stop":[]},"description":"mine"}   `;
    await writeFile(join(configDir, "hooks.json"), pristine, "utf8");
    await installCodex({ configDir, daemonUrl: DAEMON_URL });
    expect(await readFile(join(configDir, "hooks.json"), "utf8")).not.toBe(pristine);
    await uninstallCodex({ configDir, daemonUrl: DAEMON_URL });
    expect(await readFile(join(configDir, "hooks.json"), "utf8")).toBe(pristine);
  });

  it("removes everything install added when the file did not exist", async () => {
    const configDir = await throwawayDir();
    await installCodex({ configDir, daemonUrl: DAEMON_URL });
    await uninstallCodex({ configDir, daemonUrl: DAEMON_URL });
    await expect(readFile(join(configDir, "hooks.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("leaves a pristine config untouched on uninstall", async () => {
    const configDir = await throwawayDir();
    const pristine = `{\n  "hooks": {\n    "Stop": []\n  }\n}\n`;
    await writeFile(join(configDir, "hooks.json"), pristine, "utf8");
    await uninstallCodex({ configDir, daemonUrl: DAEMON_URL });
    expect(await readFile(join(configDir, "hooks.json"), "utf8")).toBe(pristine);
  });
});
