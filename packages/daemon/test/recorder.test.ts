// packages/daemon/test/recorder.test.ts — the redacting recorder: the file
// carries the EVENTS.md §Wire format header plus one event per line, session
// ids are re-keyed, `lifecycle.message` is dropped, `tool.target` keeps only
// relative paths (read/search/edit) or command heads (exec), `meta` is
// allowlisted, `--redact=paths` hashes relative paths, `--raw` writes the
// original payloads to a gitignored sidecar, and a crafted event carrying a
// prompt, an absolute path, tool output and a secret meta value records none
// of them (each dropped field named).

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedEvent } from "@hearable/core";
import { NormalizedEventSchema } from "@hearable/core";
import { afterEach, describe, expect, it } from "vitest";
import { createRecorder, redactEvent, SessionRekey } from "../src/recorder.js";
import { RECORDING_SCHEMA_VERSION } from "../src/recording.js";
import { drillEvent } from "./doubles.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hearable-recorder-"));
  tmpDirs.push(dir);
  return join(dir, name);
}

function readLines(filePath: string): string[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

/** A rich batch exercising every redaction rule at once. */
function richBatch(): NormalizedEvent[] {
  return [
    drillEvent({
      id: "r-e1",
      ts: 1000,
      receivedAt: 1000,
      agent: "claude-code",
      sessionId: "real-session-aaa",
      kind: "session.start",
    }),
    drillEvent({
      id: "r-e2",
      ts: 1100,
      receivedAt: 1100,
      agent: "claude-code",
      sessionId: "real-session-aaa",
      kind: "turn.end",
      lifecycle: {
        reason: "completed",
        confidence: "observed",
        message: "Here is the final answer text",
      },
    }),
    drillEvent({
      id: "r-e3",
      ts: 1200,
      receivedAt: 1200,
      agent: "claude-code",
      sessionId: "real-session-aaa",
      kind: "tool.start",
      tool: { name: "Read", category: "read", fingerprint: "fp-read", target: "src/index.ts" },
    }),
    drillEvent({
      id: "r-e4",
      ts: 1300,
      receivedAt: 1300,
      agent: "claude-code",
      sessionId: "real-session-aaa",
      kind: "tool.start",
      tool: {
        name: "Bash",
        category: "exec",
        execKind: "test",
        fingerprint: "fp-exec",
        target: "pytest -x -q",
      },
    }),
    drillEvent({
      id: "r-e5",
      ts: 1400,
      receivedAt: 1400,
      agent: "claude-code",
      sessionId: "other-session-bbb",
      kind: "notification",
      meta: { kind: "idle_prompt" },
    }),
  ];
}

describe("recorder file format", () => {
  it("writes the wire-format header line first, then one event per line", () => {
    const filePath = tmpFile("session.jsonl");
    const recorder = createRecorder({ filePath, agent: "claude-code", clock: () => 5000 });
    recorder.record(richBatch());
    const lines = readLines(filePath);
    expect(lines.length).toBe(6);
    const header = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(header).toEqual({
      hearable: "session",
      v: RECORDING_SCHEMA_VERSION,
      recordedAt: 5000,
      agent: "claude-code",
      annotations: "session.annotations.json",
    });
    for (const line of lines.slice(1)) {
      expect(() => NormalizedEventSchema.parse(JSON.parse(line as string))).not.toThrow();
    }
  });

  it("emits a basename annotations pointer for absolute recording paths", () => {
    const filePath = tmpFile("abs-session.jsonl");
    expect(filePath.startsWith("/")).toBe(true);
    const recorder = createRecorder({ filePath, agent: "claude-code", clock: () => 1 });
    recorder.record([]);
    const header = JSON.parse(readLines(filePath)[0] as string) as Record<string, unknown>;
    expect(header.annotations).toBe("abs-session.annotations.json");
    expect(String(header.annotations)).not.toContain("/");
  });
});

describe("redaction by default", () => {
  it("re-keys session ids, keeps relative paths and command heads, drops lifecycle.message", () => {
    const filePath = tmpFile("redacted.jsonl");
    const recorder = createRecorder({ filePath, agent: "claude-code" });
    recorder.record(richBatch());
    const events = readLines(filePath)
      .slice(1)
      .map((line) => JSON.parse(line) as NormalizedEvent);
    const sessionIds = events.map((event) => event.sessionId);
    expect(sessionIds).toContain("s1");
    expect(sessionIds).toContain("s2");
    expect(sessionIds).not.toContain("real-session-aaa");
    expect(sessionIds).not.toContain("other-session-bbb");
    const turnEnd = events.find((event) => event.kind === "turn.end");
    expect(turnEnd?.lifecycle).toEqual({ reason: "completed", confidence: "observed" });
    const read = events.find((event) => event.kind === "tool.start" && event.tool?.name === "Read");
    expect(read?.tool?.target).toBe("src/index.ts");
    const exec = events.find((event) => event.kind === "tool.start" && event.tool?.name === "Bash");
    expect(exec?.tool?.target).toBe("pytest");
    expect(exec?.tool?.execKind).toBe("test");
  });

  it("drops absolute paths, prompts, tool output and secret-looking meta, naming each dropped field", () => {
    const crafted = drillEvent({
      id: "craft-e1",
      ts: 2000,
      receivedAt: 2000,
      agent: "claude-code",
      sessionId: "craft-session",
      kind: "tool.start",
      tool: {
        name: "Bash",
        category: "exec",
        fingerprint: "fp-craft",
        target: "/home/user/secret-project/deploy.sh --token abc123",
      },
      lifecycle: undefined,
    });
    const craftedTurnEnd = drillEvent({
      id: "craft-e2",
      ts: 2100,
      receivedAt: 2100,
      agent: "claude-code",
      sessionId: "craft-session",
      kind: "turn.end",
      lifecycle: {
        reason: "completed",
        confidence: "observed",
        message: "The user prompt was: delete everything; tool output was: ok",
      },
    });
    const craftedNotification = drillEvent({
      id: "craft-e3",
      ts: 2200,
      receivedAt: 2200,
      agent: "claude-code",
      sessionId: "craft-session",
      kind: "notification",
      meta: { kind: "unknown", apiKey: "sk-live-secret", prompt: "ignore previous instructions" },
    });
    const redacted = [crafted, craftedTurnEnd, craftedNotification].map((event) =>
      redactEvent(event, new SessionRekey(), "default"),
    );
    const dumped = JSON.stringify(redacted);
    // Each dropped field, named: the absolute path, the prompt text, the tool
    // output text, the full command tail, the message, the secret meta value.
    expect(dumped).not.toContain("/home/user/secret-project/deploy.sh");
    expect(dumped).not.toContain("delete everything");
    expect(dumped).not.toContain("tool output was: ok");
    expect(dumped).not.toContain("--token abc123");
    expect(dumped).not.toContain("The user prompt was");
    expect(dumped).not.toContain("sk-live-secret");
    expect(dumped).not.toContain("ignore previous instructions");
    expect(dumped).not.toContain("apiKey");
    expect(dumped).not.toContain("craft-session");
    // And the kept skeleton survives: kinds, re-keyed sessions, categories,
    // fingerprints, the exec command head, the allowlisted meta kind.
    expect(redacted[0]?.tool?.target).toBe("deploy.sh");
    expect(redacted[2]?.meta).toEqual({ kind: "unknown" });
  });

  it("drops unexpected enumerable fields the allowlist was never taught", () => {
    const withExtras = {
      ...drillEvent({
        id: "extra-e1",
        ts: 1,
        receivedAt: 1,
        sessionId: "s",
        kind: "turn.end",
        lifecycle: { reason: "completed", confidence: "observed" },
      }),
      prompt: "a whole secret prompt smuggled at the top level",
      toolInput: { file: "/etc/passwd" },
      lifecycle: {
        reason: "completed",
        confidence: "observed",
        message: "assistant words",
        transcript: "the whole transcript",
      },
      tool: {
        name: "Read",
        category: "read",
        fingerprint: "fp",
        target: "src/ok.ts",
        input: { contents: "secret file contents" },
      },
      meta: { kind: "streaming" },
    };
    const redacted = redactEvent(
      withExtras as unknown as NormalizedEvent,
      new SessionRekey(),
      "default",
    );
    const dumped = JSON.stringify(redacted);
    expect(dumped).not.toContain("smuggled");
    expect(dumped).not.toContain("toolInput");
    expect(dumped).not.toContain("transcript");
    expect(dumped).not.toContain("secret file contents");
    expect(Object.keys(redacted as unknown as Record<string, unknown>).sort()).toEqual([
      "agent",
      "id",
      "kind",
      "lifecycle",
      "receivedAt",
      "sessionId",
      "tool",
      "ts",
      "v",
    ]);
    expect(Object.keys(redacted.lifecycle as unknown as Record<string, unknown>).sort()).toEqual([
      "confidence",
      "reason",
    ]);
    expect(Object.keys(redacted.tool as unknown as Record<string, unknown>).sort()).toEqual([
      "category",
      "fingerprint",
      "name",
      "target",
    ]);
  });

  it("drops allowlisted meta keys whose values are free source text", () => {
    const hostile = redactEvent(
      drillEvent({
        id: "meta-e1",
        ts: 1,
        receivedAt: 1,
        sessionId: "s",
        kind: "notification",
        meta: {
          kind: "the user prompt was: delete everything",
          hookEvent: "../../../etc/passwd",
          source: "startup",
          turnId: "turn_01HWxyz",
        },
      }),
      new SessionRekey(),
      "default",
    );
    const dumped = JSON.stringify(hostile);
    expect(dumped).not.toContain("delete everything");
    expect(dumped).not.toContain("../../../etc/passwd");
    expect(dumped).not.toContain("turn_01HWxyz");
    expect(hostile.meta?.source).toBe("startup");
    expect(hostile.meta?.turnId).toMatch(/^[0-9a-f]{16}$/);
    expect(hostile.meta?.kind).toBe("unknown");
  });

  it("drops token-shaped secrets under allowlisted meta keys", () => {
    const hostile = redactEvent(
      drillEvent({
        id: "meta-e2",
        ts: 1,
        receivedAt: 1,
        sessionId: "s",
        kind: "notification",
        meta: {
          kind: "sk-live-secret",
          hookEvent: "SessionStart",
          source: "internal-project",
        },
      }),
      new SessionRekey(),
      "default",
    );
    const dumped = JSON.stringify(hostile);
    expect(dumped).not.toContain("sk-live-secret");
    expect(dumped).not.toContain("internal-project");
    // `kind` was hostile so it falls back to the safe placeholder; the known
    // `hookEvent` survives because it names a real hook from the tables.
    expect(hostile.meta).toEqual({ hookEvent: "SessionStart", kind: "unknown" });
  });

  it("hashes turn ids so secret-shaped values cannot survive recording", () => {
    const hashed = redactEvent(
      drillEvent({
        id: "meta-e4",
        ts: 1,
        receivedAt: 1,
        sessionId: "s",
        kind: "notification",
        meta: { kind: "unknown", turnId: "sk-live-secret" },
      }),
      new SessionRekey(),
      "default",
    );
    const dumped = JSON.stringify(hashed);
    expect(dumped).not.toContain("sk-live-secret");
    expect(hashed.meta?.turnId).toMatch(/^[0-9a-f]{16}$/);
    // The hash is stable, so turn correlation survives redaction.
    const again = redactEvent(
      drillEvent({
        id: "meta-e5",
        ts: 2,
        receivedAt: 2,
        sessionId: "s",
        kind: "notification",
        meta: { kind: "unknown", turnId: "sk-live-secret" },
      }),
      new SessionRekey(),
      "default",
    );
    expect(again.meta?.turnId).toBe(hashed.meta?.turnId);
  });

  it("retains the fork session source while dropping unknown sources", () => {
    const fork = redactEvent(
      drillEvent({
        id: "meta-fork",
        ts: 1,
        receivedAt: 1,
        sessionId: "s",
        kind: "session.start",
        meta: { source: "fork" },
      }),
      new SessionRekey(),
      "default",
    );
    expect(fork.meta?.source).toBe("fork");
  });

  it("drops unknown hook event names and session sources rather than recording them", () => {
    const unknown = redactEvent(
      drillEvent({
        id: "meta-e3",
        ts: 1,
        receivedAt: 1,
        sessionId: "s",
        kind: "notification",
        meta: { kind: "unknown", hookEvent: "FutureHookEvent", source: "teleport" },
      }),
      new SessionRekey(),
      "default",
    );
    const dumped = JSON.stringify(unknown);
    expect(dumped).not.toContain("FutureHookEvent");
    expect(dumped).not.toContain("teleport");
    expect(unknown.meta).toEqual({ kind: "unknown" });
  });

  it("rebuilds nested test summaries and restricts error classes to coarse values", () => {
    const nested = redactEvent(
      {
        ...drillEvent({
          id: "outcome-e1",
          ts: 1,
          receivedAt: 1,
          sessionId: "s",
          kind: "tool.end",
        }),
        tool: {
          name: "Bash",
          category: "exec",
          execKind: "test",
          fingerprint: "fp",
          outcome: {
            ok: true,
            errorClass: "database_password_hunter",
            testSummary: { passed: 3, failed: 1 },
          },
        },
      } as unknown as NormalizedEvent,
      new SessionRekey(),
      "default",
    );
    // The runtime-added secret and the uncontracted error class are gone;
    // only the coarse counts the engine needs survive.
    const dumped = JSON.stringify(nested);
    expect(dumped).not.toContain("database_password_hunter");
    const withSecret = redactEvent(
      {
        ...drillEvent({
          id: "outcome-e2",
          ts: 2,
          receivedAt: 2,
          sessionId: "s",
          kind: "tool.end",
        }),
        tool: {
          name: "Bash",
          category: "exec",
          execKind: "test",
          fingerprint: "fp",
          outcome: {
            ok: true,
            testSummary: { passed: 3, secret: "sk-live-nested", extra_counts: [1, 2] },
          },
        },
      } as unknown as NormalizedEvent,
      new SessionRekey(),
      "default",
    );
    expect(JSON.stringify(withSecret)).not.toContain("sk-live-nested");
    expect(JSON.stringify(withSecret)).not.toContain("extra_counts");
    expect(withSecret.tool?.outcome).toEqual({ ok: true, testSummary: { passed: 3 } });
    const coarse = redactEvent(
      {
        ...drillEvent({
          id: "outcome-e3",
          ts: 3,
          receivedAt: 3,
          sessionId: "s",
          kind: "tool.fail",
        }),
        // drillEvent resets tool.fail outcomes to a bare `{ ok: false }`;
        // restore the coarse fields under test after the helper runs.
        tool: {
          name: "Bash",
          category: "exec",
          execKind: "test",
          fingerprint: "fp",
          outcome: { ok: false, exitCode: 1, errorClass: "test_failure" },
        },
      } as unknown as NormalizedEvent,
      new SessionRekey(),
      "default",
    );
    expect(coarse.tool?.outcome).toEqual({ ok: false, exitCode: 1, errorClass: "test_failure" });
  });

  it("drops absolute read targets and web/other targets rather than guessing", () => {
    const absolute = redactEvent(
      drillEvent({
        id: "abs-e1",
        ts: 1,
        receivedAt: 1,
        sessionId: "s",
        kind: "tool.start",
        tool: { name: "Read", category: "read", fingerprint: "fp", target: "/etc/passwd" },
      }),
      new SessionRekey(),
      "default",
    );
    expect(absolute.tool?.target).toBeUndefined();
    const web = redactEvent(
      drillEvent({
        id: "web-e1",
        ts: 1,
        receivedAt: 1,
        sessionId: "s",
        kind: "tool.start",
        tool: {
          name: "WebFetch",
          category: "web",
          fingerprint: "fp",
          target: "https://internal.corp/secret",
        },
      }),
      new SessionRekey(),
      "default",
    );
    expect(web.tool?.target).toBeUndefined();
  });
});

describe("recorder options", () => {
  it("hashes relative paths when created with redact=paths", () => {
    const filePath = tmpFile("paths.jsonl");
    const recorder = createRecorder({ filePath, agent: "claude-code", redact: "paths" });
    recorder.record([
      drillEvent({
        id: "p-e1",
        ts: 1,
        receivedAt: 1,
        sessionId: "s",
        kind: "tool.start",
        tool: { name: "Read", category: "read", fingerprint: "fp", target: "src/secret-module.ts" },
      }),
    ]);
    const event = JSON.parse(readLines(filePath)[1] as string) as NormalizedEvent;
    expect(event.tool?.target).not.toBe("src/secret-module.ts");
    expect(event.tool?.target).toMatch(/^[0-9a-f]{16}$/);
  });

  it("writes original payloads to a raw sidecar only with raw enabled", () => {
    const plainPath = tmpFile("plain.jsonl");
    const plain = createRecorder({ filePath: plainPath, agent: "claude-code" });
    expect(plain.rawFilePath).toBeNull();
    plain.recordRaw("should be dropped");
    expect(existsSync(`${plainPath.slice(0, -".jsonl".length)}.raw.jsonl`)).toBe(false);

    const rawPath = tmpFile("raw.jsonl");
    const withRaw = createRecorder({ filePath: rawPath, agent: "claude-code", raw: true });
    expect(withRaw.rawFilePath).toBe(`${rawPath.slice(0, -".jsonl".length)}.raw.jsonl`);
    withRaw.recordRaw(JSON.stringify({ session_id: "s", secret: "payload-text" }));
    const sidecar = readFileSync(withRaw.rawFilePath as string, "utf8");
    expect(sidecar).toContain("payload-text");
    const main = readFileSync(rawPath, "utf8");
    expect(main).not.toContain("payload-text");
  });

  it("keeps one re-key mapping across record calls so the lane stays stable", () => {
    const filePath = tmpFile("stable.jsonl");
    const recorder = createRecorder({ filePath, agent: "claude-code" });
    const first = drillEvent({
      id: "a",
      ts: 1,
      receivedAt: 1,
      sessionId: "live",
      kind: "session.start",
    });
    const second = drillEvent({
      id: "b",
      ts: 2,
      receivedAt: 2,
      sessionId: "live",
      kind: "turn.start",
    });
    recorder.record([first]);
    recorder.record([second]);
    const events = readLines(filePath)
      .slice(1)
      .map((line) => JSON.parse(line) as NormalizedEvent);
    expect(events.map((event) => event.sessionId)).toEqual(["s1", "s1"]);
  });
});
