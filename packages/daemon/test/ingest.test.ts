// packages/daemon/test/ingest.test.ts — the ingest pipeline in isolation:
// both wire forms route correctly, capabilities attach on first sight,
// receivedAt is stamped by the daemon clock, the per-session map context is
// threaded between raw posts, and every malformed input lands in the
// quarantine store without the ingest path ever throwing.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LastToolRecords } from "@hearable/adapter-kit";
import { type MapContext, parseClaudeShapedHook } from "@hearable/adapter-kit";
import type { NormalizedEvent } from "@hearable/core";
import { describe, expect, it } from "vitest";
import { createAdapterRegistry } from "../src/adapters.js";
import type { Scheduler, ServerMessage } from "../src/broadcast.js";
import { Broadcaster } from "../src/broadcast.js";
import type { Clock } from "../src/clock.js";
import { createIngest } from "../src/ingest.js";
import { LaneManager } from "../src/lanes.js";
import { createQuarantine } from "../src/quarantine.js";
import { Sessions } from "../src/sessions.js";
import { drillClaudeShapedAdapter, drillEvent, sessionStartEvent } from "./doubles.js";

class ManualScheduler implements Scheduler {
  private readonly pending: { fn: () => void; ms: number }[] = [];
  schedule(fn: () => void, ms: number): () => void {
    this.pending.push({ fn, ms });
    return () => {};
  }
  runAll(): void {
    for (const job of this.pending.splice(0)) {
      job.fn();
    }
  }
}

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "hearable-ingest-"));
  const now = 100;
  const clock: Clock = () => now;
  const sessions = new Sessions();
  const lanes = new LaneManager(3, 60_000, sessions, clock);
  const quarantine = createQuarantine(tmp, clock);
  const broadcaster = new Broadcaster(new ManualScheduler(), clock);
  const frames: ServerMessage[] = [];
  broadcaster.target = { send: (msg) => frames.push(msg) };
  const recorded: NormalizedEvent[][] = [];
  const rawBodies: string[] = [];
  const engines: NormalizedEvent[][] = [];
  const ingest = createIngest({
    adapters: createAdapterRegistry([drillClaudeShapedAdapter]),
    sessions,
    lanes,
    quarantine,
    broadcaster,
    clock,
    record: (events) => recorded.push([...events]),
    recordRaw: (bodyText) => rawBodies.push(bodyText),
    applyToEngine: (events) => engines.push([...events]),
  });
  return {
    ingest,
    sessions,
    lanes,
    quarantine,
    broadcaster,
    recorded,
    rawBodies,
    engines,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    quotaFile: join(tmp, "quarantine", "quarantine.jsonl"),
    currentTime: () => now,
  };
}

function quotaLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

/**
 * Reads the daemon-threaded last-tool record off an extended MapContext,
 * the same defensive read the adapter performs. Plain contexts without the
 * field yield null.
 */
function readThreadedLastTool(ctx: MapContext, sessionId: string): string | null {
  const records = (ctx as MapContext & { lastToolRecords?: LastToolRecords }).lastToolRecords;
  if (records === undefined) {
    return null;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const entry = records[index];
    if (entry !== undefined && entry.sessionId === sessionId) {
      return entry.toolName;
    }
  }
  return null;
}

describe("normalized wire form", () => {
  it("ingests a valid batch, assigns lanes and stamps receivedAt from the daemon clock", () => {
    const fx = fixture();
    const reason = fx.ingest.handlePostEvents({
      normalized: true,
      agentHeader: null,
      bodyText: JSON.stringify([
        sessionStartEvent("s-live"),
        drillEvent({ sessionId: "s-live", kind: "turn.start" }),
      ]),
    });
    expect(reason).toBeNull();
    const snapshot = fx.lanes.snapshot();
    expect(snapshot.lanes[1]?.state).toBe("active");
    expect(snapshot.lanes[1]?.sessions[0]?.sessionId).toBe("s-live");
    // Event time carries from the source; receipt time is the daemon clock.
    expect(fx.recorded[0]?.[0]?.ts).toBe(1000);
    expect(fx.recorded[0]?.[0]?.receivedAt).toBe(fx.currentTime());
    expect(fx.recorded[0]?.length).toBe(2);
    expect(fx.engines[0]?.length).toBe(2);
    fx.cleanup();
  });

  it("attaches the adapter's capabilities to the session on first sight", () => {
    const fx = fixture();
    fx.ingest.handlePostEvents({
      normalized: true,
      agentHeader: null,
      bodyText: JSON.stringify([sessionStartEvent("s-cap")]),
    });
    const record = fx.sessions.get("s-cap");
    expect(record?.agent).toBe("claude-code");
    expect(record?.capabilities).toEqual(drillClaudeShapedAdapter.capabilities);
    fx.cleanup();
  });

  it("quarantines the whole batch when one event fails the schema", () => {
    const fx = fixture();
    const reason = fx.ingest.handlePostEvents({
      normalized: true,
      agentHeader: null,
      bodyText: JSON.stringify([sessionStartEvent("s-ok"), { kind: "session.start" }]),
    });
    expect(reason).toMatch(/did not match the normalized schema/);
    expect(fx.quarantine.count()).toBe(1);
    expect(existsSync(fx.quotaFile)).toBe(true);
    expect(fx.lanes.occupiedCount()).toBe(0);
    fx.cleanup();
  });

  it("quarantines non-JSON and non-array bodies", () => {
    const fx = fixture();
    expect(
      fx.ingest.handlePostEvents({ normalized: true, agentHeader: null, bodyText: "not json" }),
    ).toMatch(/not valid JSON/);
    expect(
      fx.ingest.handlePostEvents({ normalized: true, agentHeader: null, bodyText: '{"a":1}' }),
    ).toMatch(/must be an array/);
    expect(fx.quarantine.count()).toBe(2);
    fx.cleanup();
  });
});

