// packages/core/test/engine/lifecycle.test.ts — behaviour tests for the
// engine foundation: every lifecycle transition in the docs/STATE_ENGINE.md
// diagram, every illegal transition (idle → waiting, waiting expiring on its
// own, turn_complete entered from idle), and the activity EMA scaling and
// decay. These tests must stay inside core and rely on no adapter. Mode,
// struggle, progress and capability gating belong to p2-t02, p2-t03 and
// p2-t04.

import { describe, expect, it } from "vitest";
import {
  ACTIVITY_SCALE_SECONDS,
  ACTIVITY_TAU_MS,
  INFERRED_TURN_COMPLETE_AFTER_MS,
  QUIET_AFTER_MS,
  STALE_AFTER_MS,
  TURN_COMPLETE_TO_IDLE_MS,
} from "../../src/engine/index.js";
import {
  type AdapterCapabilities,
  type AgentId,
  advance,
  applyEvent,
  createLane,
  type LaneState,
  type NormalizedEvent,
  SCHEMA_VERSION,
} from "../../src/index.js";

const T0 = 1_757_000_000_000;

const fullCapabilities: AdapterCapabilities = {
  sessionEvents: true,
  turnStart: "observed",
  turnEnd: "observed",
  toolEvents: true,
  toolFailures: true,
  editEvents: true,
  execEvents: true,
  permissionEvents: true,
  questionEvents: true,
  subagents: true,
  compaction: true,
  toolKinds: "byName",
  durations: true,
};

function lane(overrides: Partial<LaneState> = {}): LaneState {
  return {
    ...createLane({
      laneId: 1,
      sessionId: "s1",
      agent: "claude-code" satisfies AgentId,
      capabilities: fullCapabilities,
      now: T0,
    }),
    ...overrides,
  };
}

let nextId = 0;

function event(
  kind: NormalizedEvent["kind"],
  ts: number,
  extra: Record<string, unknown> = {},
): NormalizedEvent {
  nextId += 1;
  const base = {
    v: SCHEMA_VERSION,
    id: `test-event-${nextId}`,
    ts,
    receivedAt: ts,
    agent: "claude-code",
    sessionId: "s1",
  } as const;
  switch (kind) {
    case "turn.end":
      return {
        ...base,
        kind,
        lifecycle: { reason: "completed", confidence: "observed" },
        ...extra,
      } as NormalizedEvent;
    case "tool.start":
      return {
        ...base,
        kind,
        tool: { name: "Read", category: "read", fingerprint: "aaaabbbbccccdddd" },
        ...extra,
      } as NormalizedEvent;
    case "tool.end":
      return {
        ...base,
        kind,
        tool: {
          name: "Read",
          category: "read",
          fingerprint: "aaaabbbbccccdddd",
          outcome: { ok: true },
        },
        ...extra,
      } as NormalizedEvent;
    case "tool.fail":
      return {
        ...base,
        kind,
        tool: {
          name: "Bash",
          category: "exec",
          fingerprint: "eeeeffff00001111",
          outcome: { ok: false },
        },
        ...extra,
      } as NormalizedEvent;
    case "permission.request":
      return {
        ...base,
        kind,
        lifecycle: { reason: "permission", confidence: "observed" },
        ...extra,
      } as NormalizedEvent;
    case "question.asked":
      return {
        ...base,
        kind,
        lifecycle: { reason: "question", confidence: "observed" },
        ...extra,
      } as NormalizedEvent;
    case "notification":
      return { ...base, kind, meta: { kind: "streaming" }, ...extra } as NormalizedEvent;
    case "subagent.start":
    case "subagent.end":
      return { ...base, kind, parentSessionId: "s1", ...extra } as NormalizedEvent;
    default:
      return { ...base, kind, ...extra } as NormalizedEvent;
  }
}

function startTurn(state: LaneState, at: number): LaneState {
  return applyEvent(state, event("turn.start", at));
}

