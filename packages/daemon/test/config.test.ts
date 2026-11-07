// packages/daemon/test/config.test.ts — config loading and validation: file,
// flags and defaults merge in the right precedence, the data directory is
// created, and broken files/configs surface as plain-language ConfigError.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANE_CAP } from "@hearable/core";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hearable-config-"));
}

describe("loadConfig", () => {
  it("applies defaults when neither file nor overrides exist", () => {
    const dir = tempDir();
    const config = loadConfig({
      configFile: join(dir, "nope.json"),
      overrides: { dataDir: join(dir, "data") },
    });
    expect(config.port).toBe(4876);
    expect(config.host).toBe("127.0.0.1");
    // The default follows the scene's one declared lane cap (p7b-t03).
    expect(config.lanes).toBe(LANE_CAP);
    expect(config.lanes).toBe(4);
    expect(config.laneReleaseAfterMs).toBe(300_000);
    expect(existsSync(config.dataDir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets overrides win over file values", () => {
    const dir = tempDir();
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ port: 5000, lanes: 2 }));
    const config = loadConfig({
      configFile: file,
      overrides: { port: 6000, dataDir: join(dir, "data") },
    });
    expect(config.port).toBe(6000);
    expect(config.lanes).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects more lanes than the scene has seats", () => {
    // A lane past the cap would show in the console but never sound.
    const dir = tempDir();
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ lanes: LANE_CAP + 1 }));
    expect(() =>
      loadConfig({ configFile: file, overrides: { dataDir: join(dir, "data") } }),
    ).toThrow(ConfigError);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects unknown keys in the config file", () => {
    const dir = tempDir();
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ port: 5000, mystery: true }));
    expect(() =>
      loadConfig({ configFile: file, overrides: { dataDir: join(dir, "data") } }),
    ).toThrow(ConfigError);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a config file that is not valid JSON", () => {
    const dir = tempDir();
    const file = join(dir, "config.json");
    writeFileSync(file, "{ not json ");
    expect(() =>
      loadConfig({ configFile: file, overrides: { dataDir: join(dir, "data") } }),
    ).toThrow(ConfigError);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an empty config file gracefully as defaults", () => {
    const dir = tempDir();
    const file = join(dir, "config.json");
    writeFileSync(file, "");
    const config = loadConfig({
      configFile: file,
      overrides: { dataDir: join(dir, "data"), port: 7000 },
    });
    expect(config.port).toBe(7000);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a config file that is valid JSON but not a single object", () => {
    const dir = tempDir();
    for (const body of ["null", "[]", '"just a string"', "42"]) {
      const file = join(dir, "config.json");
      writeFileSync(file, body);
      expect(() =>
        loadConfig({ configFile: file, overrides: { dataDir: join(dir, "data") } }),
      ).toThrow(ConfigError);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a config file with a non-loopback host", () => {
    const dir = tempDir();
    for (const host of ["0.0.0.0", "192.168.1.5", "example.com"]) {
      const file = join(dir, "config.json");
      writeFileSync(file, JSON.stringify({ host }));
      expect(() =>
        loadConfig({ configFile: file, overrides: { dataDir: join(dir, "data") } }),
      ).toThrow(ConfigError);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts every loopback host", () => {
    const dir = tempDir();
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const file = join(dir, "config.json");
      writeFileSync(file, JSON.stringify({ host }));
      const config = loadConfig({ configFile: file, overrides: { dataDir: join(dir, "data") } });
      expect(config.host).toBe(host);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
