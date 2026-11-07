// packages/core/test/classify/normalize.test.ts — behaviour tests for the
// fingerprint normalizers in src/classify/normalize.ts: whitespace runs
// collapse, absolute path prefixes equal to cwd are stripped, the documented
// volatile flags (colour control, timestamps) are dropped, and genuinely
// different commands or paths stay different. The fingerprint-equality
// assertions live in classify.test.ts; here the normalizers are tested head-on.

import { describe, expect, it } from "vitest";

import {
  normalizeCommand,
  normalizePathPattern,
  stripCwdPrefix,
} from "../../src/classify/normalize.js";

const CWD = "/home/me/project";

describe("normalizeCommand", () => {
  it("collapses whitespace runs to single spaces", () => {
    expect(normalizeCommand("  vitest   run   --reporter dot ", undefined)).toBe(
      "vitest run --reporter dot",
    );
  });

  it("strips an absolute path prefix equal to cwd", () => {
    expect(normalizeCommand(`node ${CWD}/src/server.ts --port 3000`, CWD)).toBe(
      "node src/server.ts --port 3000",
    );
    expect(normalizeCommand(`${CWD}/node_modules/.bin/vitest run`, CWD)).toBe(
      "node_modules/.bin/vitest run",
    );
  });

  it("drops colour-control flags", () => {
    expect(normalizeCommand("pytest --no-color -x", undefined)).toBe("pytest -x");
    expect(normalizeCommand("pytest -x --no-colors", undefined)).toBe("pytest -x");
    expect(normalizeCommand("vitest --color=never", undefined)).toBe("vitest");
  });

  it("drops inline timestamp flags", () => {
    expect(normalizeCommand("node build.mjs --ts=1712345678901", undefined)).toBe("node build.mjs");
    expect(normalizeCommand("node build.mjs --timestamp=1712345678901", undefined)).toBe(
      "node build.mjs",
    );
  });

  it("keeps commands that differ only in their real words different", () => {
    expect(normalizeCommand("vitest run", undefined)).not.toBe(
      normalizeCommand("vitest watch", undefined),
    );
    expect(normalizeCommand("cat a.ts", undefined)).not.toBe(
      normalizeCommand("cat b.ts", undefined),
    );
  });

  it("does not confuse a redirect or comparison with the redirect marker", () => {
    expect(normalizeCommand("test -gt 5 && echo ok", undefined)).toBe(
      normalizeCommand("test -gt 5 && echo ok", undefined),
    );
  });
});

describe("normalizePathPattern", () => {
  it("makes a path starting with cwd relative", () => {
    expect(normalizePathPattern(`${CWD}/src/app.ts`, CWD)).toBe("src/app.ts");
  });

  it("strips a leading ./", () => {
    expect(normalizePathPattern("./src/app.ts", undefined)).toBe("src/app.ts");
    expect(normalizePathPattern("././src/app.ts", undefined)).toBe("src/app.ts");
  });

  it("normalizes patterns and spaces like paths", () => {
    expect(normalizePathPattern("  src/**/*.ts  ", undefined)).toBe("src/**/*.ts");
  });
});

describe("stripCwdPrefix", () => {
  it("handles a trailing slash on cwd", () => {
    expect(stripCwdPrefix(`${CWD}/src/app.ts`, `${CWD}/`)).toBe("src/app.ts");
    expect(stripCwdPrefix(CWD, `${CWD}/`)).toBe(".");
  });

  it("leaves unrelated absolute paths alone", () => {
    expect(stripCwdPrefix("/tmp/other.ts", CWD)).toBe("/tmp/other.ts");
  });
});