describe("lifecycle transitions", () => {
  it("starts idle with neutral mode weights and no reasons", () => {
    const state = lane();
    expect(state.lifecycle).toBe("idle");
    expect(state.activity).toBe(0);
    expect(state.reasons).toEqual([]);
    expect(state.turnStartedAt).toBeUndefined();
  });

  it("enters active on turn.start and records the turn start time", () => {
    const state = startTurn(lane(), T0);
    expect(state.lifecycle).toBe("active");
    expect(state.turnStartedAt).toBe(T0);
    expect(state.lastEventAt).toBe(T0);
    expect(state.reasons).toHaveLength(1);
  });

  it("enters waiting on permission.request with a permission reason", () => {
    const state = applyEvent(startTurn(lane(), T0), event("permission.request", T0 + 1000));
    expect(state.lifecycle).toBe("waiting");
    expect(state.waitingReason).toBe("permission");
  });

  it("enters waiting on question.asked with a question reason", () => {
    const state = applyEvent(startTurn(lane(), T0), event("question.asked", T0 + 1000));
    expect(state.lifecycle).toBe("waiting");
    expect(state.waitingReason).toBe("question");
  });

  it("enters waiting on turn.end with a question reason", () => {
    const state = applyEvent(
      startTurn(lane(), T0),
      event("turn.end", T0 + 1000, {
        lifecycle: { reason: "question", confidence: "observed" },
      }),
    );
    expect(state.lifecycle).toBe("waiting");
    expect(state.waitingReason).toBe("question");
  });

  it("enters waiting on turn.end with a permission reason", () => {
    const state = applyEvent(
      startTurn(lane(), T0),
      event("turn.end", T0 + 1000, {
        lifecycle: { reason: "permission", confidence: "observed" },
      }),
    );
    expect(state.lifecycle).toBe("waiting");
    expect(state.waitingReason).toBe("permission");
  });

  it("enters waiting on turn.end with an idle_prompt reason", () => {
    const state = applyEvent(
      startTurn(lane(), T0),
      event("turn.end", T0 + 1000, {
        lifecycle: { reason: "idle_prompt", confidence: "inferred" },
      }),
    );
    expect(state.lifecycle).toBe("waiting");
    expect(state.waitingReason).toBe("idle_prompt");
  });

  it("enters turn_complete on turn.end with a completed reason", () => {
    const state = applyEvent(startTurn(lane(), T0), event("turn.end", T0 + 1000));
    expect(state.lifecycle).toBe("turn_complete");
    expect(state.waitingReason).toBeUndefined();
    expect(state.turnStartedAt).toBeUndefined();
  });

  it("enters turn_complete on turn.end from quiet", () => {
    const quiet = applyEvent(startTurn(lane(), T0), event("compaction", T0 + 1000));
    const state = applyEvent(quiet, event("turn.end", T0 + 2000));
    expect(state.lifecycle).toBe("turn_complete");
  });

  it("marks turn_complete inferred when the completed turn.end is inferred", () => {
    const state = applyEvent(
      startTurn(lane(), T0),
      event("turn.end", T0 + 1000, {
        lifecycle: { reason: "completed", confidence: "inferred" },
      }),
    );
    expect(state.lifecycle).toBe("turn_complete");
    expect(state.lifecycleConfidence).toBe("inferred");
  });

  it("marks an inferred turn.start as inferred", () => {
    const state = applyEvent(
      lane(),
      event("turn.start", T0, { lifecycle: { reason: "unknown", confidence: "inferred" } }),
    );
    expect(state.lifecycle).toBe("active");
    expect(state.lifecycleConfidence).toBe("inferred");
  });

  it("resets confidence to observed on an unmarked turn.start after an inferred timeout", () => {
    const quiet = advance(startTurn(lane(), T0), T0 + QUIET_AFTER_MS);
    expect(quiet.lifecycle).toBe("quiet");
    expect(quiet.lifecycleConfidence).toBe("inferred");
    const state = applyEvent(quiet, event("turn.start", T0 + QUIET_AFTER_MS + 1000));
    expect(state.lifecycle).toBe("active");
    expect(state.lifecycleConfidence).toBe("observed");
  });

  it("marks waiting inferred for inferred permission and question events", () => {
    const permissioned = applyEvent(
      startTurn(lane(), T0),
      event("permission.request", T0 + 1000, {
        lifecycle: { reason: "permission", confidence: "inferred" },
      }),
    );
    expect(permissioned.lifecycle).toBe("waiting");
    expect(permissioned.lifecycleConfidence).toBe("inferred");
    const questioned = applyEvent(
      startTurn(lane(), T0),
      event("question.asked", T0 + 1000, {
        lifecycle: { reason: "question", confidence: "inferred" },
      }),
    );
    expect(questioned.lifecycle).toBe("waiting");
    expect(questioned.lifecycleConfidence).toBe("inferred");
  });

  it("returns to active from waiting on turn.start and clears the reason", () => {
    const waiting = applyEvent(startTurn(lane(), T0), event("permission.request", T0 + 1000));
    const state = applyEvent(waiting, event("turn.start", T0 + 2000));
    expect(state.lifecycle).toBe("active");
    expect(state.waitingReason).toBeUndefined();
    expect(state.turnStartedAt).toBe(T0 + 2000);
  });

  it.each(["observed", "inferred"] as const)(
    "clears a permission wait when the turn completes (%s)",
    (confidence) => {
      const waiting = applyEvent(startTurn(lane(), T0), event("permission.request", T0 + 1000));
      const done = applyEvent(
        waiting,
        event("turn.end", T0 + 2000, { lifecycle: { reason: "completed", confidence } }),
      );
      expect(done.lifecycle).toBe("turn_complete");
      expect(done.lifecycleConfidence).toBe(confidence);
      expect(done.waitingReason).toBeUndefined();
      expect(done.turnStartedAt).toBeUndefined();
      expect(advance(done, T0 + 2000 + TURN_COMPLETE_TO_IDLE_MS).lifecycle).toBe("idle");
    },
  );

  it("returns to active from waiting on a permission_replied notification", () => {
    const waiting = applyEvent(startTurn(lane(), T0), event("permission.request", T0 + 1000));
    const state = applyEvent(
      waiting,
      event("notification", T0 + 2000, { meta: { kind: "permission_replied" } }),
    );
    expect(state.lifecycle).toBe("active");
    expect(state.waitingReason).toBeUndefined();
  });

  it("returns to active, inferred, when the tool a permission request named runs", () => {
    const named = { name: "Bash", category: "exec", fingerprint: "eeeeffff00001111" };
    const waiting = applyEvent(
      startTurn(lane(), T0),
      event("permission.request", T0 + 1000, { tool: named }),
    );
    const state = applyEvent(waiting, event("tool.start", T0 + 2000, { tool: named }));
    expect(state.lifecycle).toBe("active");
    expect(state.lifecycleConfidence).toBe("inferred");
    expect(state.waitingReason).toBeUndefined();
    expect(state.internal.permissionFingerprint).toBeNull();
  });

  it("keeps a permission wait through tools other than the one it named", () => {
    const named = { name: "Bash", category: "exec", fingerprint: "eeeeffff00001111" };
    const waiting = applyEvent(
      startTurn(lane(), T0),
      event("permission.request", T0 + 1000, { tool: named }),
    );
    const state = applyEvent(waiting, event("tool.end", T0 + 2000));
    expect(state.lifecycle).toBe("waiting");
    expect(state.waitingReason).toBe("permission");
  });

  it("keeps a permission wait that named no tool through any tool activity", () => {
    const waiting = applyEvent(startTurn(lane(), T0), event("permission.request", T0 + 1000));
    const state = applyEvent(waiting, event("tool.fail", T0 + 2000));
    expect(state.lifecycle).toBe("waiting");
  });

  it("releases to idle from waiting on session.end", () => {
    const waiting = applyEvent(startTurn(lane(), T0), event("permission.request", T0 + 1000));
    const state = applyEvent(waiting, event("session.end", T0 + 2000));
    expect(state.lifecycle).toBe("idle");
    expect(state.waitingReason).toBeUndefined();
  });

  it("releases to idle from any state on session.end", () => {
    for (const setup of [
      (s: LaneState) => s,
      (s: LaneState) => startTurn(s, T0),
      (s: LaneState) => applyEvent(startTurn(s, T0), event("compaction", T0 + 1000)),
      (s: LaneState) => applyEvent(startTurn(s, T0), event("turn.end", T0 + 1000)),
    ]) {
      const state = applyEvent(setup(lane()), event("session.end", T0 + 2000));
      expect(state.lifecycle).toBe("idle");
    }
  });

  it("enters quiet immediately on compaction with a reason", () => {
    const state = applyEvent(startTurn(lane(), T0), event("compaction", T0 + 1000));
    expect(state.lifecycle).toBe("quiet");
    expect(state.reasons[0]?.signal).toBe("lifecycle");
    expect(state.reasons[0]?.text).toMatch(/compact/i);
  });

  it("keeps waiting through compaction instead of going quiet", () => {
    const waiting = applyEvent(startTurn(lane(), T0), event("permission.request", T0 + 1000));
    const state = applyEvent(waiting, event("compaction", T0 + 2000));
    expect(state.lifecycle).toBe("waiting");
  });

  it("returns to active from quiet on tool activity", () => {
    const quiet = applyEvent(startTurn(lane(), T0), event("compaction", T0 + 1000));
    const state = applyEvent(quiet, event("tool.start", T0 + 2000));
    expect(state.lifecycle).toBe("active");
  });

  it("returns to active from stale on tool activity", () => {
    const quiet = applyEvent(startTurn(lane(), T0), event("compaction", T0 + 1000));
    const stale = advance(quiet, T0 + 1000 + STALE_AFTER_MS);
    expect(stale.lifecycle).toBe("stale");
    const state = applyEvent(stale, event("tool.start", T0 + 1000 + STALE_AFTER_MS + 1000));
    expect(state.lifecycle).toBe("active");
  });

  it.each(["idle", "active", "quiet", "stale", "waiting", "turn_complete"] as const)(
    "opening a session preserves its %s status and silence clock",
    (lifecycle) => {
      const before = lane({ lifecycle, lastEventAt: T0 });
      const reopened = applyEvent(
        before,
        event("session.start", T0 + 10_000, { meta: { source: "resume" } }),
      );
      expect(reopened.lifecycle).toBe(lifecycle);
      expect(reopened.lifecycleConfidence).toBe(before.lifecycleConfidence);
      expect(reopened.turnStartedAt).toBe(before.turnStartedAt);
      expect(reopened.lastEventAt).toBe(T0);
    },
  );

  it("opening a session does not postpone quiet, stale or idle transitions", () => {
    const active = startTurn(lane(), T0);
    const quiet = advance(active, T0 + QUIET_AFTER_MS);
    const done = applyEvent(active, event("turn.end", T0 + 1000));
    for (const [before, delay, lifecycle] of [
      [active, QUIET_AFTER_MS, "quiet"],
      [quiet, STALE_AFTER_MS, "stale"],
      [done, TURN_COMPLETE_TO_IDLE_MS, "idle"],
    ] as const) {
      const deadline = before.lastEventAt + delay;
      const reopened = applyEvent(before, event("session.start", deadline - 1));
      expect(advance(reopened, deadline).lifecycle).toBe(lifecycle);
    }
  });

  it("a reopened quiet or stale session works again on a prompt or tool event", () => {
    for (const silence of [QUIET_AFTER_MS, STALE_AFTER_MS]) {
      const active = startTurn(lane(), T0);
      const quiet = advance(active, T0 + QUIET_AFTER_MS);
      const resting = advance(quiet, T0 + silence);
      const reopened = applyEvent(resting, event("session.start", T0 + silence + 1));
      for (const kind of ["turn.start", "tool.start"] as const) {
        expect(applyEvent(reopened, event(kind, T0 + silence + 2)).lifecycle).toBe("active");
      }
    }
  });

  it("goes straight to active from turn_complete on turn.start", () => {
    const done = applyEvent(startTurn(lane(), T0), event("turn.end", T0 + 1000));
    const state = applyEvent(done, event("turn.start", T0 + 2000));
    expect(state.lifecycle).toBe("active");
    expect(state.turnStartedAt).toBe(T0 + 2000);
  });

  it("folds subagent events into the parent lane without creating one", () => {
    const active = startTurn(lane(), T0);
    // The engine never holds a subagent lane: callers route subagent events
    // to the parent lane, so folding means the lane identity is untouched
    // while its activity still records the subagent's work.
    const started = applyEvent(
      active,
      event("subagent.start", T0 + 1000, { sessionId: "s1", parentSessionId: "s1" }),
    );
    expect(started.sessionId).toBe("s1");
    expect(started.lifecycle).toBe("active");
    const tooled = applyEvent(
      started,
      event("tool.start", T0 + 2000, { sessionId: "s1", parentSessionId: "s1" }),
    );
    expect(tooled.sessionId).toBe("s1");
    expect(tooled.lifecycle).toBe("active");
    expect(tooled.activity).toBeGreaterThan(0);
  });

  it("revives an idle lane to active on tool activity", () => {
    const state = applyEvent(lane(), event("tool.start", T0));
    expect(state.lifecycle).toBe("active");
  });

  it("attaches later capabilities without branching on the agent", () => {
    const state = applyEvent(lane(), event("tool.start", T0), {
      ...fullCapabilities,
      turnEnd: "none",
    });
    expect(state.capabilities.turnEnd).toBe("none");
  });
});

