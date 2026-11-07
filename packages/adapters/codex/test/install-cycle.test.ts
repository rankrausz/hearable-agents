// packages/adapters/codex/test/install-cycle.test.ts — throwaway proof
// of the task's install/uninstall verification: install, install again,
// uninstall, byte-compared. This duplicates the conformance installer
// cases against a pristine config with user content, so the task summary
// can point at one named test for the byte-compare demonstration.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installCodex, uninstallCodex } from "../src/install.js";

let configDir = "";
const DAEMON_URL = "http://127.0.0.1:3939";
const PRISTINE = `{\n  "description": "user content",\n  "hooks": {\n    "Stop": []\n  }\n}\n`;

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), "codex-cycle-"));
});

afterAll(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe("the Codex install/uninstall cycle", () => {
  it("installs, reinstalls cleanly, and uninstalls byte-exact", async () => {
    await writeFile(join(configDir, "hooks.json"), PRISTINE, "utf8");
    const first = await installCodex({ configDir, daemonUrl: DAEMON_URL });
    expect(first.changed).toBe(true);
    const second = await installCodex({ configDir, daemonUrl: DAEMON_URL });
    expect(second.changed).toBe(false);
    await uninstallCodex({ configDir, daemonUrl: DAEMON_URL });
    expect(await readFile(join(configDir, "hooks.json"), "utf8")).toBe(PRISTINE);
  });
});
