// packages/adapters/claude-code/test/conformance.test.ts — the reference
// adapter's conformance registration. What this is for: wiring the fixture,
// installer, relay-timing, unknown-event, redaction and emissions suites so
// `pnpm --filter @hearable/claude-code test` proves the mapping, the
// idempotent installer, the byte-exact uninstall, the relay budget on this
// agent's own payloads, unknown-event preservation, redaction of the mapped
// events' secrets, and capability honesty. What it must not do: invent a new
// conformance category — exactly the seven docs/ARCHITECTURE.md demands.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerConformance } from "@hearable/adapter-kit/conformance";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/index.js";
import type { ClaudeCodeMapContext } from "../src/last-tool.js";
import { nextLastToolRecords } from "../src/last-tool.js";
import { fixtureCases, redactionCases, relayTimingCases, unknownEventCases } from "./fixtures.js";

const fixtures = fixtureCases();
const unknownEvents = unknownEventCases();

const throwawayRoot = mkdtempSync(join(tmpdir(), "hearable-claude-conformance-"));
const configDir = join(throwawayRoot, "claude");
const pristineSettings = '{\n  "hooks": {}\n}\n';
const settingsPath = join(configDir, "settings.json");

function resetConfig(): Promise<void> {
  rmSync(configDir, { recursive: true, force: true });
  return import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
    await mkdir(configDir, { recursive: true });
    await writeFile(settingsPath, pristineSettings, "utf8");
  });
}

function readConfig(): Promise<string> {
  return Promise.resolve(readFileSync(settingsPath, "utf8"));
}

const installer = {
  opts: {
    configDir,
    daemonUrl: "http://127.0.0.1:4876",
    relayPath: "/opt/hearable/hearable-hook.mjs",
  },
  resetConfig,
  readConfig,
};

const emissions = fixtures.flatMap((fixture) => claudeCodeAdapter.map(fixture.raw, fixture.ctx));

registerConformance(claudeCodeAdapter, {
  fixtures,
  installer,
  relayTiming: { payloads: relayTimingCases() },
  unknownEvents,
  redaction: redactionCases(),
  emissions,
});