describe("illegal transitions", () => {
  it("never enters waiting directly from idle", () => {
    for (const kind of ["permission.request", "question.asked"] as const) {
      expect(applyEvent(lane(), event(kind, T0)).lifecycle).toBe("idle");
    }
    expect(
      applyEvent(
        lane(),
        event("turn.end", T0, { lifecycle: { reason: "question", confidence: "observed" } }),
      ).lifecycle,
    ).toBe("idle");
  });

  it("never lets waiting expire on its own", () => {
    const waiting = applyEvent(startTurn(lane(), T0), event("permission.request", T0 + 1000));
    const later = advance(waiting, T0 + 1000 + STALE_AFTER_MS + QUIET_AFTER_MS + 60_000);
    expect(later.lifecycle).toBe("waiting");
    expect(later.waitingReason).toBe("permission");
  });

  it("never enters turn_complete from idle", () => {
    expect(applyEvent(lane(), event("turn.end", T0)).lifecycle).toBe("idle");
  });

  it("never enters turn_complete from stale on a completed turn.end", () => {
    const quiet = applyEvent(startTurn(lane(), T0), event("compaction", T0 + 1000));
    const stale = advance(quiet, T0 + 1000 + STALE_AFTER_MS);
    expect(stale.lifecycle).toBe("stale");
    expect(applyEvent(stale, event("turn.end", T0 + 1000 + STALE_AFTER_MS + 1000)).lifecycle).toBe(
      "stale",
    );
  });

  it("does not treat a question wait as completed without its answer", () => {
    const waiting = applyEvent(startTurn(lane(), T0), event("question.asked", T0 + 1000));
    expect(applyEvent(waiting, event("turn.end", T0 + 2000)).lifecycle).toBe("waiting");
  });

  it("never leaves waiting or turn_complete on tool activity", () => {
    const waiting = applyEvent(startTurn(lane(), T0), event("permission.request", T0 + 1000));
    expect(applyEvent(waiting, event("tool.start", T0 + 2000)).lifecycle).toBe("waiting");
    const done = applyEvent(startTurn(lane(), T0), event("turn.end", T0 + 1000));
    expect(applyEvent(done, event("tool.start", T0 + 2000)).lifecycle).toBe("turn_complete");
  });

  it("preserves waiting through every non-resolver event", () => {
    const at = T0 + 1000;
    const waiting = applyEvent(startTurn(lane(), T0), event("permission.request", at));
    const others: NormalizedEvent[] = [
      event("session.start", at + 100),
      event("tool.start", at + 200),
      event("tool.end", at + 300),
      event("tool.fail", at + 400),
      event("notification", at + 500),
      event("notification", at + 600, { meta: { kind: "streaming" } }),
      event("subagent.start", at + 700, {
        sessionId: "s1",
        parentSessionId: "s1",
      }),
      event("subagent.end", at + 800, { sessionId: "s1", parentSessionId: "s1" }),
      event("compaction", at + 900),
      event("agent.report", at + 1000),
      event("turn.end", at + 1100, { lifecycle: { reason: "unknown", confidence: "observed" } }),
      event("turn.end", at + 1200, {
        lifecycle: { reason: "permission", confidence: "observed" },
      }),
      event("turn.end", at + 1300, {
        lifecycle: { reason: "error", confidence: "observed" },
      }),
    ];
    for (const item of others) {
      const state = applyEvent(waiting, item);
      expect(state.lifecycle).toBe("waiting");
      expect(state.waitingReason).toBe("permission");
    }
  });

  it("ignores error, cancelled and unknown turn ends for lifecycle purposes", () => {
    for (const reason of ["error", "cancelled", "unknown"] as const) {
      const state = applyEvent(
        startTurn(lane(), T0),
        event("turn.end", T0 + 1000, {
          lifecycle: { reason, confidence: "observed" },
        }),
      );
      expect(state.lifecycle).toBe("active");
      expect(state.turnStartedAt).toBeUndefined();
    }
  });
});