describe("raw wire form", () => {
  it("forwards accepted raw bodies verbatim to the recordRaw seam, and nothing else", () => {
    const fx = fixture();
    const accepted = JSON.stringify({
      session_id: "claude-raw",
      hook_event_name: "SessionStart",
      cwd: "/repo",
    });
    expect(
      fx.ingest.handlePostEvents({
        normalized: false,
        agentHeader: "claude-code",
        bodyText: accepted,
      }),
    ).toBeNull();
    // The normalized wire form has no original payload, so it must not appear.
    fx.ingest.handlePostEvents({
      normalized: true,
      agentHeader: null,
      bodyText: JSON.stringify([sessionStartEvent("s-norm")]),
    });
    // A quarantined raw body is a problem to keep, not a payload to preserve.
    fx.ingest.handlePostEvents({
      normalized: false,
      agentHeader: "claude-code",
      bodyText: "{ definitely not json",
    });
    expect(fx.rawBodies).toEqual([accepted]);
    fx.cleanup();
  });

  it("routes a raw claude-shaped payload through the adapter's map and assigns a lane", () => {
    const fx = fixture();
    const reason = fx.ingest.handlePostEvents({
      normalized: false,
      agentHeader: "claude-code",
      bodyText: JSON.stringify({
        session_id: "claude-live",
        hook_event_name: "SessionStart",
        cwd: "/repo",
      }),
    });
    expect(reason).toBeNull();
    const snapshot = fx.lanes.snapshot();
    expect(snapshot.lanes[1]?.sessions[0]?.sessionId).toBe("claude-live");
    const record = fx.sessions.get("claude-live");
    expect(record?.capabilities).toEqual(drillClaudeShapedAdapter.capabilities);
    expect(record?.cwd).toBe("/repo");
    fx.cleanup();
  });

  it("quarantines an unknown agent header", () => {
    const fx = fixture();
    const reason = fx.ingest.handlePostEvents({
      normalized: false,
      agentHeader: "mystery",
      bodyText: "{}",
    });
    expect(reason).toMatch(/no adapter registered for agent "mystery"/);
    expect(fx.quarantine.count()).toBe(1);
    fx.cleanup();
  });

  it("quarantines a missing agent header", () => {
    const fx = fixture();
    const reason = fx.ingest.handlePostEvents({
      normalized: false,
      agentHeader: null,
      bodyText: "{}",
    });
    expect(reason).toMatch(/missing x-hearable-agent/);
    expect(fx.quarantine.count()).toBe(1);
    fx.cleanup();
  });

  it("quarantines malformed JSON without crashing", () => {
    const fx = fixture();
    const reason = fx.ingest.handlePostEvents({
      normalized: false,
      agentHeader: "claude-code",
      bodyText: '{ight"grown',
    });
    expect(reason).toMatch(/not valid JSON/);
    expect(fx.quarantine.count()).toBe(1);
    expect(fx.lanes.occupiedCount()).toBe(0);
    fx.cleanup();
  });

  it("quarantines ambiguous routing when both headers are present", () => {
    const fx = fixture();
    const reason = fx.ingest.handlePostEvents({
      normalized: true,
      agentHeader: "claude-code",
      bodyText: "[]",
    });
    expect(reason).toMatch(/exactly one wire form/);
    expect(fx.quarantine.count()).toBe(1);
    fx.cleanup();
  });

  it("quarantines instead of crashing when an adapter throws inside map", () => {
    const fx = fixture();
    const throwingAdapter = {
      ...drillClaudeShapedAdapter,
      map: () => {
        throw new Error("boom");
      },
    };
    const ingest2 = createIngest({
      adapters: createAdapterRegistry([throwingAdapter]),
      sessions: fx.sessions,
      lanes: fx.lanes,
      quarantine: fx.quarantine,
      broadcaster: fx.broadcaster,
      clock: () => fx.currentTime(),
    });
    const reason = ingest2.handlePostEvents({
      normalized: false,
      agentHeader: "claude-code",
      bodyText: JSON.stringify({ session_id: "s", hook_event_name: "SessionStart" }),
    });
    expect(reason).toMatch(/adapter.map threw: boom/);
    expect(fx.quarantine.count()).toBe(1);
    expect(fx.lanes.occupiedCount()).toBe(0);
    fx.cleanup();
  });
});

