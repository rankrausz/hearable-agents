// packages/adapters/codex/test/map.test.ts — behaviour tests for the
// Codex payload mapping: every event of docs/EVENTS.md §Codex CLI mapping
// becomes its normalized kind, failure comes from the exit code where
// present, Stop reasons stay inferred, Interrupt cancels, SessionEnd is
// never invented, and unknown events are preserved as notifications.
// Fixture files in fixtures/hooks/codex/ are the same payloads the
// conformance registration maps, so table and tests cannot drift apart.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MapContext } from "@hearable/adapter-kit";
import { describe, expect, it } from "vitest";
import { mapCodexPayload } from "../src/map.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "hooks",
  "codex",
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

function ctx(overrides?: Partial<MapContext>): MapContext {
  return { receivedAt: 1000, cwd: "/home/user/project", pendingToolStarts: [], ...overrides };
}

describe("the Codex mapping", () => {
  it("maps SessionStart to session.start with the source", () => {
    const [event] = mapCodexPayload(fixture("session-start.json"), ctx());
    expect(event?.kind).toBe("session.start");
    expect(event?.sessionId).toBe("s1");
    expect(event?.meta).toMatchObject({ source: "startup" });
  });

  it("maps UserPromptSubmit to turn.start with the turn id", () => {
    const [event] = mapCodexPayload(fixture("turn-start.json"), ctx());
    expect(event?.kind).toBe("turn.start");
    expect(event?.id).toBe("s1-628b49d96dcde97a-turn-start");
    expect(event?.meta).toMatchObject({ turnId: "t1" });
  });

  it("keeps successive turn lifecycle ids distinct", () => {
    const turnStart = fixture("turn-start.json") as Record<string, unknown>;
    const turnEnd = fixture("turn-end-completed.json") as Record<string, unknown>;
    const [firstStart] = mapCodexPayload({ ...turnStart, turn_id: "t1" }, ctx());
    const [firstEnd] = mapCodexPayload({ ...turnEnd, turn_id: "t1" }, ctx());
    const [secondStart] = mapCodexPayload({ ...turnStart, turn_id: "t2" }, ctx());
    const [secondEnd] = mapCodexPayload({ ...turnEnd, turn_id: "t2" }, ctx());

    expect(new Set([firstStart?.id, firstEnd?.id, secondStart?.id, secondEnd?.id]).size).toBe(4);
    expect([firstStart?.id, firstEnd?.id, secondStart?.id, secondEnd?.id].join(" ")).not.toContain(
      "t1",
    );
  });

  it("falls back to the event timestamp when turn_id is absent", () => {
    const turnStart = fixture("turn-start.json") as Record<string, unknown>;
    const [event] = mapCodexPayload(
      { ...turnStart, turn_id: undefined },
      ctx({ receivedAt: 4242 }),
    );

    expect(event?.id).toBe("s1-4242-turn-start");
  });

  it("maps PreToolUse to tool.start", () => {
    const [event] = mapCodexPayload(fixture("tool-start.json"), ctx());
    expect(event?.kind).toBe("tool.start");
    expect(event?.tool?.name).toBe("Bash");
    expect(event?.tool?.category).toBe("exec");
    expect(event?.meta).toMatchObject({ turnId: "t1" });
  });

  it("maps PostToolUse with exit code 0 to tool.end", () => {
    const [event] = mapCodexPayload(fixture("tool-end.json"), ctx());
    expect(event?.kind).toBe("tool.end");
    expect(event?.tool?.outcome).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("maps PostToolUse with a nonzero exit code to tool.fail", () => {
    const [event] = mapCodexPayload(fixture("tool-fail.json"), ctx());
    expect(event?.kind).toBe("tool.fail");
    expect(event?.tool?.outcome).toMatchObject({ ok: false, exitCode: 1, errorClass: "other" });
  });

  it("labels exit code 127 as not_found and drops the output text", () => {
    const response = { exit_code: 127, output: "bash: line 1: nosuchcmd: command not found" };
    const [event] = mapCodexPayload(
      {
        session_id: "s1",
        hook_event_name: "PostToolUse",
        cwd: "/home/user/project",
        tool_name: "Bash",
        tool_input: { command: "nosuchcmd --help" },
        tool_use_id: "u9",
        tool_response: response,
        turn_id: "t1",
      },
      ctx(),
    );
    expect(event?.kind).toBe("tool.fail");
    expect(event?.tool?.outcome).toMatchObject({
      ok: false,
      exitCode: 127,
      errorClass: "not_found",
    });
    expect(JSON.stringify(event)).not.toContain("nosuchcmd: command not found");
  });

  it("labels a status-only failure as other without an exit code", () => {
    const [event] = mapCodexPayload(
      {
        session_id: "s1",
        hook_event_name: "PostToolUse",
        cwd: "/home/user/project",
        tool_name: "Bash",
        tool_input: { command: "pytest tests/unit" },
        tool_use_id: "u10",
        tool_response: { status: "failed" },
        turn_id: "t1",
      },
      ctx(),
    );
    expect(event?.kind).toBe("tool.fail");
    expect(event?.tool?.outcome).toMatchObject({ ok: false, errorClass: "other" });
    expect(event?.tool?.outcome).not.toHaveProperty("exitCode");
  });

  it("maps PermissionRequest to an unconfirmed permission request", () => {
    const [event] = mapCodexPayload(fixture("permission-request.json"), ctx());
    expect(event?.kind).toBe("permission.request");
    expect(event?.lifecycle).toMatchObject({ reason: "permission", confidence: "inferred" });
  });

  it("names the requested tool on permission.request so its run can end the wait", () => {
    const [request] = mapCodexPayload(fixture("permission-request.json"), ctx());
    const [start] = mapCodexPayload(
      { ...(fixture("permission-request.json") as object), hook_event_name: "PreToolUse" },
      ctx(),
    );
    expect(request?.tool?.name).toBe("Bash");
    expect(request?.tool?.fingerprint).toBe(start?.tool?.fingerprint);
  });

  it("maps Stop to turn.end completed at inferred confidence", () => {
    const [event] = mapCodexPayload(fixture("turn-end-completed.json"), ctx());
    expect(event?.kind).toBe("turn.end");
    expect(event?.id).toBe("s1-628b49d96dcde97a-turn-end");
    expect(event?.lifecycle).toMatchObject({ reason: "completed", confidence: "inferred" });
  });

  it("maps Stop ending in a question mark to turn.end question at inferred confidence", () => {
    const [event] = mapCodexPayload(fixture("turn-end-question.json"), ctx());
    expect(event?.kind).toBe("turn.end");
    expect(event?.id).toBe("s1-628b49d96dcde97a-turn-end");
    expect(event?.lifecycle).toMatchObject({ reason: "question", confidence: "inferred" });
  });

  it("maps Interrupt to turn.end cancelled", () => {
    const [event] = mapCodexPayload(fixture("interrupt.json"), ctx());
    expect(event?.kind).toBe("turn.end");
    expect(event?.lifecycle).toMatchObject({ reason: "cancelled" });
  });

  it("maps subagent hooks to subagent events folded into the parent", () => {
    const [start] = mapCodexPayload(fixture("subagent-start.json"), ctx());
    expect(start?.kind).toBe("subagent.start");
    expect(start?.sessionId).toBe("sub1");
    expect(start?.parentSessionId).toBe("s1");
    const [stop] = mapCodexPayload(fixture("subagent-stop.json"), ctx());
    expect(stop?.kind).toBe("subagent.end");
    expect(stop?.sessionId).toBe("sub1");
    expect(stop?.parentSessionId).toBe("s1");
  });

  it("maps PreCompact and PostCompact to compaction", () => {
    const [pre] = mapCodexPayload(fixture("compaction.json"), ctx());
    expect(pre?.kind).toBe("compaction");
    expect(pre?.meta).toMatchObject({ trigger: "manual" });
    const [post] = mapCodexPayload(fixture("compaction-post.json"), ctx());
    expect(post?.kind).toBe("compaction");
    expect(post?.meta).toMatchObject({ trigger: "auto" });
  });

  it("never invents session.end from SessionEnd", () => {
    expect(mapCodexPayload(fixture("session-end-ignored.json"), ctx())).toEqual([]);
  });

  it("preserves unknown events as notifications", () => {
    const [event] = mapCodexPayload(fixture("unknown-event.json"), ctx());
    expect(event?.kind).toBe("notification");
    expect(event?.meta).toMatchObject({ kind: "unknown", hookEvent: "SomeFutureEvent" });
  });

  it("returns nothing when the payload names no session", () => {
    expect(mapCodexPayload({ hook_event_name: "Stop" }, ctx())).toEqual([]);
    expect(mapCodexPayload(null, ctx())).toEqual([]);
  });

  it("computes tool durations from the pending start", () => {
    const startCtx = ctx();
    const [start] = mapCodexPayload(fixture("tool-start.json"), startCtx);
    expect(start?.kind).toBe("tool.start");
    const endCtx = ctx({
      receivedAt: 2500,
      pendingToolStarts: [{ sessionId: "s1", toolName: "Bash", toolUseId: "u1", startedAt: 1000 }],
    });
    const [end] = mapCodexPayload(fixture("tool-end.json"), endCtx);
    expect(end?.kind).toBe("tool.end");
    expect(end?.tool?.durationMs).toBe(1500);
  });
});