describe("time-based transitions in advance", () => {
  it("moves active to quiet after 90 s of silence", () => {
    const active = startTurn(lane(), T0);
    expect(advance(active, T0 + QUIET_AFTER_MS - 1).lifecycle).toBe("active");
    const quiet = advance(active, T0 + QUIET_AFTER_MS);
    expect(quiet.lifecycle).toBe("quiet");
    expect(quiet.lifecycleConfidence).toBe("inferred");
  });

  it("moves quiet to stale after 8 min of silence", () => {
    const quiet = applyEvent(startTurn(lane(), T0), event("compaction", T0 + 1000));
    expect(advance(quiet, T0 + 1000 + STALE_AFTER_MS - 1).lifecycle).toBe("quiet");
    const stale = advance(quiet, T0 + 1000 + STALE_AFTER_MS);
    expect(stale.lifecycle).toBe("stale");
    expect(stale.lifecycleConfidence).toBe("inferred");
  });

  it("moves turn_complete back to idle after 20 s", () => {
    const done = applyEvent(startTurn(lane(), T0), event("turn.end", T0 + 1000));
    expect(advance(done, T0 + 1000 + TURN_COMPLETE_TO_IDLE_MS - 1).lifecycle).toBe("turn_complete");
    const idle = advance(done, T0 + 1000 + TURN_COMPLETE_TO_IDLE_MS);
    expect(idle.lifecycle).toBe("idle");
  });

  it("infers turn_complete after 120 s without events following activity", () => {
    // A tool event alone also starts the quiet clock; the 120 s inference
    // only matters through the quiet phase, so the pre-check sits inside it.
    // In this task the 120 s inference is gated on `turnEnd = "none"` (the
    // capability read p2-t01 left behind); p2-t04 owns the full capability
    // table.
    const noTurnEnd = { ...fullCapabilities, turnEnd: "none" as const };
    const active = applyEvent(lane(), event("tool.start", T0), noTurnEnd);
    expect(active.lifecycle).toBe("active");
    expect(advance(active, T0 + QUIET_AFTER_MS + 1000, noTurnEnd).lifecycle).toBe("quiet");
    const done = advance(active, T0 + INFERRED_TURN_COMPLETE_AFTER_MS, noTurnEnd);
    expect(done.lifecycle).toBe("turn_complete");
    expect(done.lifecycleConfidence).toBe("inferred");
  });

  it("never infers a turn end while turn ends are observed", () => {
    // Gated regression for the new-code path: with `turnEnd = "observed"`
    // (and also `"inferred"`) a silent lane goes quiet, then stale — the
    // engine must not invent the turn boundary the source reports itself.
    // Staleness is measured from the last event, so the stale probe sits a
    // full STALE_AFTER_MS past the tool event (the quiet midpoint probe
    // alone cannot reach it).
    for (const turnEnd of ["observed", "inferred"] as const) {
      const caps = { ...fullCapabilities, turnEnd };
      const active = applyEvent(lane(), event("tool.start", T0), caps);
      expect(advance(active, T0 + QUIET_AFTER_MS + 1000, caps).lifecycle).toBe("quiet");
      expect(advance(active, T0 + INFERRED_TURN_COMPLETE_AFTER_MS, caps).lifecycle).toBe("quiet");
      const quiet = advance(active, T0 + QUIET_AFTER_MS + 1000, caps);
      expect(advance(quiet, T0 + STALE_AFTER_MS + 1000, caps).lifecycle).toBe("stale");
    }
  });

  it("does not infer a turn end without prior activity", () => {
    const idle = lane();
    expect(advance(idle, T0 + INFERRED_TURN_COMPLETE_AFTER_MS + 60_000).lifecycle).toBe("idle");
  });

  it("enters waiting synchronously in applyEvent, not in advance", () => {
    const active = startTurn(lane(), T0);
    const waiting = applyEvent(active, event("permission.request", T0));
    expect(waiting.lifecycle).toBe("waiting");
    expect(waiting.lastEventAt).toBe(T0);
  });
});

