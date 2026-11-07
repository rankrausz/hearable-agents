// packages/cli/test/service.test.ts — platform service definitions and their
// lifecycle commands. What this is for: proving generated service files are
// explicit, log to the daemon data directory, and can be installed idempotently
// through injected platform commands. What it must not do: invoke launchd or
// systemd during unit tests.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { manageService, serviceDefinition, servicePath } from "../src/service.js";

const dirs: string[] = [];
const config = (dataDir: string) => ({
  host: "127.0.0.1" as const,
  port: 4876,
  lanes: 3,
  laneReleaseAfterMs: 300_000,
  dataDir,
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("user service", () => {
  it("generates launchd with daemon-directory logs", () => {
    const definition = serviceDefinition("darwin", config("/tmp/hearable-data"), {
      command: "/usr/bin/node",
      args: ["/tmp/hearable/bin.js"],
    });
    expect(definition).toContain("com.hearable.daemon");
    expect(definition).toContain("/tmp/hearable-data/service.stdout.log");
    expect(definition).toContain("<string>start</string>");
  });

  it("generates systemd user service with restart and append-only logs", () => {
    const definition = serviceDefinition("linux", config("/tmp/hearable-data"), {
      command: "/usr/bin/node",
      args: ["/tmp/hearable/bin.js"],
    });
    expect(definition).toContain("Restart=on-failure");
    expect(definition).toContain("StandardError=append:/tmp/hearable-data/service.stderr.log");
  });

  it("installs and removes the exact generated file without running a real manager", async () => {
    const home = mkdtempSync(join(tmpdir(), "hearable-service-"));
    dirs.push(home);
    const dataDir = join(home, "data");
    const commands: string[] = [];
    const deps = {
      platform: () => "linux" as const,
      homeDir: () => home,
      executable: () => ({ command: "node", args: ["hearable"] }),
      run: async (command: string, args: readonly string[]) => {
        commands.push([command, ...args].join(" "));
      },
      configFile: () => "/tmp/hearable-config.json",
    };
    expect((await manageService("install", config(dataDir), deps)).installed).toBe(true);
    const path = servicePath("linux", home);
    expect(path).not.toBeNull();
    expect(readFileSync(path ?? "", "utf8")).toContain("ExecStart=");
    expect(commands).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now hearable.service",
    ]);
    expect((await manageService("uninstall", config(dataDir), deps)).installed).toBe(false);
    expect(path === null ? false : existsSync(path)).toBe(false);
  });

  it("does not delete the Linux service file when disable fails for a real reason", async () => {
    const home = mkdtempSync(join(tmpdir(), "hearable-service-failure-"));
    dirs.push(home);
    const dataDir = join(home, "data");
    const path = servicePath("linux", home);
    const deps = {
      platform: () => "linux" as const,
      homeDir: () => home,
      executable: () => ({ command: "node", args: ["hearable"] }),
      run: async (command: string, args: readonly string[]) => {
        if (command === "systemctl" && args.includes("disable")) {
          const error = new Error("permission denied") as Error & { stderr: string };
          error.stderr = "Failed to disable unit: Access denied.";
          throw error;
        }
      },
    };
    await manageService("install", config(dataDir), { ...deps, run: async () => {} });
    await expect(manageService("uninstall", config(dataDir), deps)).rejects.toThrow(
      "permission denied",
    );
    expect(path === null ? false : existsSync(path)).toBe(true);
  });

  it("ignores only an absent Linux unit and still surfaces daemon-reload failures", async () => {
    const home = mkdtempSync(join(tmpdir(), "hearable-service-reload-"));
    dirs.push(home);
    const dataDir = join(home, "data");
    const path = servicePath("linux", home);
    const deps = {
      platform: () => "linux" as const,
      homeDir: () => home,
      executable: () => ({ command: "node", args: ["hearable"] }),
      run: async (_command: string, args: readonly string[]) => {
        if (args.includes("disable")) {
          const error = new Error("not loaded") as Error & { stderr: string };
          error.stderr = "Unit hearable.service not loaded.";
          throw error;
        }
        if (args.includes("daemon-reload")) {
          const error = new Error("permission denied") as Error & { stderr: string };
          error.stderr = "Failed to reload: Access denied.";
          throw error;
        }
      },
    };
    await manageService("install", config(dataDir), { ...deps, run: async () => {} });
    await expect(manageService("uninstall", config(dataDir), deps)).rejects.toThrow(
      "permission denied",
    );
    expect(path === null ? false : existsSync(path)).toBe(true);
  });
});