describe("crash-safety", () => {
  it("never throws on malformed input of any shape; quirks go to quarantine or are validly ignored", () => {
    const fx = fixture();
    const cases: { normalized: boolean; agentHeader: string | null; bodyText: string }[] = [
      { normalized: true, agentHeader: null, bodyText: "null" },
      { normalized: true, agentHeader: null, bodyText: "[]" },
      { normalized: false, agentHeader: null, bodyText: "" },
      { normalized: false, agentHeader: "claude-code", bodyText: "42" },
      { normalized: false, agentHeader: "claude-code", bodyText: '"just a string"' },
    ];
    for (const args of cases) {
      expect(() => fx.ingest.handlePostEvents(args)).not.toThrow();
    }
    // A JSON `null` body, a missing routing header and an empty raw body are
    // quarantined; an empty batch and a payload an adapter maps to nothing are
    // validly accepted (adapters return [] when a payload means nothing).
    expect(fx.quarantine.count()).toBe(2);
    expect(quotaLines(fx.quotaFile)).toHaveLength(2);
    expect(fx.lanes.occupiedCount()).toBe(0);
    fx.cleanup();
  });

  it("reuses the session's stored cwd for a later raw payload without a cwd", () => {
    const fx = fixture();
    const seenCwds: string[] = [];
    const probingAdapter = {
      ...drillClaudeShapedAdapter,
      map(raw: unknown, ctx: MapContext) {
        seenCwds.push(ctx.cwd);
        return drillClaudeShapedAdapter.map(raw, ctx);
      },
    };
    const ingest2 = createIngest({
      adapters: createAdapterRegistry([probingAdapter]),
      sessions: fx.sessions,
      lanes: fx.lanes,
      quarantine: fx.quarantine,
      broadcaster: fx.broadcaster,
      clock: () => fx.currentTime(),
    });
    // First raw payload records /repo as the session's cwd.
    const first = ingest2.handlePostEvents({
      normalized: false,
      agentHeader: "claude-code",
      bodyText: JSON.stringify({
        session_id: "s-cwd",
        hook_event_name: "SessionStart",
        cwd: "/repo",
      }),
    });
    // A later raw payload without a cwd must still see /repo, so
    // path-relative fingerprints are computed against the right directory.
    const second = ingest2.handlePostEvents({
      normalized: false,
      agentHeader: "claude-code",
      bodyText: JSON.stringify({
        session_id: "s-cwd",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
      }),
    });
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(seenCwds).toEqual(["/repo", "/repo"]);
    expect(fx.quarantine.count()).toBe(0);
    fx.cleanup();
  });

  it("falls back to a fresh payload's own cwd over any stored value", () => {
    const fx = fixture();
    const seenCwds: string[] = [];
    const probingAdapter = {
      ...drillClaudeShapedAdapter,
      map(raw: unknown, ctx: MapContext) {
        seenCwds.push(ctx.cwd);
        return drillClaudeShapedAdapter.map(raw, ctx);
      },
    };
    const ingest2 = createIngest({
      adapters: createAdapterRegistry([probingAdapter]),
      sessions: fx.sessions,
      lanes: fx.lanes,
      quarantine: fx.quarantine,
      broadcaster: fx.broadcaster,
      clock: () => fx.currentTime(),
    });
    ingest2.handlePostEvents({
      normalized: false,
      agentHeader: "claude-code",
      bodyText: JSON.stringify({
        session_id: "s-cwd2",
        hook_event_name: "SessionStart",
        cwd: "/old",
      }),
    });
    ingest2.handlePostEvents({
      normalized: false,
      agentHeader: "claude-code",
      bodyText: JSON.stringify({
        session_id: "s-cwd2",
        hook_event_name: "UserPromptSubmit",
        cwd: "/new",
      }),
    });
    expect(seenCwds).toEqual(["/old", "/new"]);
    fx.cleanup();
  });

  it("threads one pending-tool-start context per session across raw posts", () => {
    const fx = fixture();
    const ctxSeen: number[] = [];
    const probingAdapter = {
      ...drillClaudeShapedAdapter,
      map(raw: unknown, ctx: MapContext) {
        ctxSeen.push(ctx.pendingToolStarts.length);
        const hook = parseClaudeShapedHook(raw);
        const sessionId = hook.sessionId ?? "s-ctx";
        if (hook.hookEventName === "PreToolUse") {
          return [
            drillEvent({
              sessionId,
              kind: "tool.start",
              tool: { name: "Bash", category: "exec", fingerprint: "fp" },
            }),
          ];
        }
        return [
          drillEvent({
            sessionId,
            kind: "tool.end",
            tool: { name: "Bash", category: "exec", fingerprint: "fp", outcome: { ok: true } },
          }),
        ];
      },
    };
    const ingest2 = createIngest({
      adapters: createAdapterRegistry([probingAdapter]),
      sessions: fx.sessions,
      lanes: fx.lanes,
      quarantine: fx.quarantine,
      broadcaster: fx.broadcaster,
      clock: () => fx.currentTime(),
    });
    const start = ingest2.handlePostEvents({
      normalized: false,
      agentHeader: "claude-code",
      bodyText: JSON.stringify({
        session_id: "s-ctx",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
      }),
    });
    const end = ingest2.handlePostEvents({
      normalized: false,
      agentHeader: "claude-code",
      bodyText: JSON.stringify({
        session_id: "s-ctx",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
      }),
    });
    expect(start).toBeNull();
    expect(end).toBeNull();
    // The start was visible to the end's map call: the daemon owned the list.
    expect(ctxSeen).toEqual([0, 1]);
    expect(fx.quarantine.count()).toBe(0);
    fx.cleanup();
  });

  it("threads the last-tool record so Stop sees a completed question tool", () => {
    // Live-path regression: PreToolUse(AskUserQuestion) -> PostToolUse ->
    // Stop with a non-question final message must yield question, because
    // the daemon folds every mapped tool event through the bounded
    // last-tool record and passes it into the Stop's MapContext.
    const fx = fixture();
    const questionAdapter = {
      ...drillClaudeShapedAdapter,
      map(raw: unknown, ctx: MapContext): readonly NormalizedEvent[] {
        const hook = parseClaudeShapedHook(raw);
        const sessionId = hook.sessionId ?? "s-q";
        if (hook.hookEventName === "PreToolUse") {
          return [
            drillEvent({
              sessionId,
              kind: "question.asked",
              lifecycle: { reason: "question", confidence: "observed" },
            }),
            drillEvent({
              sessionId,
              kind: "tool.start",
              tool: { name: "AskUserQuestion", category: "other", fingerprint: "fp-q" },
            }),
          ];
        }
        if (hook.hookEventName === "PostToolUse") {
          return [
            drillEvent({
              sessionId,
              kind: "tool.end",
              tool: {
                name: "AskUserQuestion",
                category: "other",
                fingerprint: "fp-q",
                outcome: { ok: true },
              },
            }),
          ];
        }
        if (hook.hookEventName === "Stop") {
          const lastTool = readThreadedLastTool(ctx, sessionId);
          return [
            drillEvent({
              sessionId,
              kind: "turn.end",
              lifecycle: {
                reason: lastTool === "AskUserQuestion" ? "question" : "completed",
                confidence: lastTool === "AskUserQuestion" ? "inferred" : "observed",
              },
            }),
          ];
        }
        return drillClaudeShapedAdapter.map(raw, ctx);
      },
    };
    const ingest2 = createIngest({
      adapters: createAdapterRegistry([questionAdapter]),
      sessions: fx.sessions,
      lanes: fx.lanes,
      quarantine: fx.quarantine,
      broadcaster: fx.broadcaster,
      clock: () => fx.currentTime(),
      record: (events) => fx.recorded.push([...events]),
    });
    const post = (hookEventName: string, extra: Record<string, unknown> = {}) =>
      ingest2.handlePostEvents({
        normalized: false,
        agentHeader: "claude-code",
        bodyText: JSON.stringify({
          session_id: "s-q",
          hook_event_name: hookEventName,
          cwd: "/repo",
          ...extra,
        }),
      });
    expect(post("PreToolUse", { tool_name: "AskUserQuestion" })).toBeNull();
    expect(post("PostToolUse", { tool_name: "AskUserQuestion" })).toBeNull();
    expect(post("Stop")).toBeNull();
    const turnEnds = fx.recorded.flat().filter((event) => event.kind === "turn.end");
    expect(turnEnds.length).toBe(1);
    expect(turnEnds[0]?.lifecycle).toMatchObject({ reason: "question", confidence: "inferred" });
    expect(fx.quarantine.count()).toBe(0);
    fx.cleanup();
  });
});