describe("activity EMA", () => {
  it("settles near 1.0 at one tool event per 4 s", () => {
    let state = lane();
    for (let step = 0; step < 30; step += 1) {
      state = applyEvent(state, event("tool.start", T0 + step * 4000));
    }
    expect(state.activity).toBeGreaterThan(0.9);
    expect(state.activity).toBeLessThanOrEqual(1);
  });

  it("clamps above the reference cadence instead of growing past 1", () => {
    let state = lane();
    for (let step = 0; step < 10; step += 1) {
      state = applyEvent(state, event("tool.start", T0 + step * 500));
    }
    expect(state.activity).toBe(1);
  });

  it("reads near zero at a sparse cadence", () => {
    let state = lane();
    for (let step = 0; step < 12; step += 1) {
      state = applyEvent(state, event("tool.start", T0 + step * 60_000));
    }
    expect(state.activity).toBeLessThan(0.3);
  });

  it("ignores non-tool events for the rate but still refreshes lastEventAt", () => {
    const before = applyEvent(lane(), event("tool.start", T0));
    const after = applyEvent(before, event("notification", T0 + 1000));
    expect(after.activity).toBeLessThan(before.activity);
    expect(after.lastEventAt).toBe(T0 + 1000);
  });

  it("decays toward 0 in advance with the 15 s time constant", () => {
    // Eight-second spacing keeps the EMA below the clamp so the decay reads
    // as a clean exponential; at saturation the clamp would hide it.
    let state = lane();
    for (let step = 0; step < 10; step += 1) {
      state = applyEvent(state, event("tool.start", T0 + step * 8000));
    }
    const hot = state.activity;
    const lastToolAt = T0 + 9 * 8000;
    expect(hot).toBeGreaterThan(0.3);
    expect(hot).toBeLessThan(1);
    // Decay is measured from the last event, not from lane creation.
    const oneTau = advance(state, lastToolAt + ACTIVITY_TAU_MS);
    expect(oneTau.activity).toBeCloseTo(hot * Math.exp(-1), 5);
    expect(advance(state, lastToolAt + 10 * ACTIVITY_TAU_MS).activity).toBeLessThan(0.01);
  });

  it("never leaves [0, 1] under a burst", () => {
    let state = lane();
    for (let step = 0; step < 50; step += 1) {
      state = applyEvent(state, event("tool.start", T0 + step * 100));
      expect(state.activity).toBeGreaterThanOrEqual(0);
      expect(state.activity).toBeLessThanOrEqual(1);
    }
  });

  it("counts tool.end and tool.fail like tool.start", () => {
    const started = applyEvent(lane(), event("tool.start", T0));
    const ended = applyEvent(lane(), event("tool.end", T0));
    const failed = applyEvent(lane(), event("tool.fail", T0));
    const step = 1 / (ACTIVITY_TAU_MS / 1000);
    const expected = step * ACTIVITY_SCALE_SECONDS;
    expect(started.activity).toBeCloseTo(expected, 10);
    expect(ended.activity).toBeCloseTo(expected, 10);
    expect(failed.activity).toBeCloseTo(expected, 10);
  });
});

describe("purity and determinism", () => {
  it("returns new objects and never mutates the input", () => {
    const before = startTurn(lane(), T0);
    const frozen = structuredClone(before);
    const after = applyEvent(before, event("tool.start", T0 + 1000));
    expect(before).toEqual(frozen);
    expect(after).not.toBe(before);
    const advanced = advance(after, T0 + 2000);
    expect(after.activity).toBeGreaterThan(advanced.activity);
    expect(advanced).not.toBe(after);
  });

  it("replays the same sequence to deep-equal states", () => {
    const sequence = [
      event("turn.start", T0),
      event("tool.start", T0 + 1000),
      event("tool.end", T0 + 2000),
      event("permission.request", T0 + 3000),
      event("notification", T0 + 4000, { meta: { kind: "permission_replied" } }),
      event("turn.end", T0 + 5000),
    ];
    const run = (): LaneState => {
      let state = lane();
      for (const item of sequence) state = applyEvent(state, item);
      return advance(state, T0 + 6000);
    };
    expect(run()).toEqual(run());
  });
});
