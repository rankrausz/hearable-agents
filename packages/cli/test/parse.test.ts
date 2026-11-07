// packages/cli/test/parse.test.ts — the Phase 1 argv parser: the three
// commands exist, `record` flags and `replay` flags parse one-for-one, every
// deferred verb yields its owning-phase message rather than a stub, and
// unknown verbs/options/values become plain-language usage errors with a
// stable exit code.

import { describe, expect, it } from "vitest";
import { DEFERRED_VERBS, parseArgv } from "../src/parse.js";

describe("parseArgv", () => {
  it("parses `start` only when nothing else is passed", () => {
    expect(parseArgv(["start"])).toEqual({ kind: "start" });
    expect(parseArgv(["start", "--extra"])).toEqual({
      kind: "usage-error",
      message: 'Start takes no options, but you passed "--extra".',
    });
  });

  it("parses doctor without options", () => {
    expect(parseArgv(["doctor"])).toEqual({ kind: "doctor" });
    expect(parseArgv(["doctor", "--verbose"]).kind).toBe("usage-error");
  });

  it("parses user-service actions", () => {
    expect(parseArgv(["service", "install"])).toEqual({ kind: "service", action: "install" });
    expect(parseArgv(["service", "uninstall"])).toEqual({ kind: "service", action: "uninstall" });
    expect(parseArgv(["service", "status"])).toEqual({ kind: "service", action: "status" });
    expect(parseArgv(["service"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgv(["service", "start"])).toMatchObject({ kind: "usage-error" });
  });

  it("parses interactive and explicit installs", () => {
    expect(parseArgv(["install"])).toEqual({ kind: "install" });
    expect(parseArgv(["install", "claude-code"])).toEqual({
      kind: "install",
      agent: "claude-code",
    });
    expect(parseArgv(["install", "codex"])).toEqual({ kind: "install", agent: "codex" });
    expect(parseArgv(["install", "other"]).kind).toBe("usage-error");
    expect(parseArgv(["install", "claude-code", "codex"]).kind).toBe("usage-error");
  });

  it("parses record flags including the one-for-one recorder options", () => {
    expect(parseArgv(["record", "--name", "stuck-auth", "--redact=paths", "--raw"])).toEqual({
      kind: "record",
      flags: { name: "stuck-auth", redact: "paths", raw: true, stop: false },
    });
    expect(parseArgv(["record", "--name=demo", "--stop"])).toEqual({
      kind: "record",
      flags: { name: "demo", redact: "default", raw: false, stop: true },
    });
  });

  it("refuses record without a name and passes the plain fix", () => {
    const parsed = parseArgv(["record"]);
    expect(parsed.kind).toBe("usage-error");
    if (parsed.kind === "usage-error") {
      expect(parsed.message).toMatch(/Record needs --name <name>/);
    }
  });

  it("refuses a recording name that could escape the recordings folder", () => {
    const parsed = parseArgv(["record", "--name", "a/../b"]);
    expect(parsed.kind).toBe("usage-error");
  });

  it("refuses --redact in any form other than =paths", () => {
    const parsed = parseArgv(["record", "--name", "x", "--redact"]);
    expect(parsed.kind).toBe("usage-error");
    if (parsed.kind === "usage-error") {
      expect(parsed.message).toMatch(/--redact=paths/);
    }
  });

  it("parses replay files and speed, defaulting speed to 1", () => {
    expect(parseArgv(["replay", "a.jsonl", "b.jsonl", "--speed", "10"])).toEqual({
      kind: "replay",
      files: ["a.jsonl", "b.jsonl"],
      speed: 10,
    });
    expect(parseArgv(["replay", "a.jsonl"])).toEqual({
      kind: "replay",
      files: ["a.jsonl"],
      speed: 1,
    });
    expect(parseArgv(["replay", "--speed=4", "a.jsonl"])).toEqual({
      kind: "replay",
      files: ["a.jsonl"],
      speed: 4,
    });
  });

  it("refuses replay without files and with a non-positive or non-numeric speed", () => {
    const noFiles = parseArgv(["replay"]);
    expect(noFiles.kind).toBe("usage-error");
    for (const bad of ["0", "-1", "abc", ""]) {
      const parsed = parseArgv(["replay", "a.jsonl", "--speed", bad]);
      expect(parsed.kind).toBe("usage-error");
    }
  });

  it("reports unknown verbs and unknown options as usage errors", () => {
    expect(parseArgv(["womp"])).toEqual({
      kind: "usage-error",
      message:
        'Unknown command "womp". This phase runs: hearable start | install | doctor | record | replay.',
    });
    const parsed = parseArgv(["replay", "--turbo", "a.jsonl"]);
    expect(parsed.kind).toBe("usage-error");
    expect(parseArgv(["record", "--turbo", "--name", "x"]).kind).toBe("usage-error");
    expect(parseArgv([]).kind).toBe("usage-error");
  });

  it("routes every deferred verb to its owning phase, never a silent stub", () => {
    expect(Object.keys(DEFERRED_VERBS).sort()).toEqual(["acp", "emit", "uninstall"]);
    for (const verb of Object.keys(DEFERRED_VERBS)) {
      const parsed = parseArgv([verb]);
      expect(parsed.kind).toBe("deferred");
      if (parsed.kind === "deferred") {
        expect(parsed.phase).toMatch(/^1b$|^5$/);
        expect(parsed.note.length).toBeGreaterThan(0);
      }
    }
  });
});