describe("claude-code installer edge cases", () => {
  it("keeps pre-existing user hooks around the managed entries", async () => {
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    const dir = mkdtempSync(join(tmpdir(), "hearable-claude-user-"));
    try {
      await mkdir(dir, { recursive: true });
      const userSettings =
        '{\n  "hooks": {\n    "PreToolUse": [\n      {\n        "matcher": "Bash",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "echo hi"\n          }\n        ]\n      }\n    ]\n  }\n}\n';
      await writeFile(join(dir, "settings.json"), userSettings, "utf8");
      const opts = {
        configDir: dir,
        daemonUrl: "http://127.0.0.1:4876",
        relayPath: "/opt/hearable/hearable-hook.mjs",
      };
      await claudeCodeAdapter.install(opts);
      const after = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as {
        hooks: { PreToolUse: unknown[] };
      };
      expect(after.hooks.PreToolUse.length).toBe(2);
      await claudeCodeAdapter.uninstall({ configDir: dir, daemonUrl: opts.daemonUrl });
      expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(
        '{\n  "hooks": {\n    "PreToolUse": [\n      {\n        "matcher": "Bash",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "echo hi"\n          }\n        ]\n      }\n    ]\n  }\n}\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing new when the file is missing on uninstall", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearable-claude-missing-"));
    try {
      rmSync(dir, { recursive: true, force: true });
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      await expect(
        claudeCodeAdapter.uninstall({ configDir: dir, daemonUrl: "http://127.0.0.1:4876" }),
      ).resolves.toBeUndefined();
      await expect(
        import("node:fs/promises").then(({ readFile }) =>
          readFile(join(dir, "settings.json"), "utf8"),
        ),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the original bytes after a changed reinstall", async () => {
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    const dir = mkdtempSync(join(tmpdir(), "hearable-claude-reinstall-"));
    try {
      await mkdir(dir, { recursive: true });
      const pristine = '{\n  "hooks": {},\n  "model": "sonnet"\n}\n';
      await writeFile(join(dir, "settings.json"), pristine, "utf8");
      const installOpts = {
        configDir: dir,
        daemonUrl: "http://127.0.0.1:4876",
        relayPath: "/opt/hearable/hearable-hook.mjs",
      } as const;
      await claudeCodeAdapter.install({ ...installOpts });
      await claudeCodeAdapter.install({ ...installOpts, daemonUrl: "http://127.0.0.1:9999" });
      await claudeCodeAdapter.uninstall({ configDir: dir, daemonUrl: "http://127.0.0.1:9999" });
      expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(pristine);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves malformed and non-array hook values alone except for managed events", async () => {
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    const dir = mkdtempSync(join(tmpdir(), "hearable-claude-odd-"));
    try {
      await mkdir(dir, { recursive: true });
      // PreToolUse is a managed event: a non-array value there cannot hold
      // hook entries, so install replaces it with the managed entry.
      // Custom (unmanaged) values pass through untouched.
      const odd = '{\n  "hooks": {\n    "PreToolUse": "not-an-array",\n    "Custom": 42\n  }\n}\n';
      await writeFile(join(dir, "settings.json"), odd, "utf8");
      const opts = {
        configDir: dir,
        daemonUrl: "http://127.0.0.1:4876",
        relayPath: "/opt/hearable/hearable-hook.mjs",
      };
      const first = await claudeCodeAdapter.install(opts);
      expect(first.changed).toBe(true);
      const parsed = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as {
        hooks: Record<string, unknown>;
      };
      expect(Array.isArray(parsed.hooks.PreToolUse)).toBe(true);
      expect(parsed.hooks.Custom).toBe(42);
      await claudeCodeAdapter.uninstall({ configDir: dir, daemonUrl: opts.daemonUrl });
      expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(odd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the created settings file when no file pre-existed", async () => {
    const { mkdir, readFile, access } = await import("node:fs/promises");
    const dir = mkdtempSync(join(tmpdir(), "hearable-claude-absent-"));
    try {
      await mkdir(dir, { recursive: true });
      const settingsFile = join(dir, "settings.json");
      const opts = {
        configDir: dir,
        daemonUrl: "http://127.0.0.1:4876",
        relayPath: "/opt/hearable/hearable-hook.mjs",
      };
      const first = await claudeCodeAdapter.install(opts);
      expect(first.changed).toBe(true);
      await expect(readFile(settingsFile, "utf8")).resolves.toContain("hearable:claude-code");
      await claudeCodeAdapter.uninstall({ configDir: dir, daemonUrl: opts.daemonUrl });
      await expect(access(settingsFile)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still removes the created file after a changed reinstall", async () => {
    const { mkdir, access } = await import("node:fs/promises");
    const dir = mkdtempSync(join(tmpdir(), "hearable-claude-absent-reinstall-"));
    try {
      await mkdir(dir, { recursive: true });
      const opts = {
        configDir: dir,
        daemonUrl: "http://127.0.0.1:4876",
        relayPath: "/opt/hearable/hearable-hook.mjs",
      };
      await claudeCodeAdapter.install(opts);
      // A changed reinstall must not lose the absent-baseline marker.
      await claudeCodeAdapter.install({ ...opts, daemonUrl: "http://127.0.0.1:9999" });
      await claudeCodeAdapter.uninstall({ configDir: dir, daemonUrl: "http://127.0.0.1:9999" });
      await expect(access(join(dir, "settings.json"))).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claude-code mapping edge cases", () => {
  it("maps nothing without a session id", () => {
    expect(
      claudeCodeAdapter.map(
        { hook_event_name: "SessionStart", cwd: "/repo" },
        { receivedAt: 1, cwd: "/repo", pendingToolStarts: [] },
      ),
    ).toEqual([]);
  });

  it("preserves an unknown hook event as a notification", () => {
    const events = claudeCodeAdapter.map(
      { session_id: "s1", hook_event_name: "FutureEvent", cwd: "/repo" },
      { receivedAt: 1, cwd: "/repo", pendingToolStarts: [] },
    );
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("notification");
    expect(events[0]?.meta).toMatchObject({ kind: "unknown", hookEvent: "FutureEvent" });
  });

  it("prefers the payload duration_ms over pending-start arithmetic", () => {
    const events = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "PostToolUse",
        cwd: "/repo",
        tool_name: "Read",
        tool_input: { file_path: "/repo/a.ts" },
        tool_use_id: "t1",
        tool_response: { filePath: "/repo/a.ts", success: true },
        duration_ms: 12,
      },
      {
        receivedAt: 1000,
        cwd: "/repo",
        pendingToolStarts: [{ sessionId: "s1", toolName: "Read", toolUseId: "t1", startedAt: 100 }],
      },
    );
    expect(events[0]?.tool?.durationMs).toBe(12);
  });

  it("computes duration from the pending start when the payload carries none", () => {
    const events = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "PostToolUse",
        cwd: "/repo",
        tool_name: "Read",
        tool_input: { file_path: "/repo/a.ts" },
        tool_use_id: "t1",
        tool_response: { filePath: "/repo/a.ts", success: true },
      },
      {
        receivedAt: 1000,
        cwd: "/repo",
        pendingToolStarts: [{ sessionId: "s1", toolName: "Read", toolUseId: "t1", startedAt: 988 }],
      },
    );
    expect(events[0]?.tool?.durationMs).toBe(12);
  });

  it("reports the adapter id, capabilities and doctor diagnostics", async () => {
    expect(claudeCodeAdapter.id).toBe("claude-code");
    expect(claudeCodeAdapter.capabilities.toolKinds).toBe("byName");
    const diagnostics = await claudeCodeAdapter.doctor();
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.message.length).toBeGreaterThan(0);
    }
  });

  it("yields no duration when an explicit tool-use id matches nothing", () => {
    const events = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "PostToolUse",
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_use_id: "toolu-unknown",
        tool_response: { stdout: "ok", stderr: "", interrupted: false, isImage: false },
      },
      {
        receivedAt: 1000,
        cwd: "/repo",
        pendingToolStarts: [
          { sessionId: "s1", toolName: "Bash", toolUseId: "toolu-a", startedAt: 100 },
          { sessionId: "s1", toolName: "Bash", toolUseId: "toolu-b", startedAt: 200 },
        ],
      },
    );
    expect(events[0]?.kind).toBe("tool.end");
    expect(events[0]?.tool?.durationMs).toBeUndefined();
  });

  it("reports question on Stop after a completed question tool", () => {
    // Full flow: PreToolUse(AskUserQuestion) -> PostToolUse (the daemon
    // forgets the pending start here) -> Stop with a non-question message.
    // The caller-threaded last-tool record is what lets Stop still see it.
    const asked = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        tool_name: "AskUserQuestion",
        tool_input: { questions: [] },
        tool_use_id: "toolu-ask-9",
      },
      { receivedAt: 1000, cwd: "/repo", pendingToolStarts: [] },
    );
    expect(asked.map((event) => event.kind)).toEqual(["question.asked", "tool.start"]);
    const afterAsk = nextLastToolRecords(undefined, asked);
    const endedTool = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "PostToolUse",
        cwd: "/repo",
        tool_name: "AskUserQuestion",
        tool_input: { questions: [] },
        tool_use_id: "toolu-ask-9",
        tool_response: { questions: [], answers: {} },
      },
      { receivedAt: 1500, cwd: "/repo", pendingToolStarts: [] },
    );
    const afterEnd = nextLastToolRecords(afterAsk, endedTool);
    const ended = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "Stop",
        cwd: "/repo",
        last_assistant_message: "Done.",
        stop_hook_active: false,
      },
      {
        receivedAt: 2000,
        cwd: "/repo",
        pendingToolStarts: [],
        lastToolRecords: afterEnd,
      } as ClaudeCodeMapContext,
    );
    expect(ended[0]?.kind).toBe("turn.end");
    expect(ended[0]?.lifecycle).toMatchObject({ reason: "question", confidence: "inferred" });
  });

  it("reports completed on Stop after a completed non-question tool", () => {
    const started = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        tool_name: "Edit",
        tool_input: { file_path: "/repo/a.ts" },
        tool_use_id: "toolu-edit-1",
      },
      { receivedAt: 1000, cwd: "/repo", pendingToolStarts: [] },
    );
    expect(started.map((event) => event.kind)).toEqual(["tool.start"]);
    const afterStart = nextLastToolRecords(undefined, started);
    const finished = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "PostToolUse",
        cwd: "/repo",
        tool_name: "Edit",
        tool_input: { file_path: "/repo/a.ts" },
        tool_use_id: "toolu-edit-1",
        tool_response: { filePath: "/repo/a.ts", success: true },
      },
      { receivedAt: 1500, cwd: "/repo", pendingToolStarts: [] },
    );
    const afterEnd = nextLastToolRecords(afterStart, finished);
    const ended = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "Stop",
        cwd: "/repo",
        last_assistant_message: "Done.",
        stop_hook_active: false,
      },
      {
        receivedAt: 2000,
        cwd: "/repo",
        pendingToolStarts: [],
        lastToolRecords: afterEnd,
      } as ClaudeCodeMapContext,
    );
    expect(ended[0]?.kind).toBe("turn.end");
    expect(ended[0]?.lifecycle).toMatchObject({ reason: "completed", confidence: "observed" });
  });

  it("suppresses a permission_prompt inside the window but not a stale one", () => {
    const fresh = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "Notification",
        cwd: "/repo",
        message: "Claude needs your permission",
        notification_type: "permission_prompt",
      },
      {
        receivedAt: 2000,
        cwd: "/repo",
        pendingToolStarts: [{ sessionId: "s1", toolName: "Bash", startedAt: 1500 }],
      },
    );
    expect(fresh).toEqual([]);
    const stale = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "Notification",
        cwd: "/repo",
        message: "Claude needs your permission",
        notification_type: "permission_prompt",
      },
      {
        receivedAt: 10000,
        cwd: "/repo",
        pendingToolStarts: [{ sessionId: "s1", toolName: "Bash", startedAt: 1000 }],
      },
    );
    expect(stale[0]?.kind).toBe("permission.request");
    const unrelated = claudeCodeAdapter.map(
      {
        session_id: "s1",
        hook_event_name: "Notification",
        cwd: "/repo",
        message: "Claude needs your permission",
        notification_type: "permission_prompt",
      },
      {
        receivedAt: 2000,
        cwd: "/repo",
        pendingToolStarts: [{ sessionId: "other", toolName: "Bash", startedAt: 2000 }],
      },
    );
    expect(unrelated[0]?.kind).toBe("permission.request");
  });

  it("warns when the configured daemon endpoint does not answer", async () => {
    const { doctorClaudeCode } = await import("../src/doctor.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = mkdtempSync(join(tmpdir(), "hearable-claude-doctor-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify({
          hooks: {
            Stop: [
              {
                matcher: "",
                hooks: [
                  {
                    type: "command",
                    command: "/opt/hearable-hook.mjs --agent claude-code --url http://127.0.0.1:1",
                  },
                ],
                _hearable: "hearable:claude-code",
              },
            ],
          },
        }),
        "utf8",
      );
      const diagnostics = await doctorClaudeCode(dir);
      const delivery = diagnostics.find((diagnostic) => diagnostic.message.includes("daemon"));
      expect(delivery).toBeDefined();
      expect(delivery?.severity).not.toBe("ok");
      expect(delivery?.fix?.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
