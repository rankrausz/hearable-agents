// packages/core/test/classify/acp.test.ts — the ACP typed-kind path of the
// classifier. docs/EVENTS.md §Classification maps ACP's typed kind to the
// category and skips name classification entirely: read->read, search->search,
// edit|delete|move->edit, execute->exec (execKind from the command when one is
// present), fetch->web, think|other->other. The boundary schema rejects kinds
// ACP defines but the doc does not map (switch_mode) rather than guessing.

import { describe, expect, it } from "vitest";

import { classify } from "../../src/classify/classify.js";
import { ACPKindSchema } from "../../src/classify/schema.js";

describe("ACP typed kinds", () => {
  it("maps the documented kinds to categories", () => {
    for (const [kind, category] of [
      ["read", "read"],
      ["search", "search"],
      ["edit", "edit"],
    ] as const) {
      expect(classify({ agent: "acp", toolName: "", kind }).category, kind).toBe(category);
    }
    for (const kind of ["delete", "move"] as const) {
      expect(classify({ agent: "acp", toolName: "", kind }).category, kind).toBe("edit");
    }
    expect(classify({ agent: "acp", toolName: "", kind: "fetch" }).category).toBe("web");
    expect(classify({ agent: "acp", toolName: "", kind: "think" }).category).toBe("other");
    expect(classify({ agent: "acp", toolName: "", kind: "other" }).category).toBe("other");
  });

  it("resolves execute to exec with execKind from the command", () => {
    const result = classify({
      agent: "acp",
      toolName: "",
      kind: "execute",
      toolInput: { command: "pytest tests/unit --no-color" },
      cwd: "/repo",
    });
    expect(result.category).toBe("exec");
    expect(result.execKind).toBe("test");
    expect(result.target).toBe("pytest");
  });

  it("fingerprints execute by the normalized command", () => {
    const plain = classify({
      agent: "acp",
      toolName: "",
      kind: "execute",
      toolInput: { command: "pytest tests/unit" },
    });
    const noisy = classify({
      agent: "acp",
      toolName: "",
      kind: "execute",
      toolInput: { command: "pytest  tests/unit   --no-color" },
    });
    expect(noisy.fingerprint).toBe(plain.fingerprint);
    expect(plain.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("resolves execute without a command to exec with execKind other", () => {
    const result = classify({ agent: "acp", toolName: "", kind: "execute", title: "run thing" });
    expect(result.category).toBe("exec");
    expect(result.execKind).toBe("other");
  });

  it("uses ACP locations for a read/edit path fingerprint", () => {
    const withLocation = classify({
      agent: "acp",
      toolName: "",
      kind: "edit",
      toolInput: { locations: [{ path: "/repo/src/app.ts" }] },
      cwd: "/repo",
    });
    const withPath = classify({
      agent: "acp",
      toolName: "",
      kind: "edit",
      toolInput: { path: "/repo/src/app.ts" },
      cwd: "/repo",
    });
    expect(withLocation).toEqual(withPath);
    expect(withLocation.target).toBe("src/app.ts");
  });

  it("bypasses name classification: the kind wins over any tool name", () => {
    // `Read` would classify read by name; the typed kind forces edit.
    const result = classify({
      agent: "acp",
      toolName: "Read",
      kind: "edit",
      toolInput: { path: "x.ts" },
    });
    expect(result.category).toBe("edit");
  });

  it("rejects an ACP kind the docs do not map", () => {
    expect(ACPKindSchema.safeParse("switch_mode").success).toBe(false);
  });
});
