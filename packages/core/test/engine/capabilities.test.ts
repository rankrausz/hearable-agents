// packages/core/test/engine/capabilities.test.ts — behaviour tests for the
// docs/STATE_ENGINE.md §Capability-aware inference table: every row (edit
// events, turn-start inference/absence, turn-end absence, no prompt events,
// no failure events, no compaction), the exact-zero invariant for disabled
// struggle rows, the `?`-message waiting rule and its conservative negative,
// confidence labelling, reason capping and order, the lane fidelity summary,
// and the agent-blind identical-states check (invariant 9). Synthetic
// sequences only; no tuning against real fixtures (calibration is p2-t09).

import { describe, expect, it } from "vitest";
import {
  advance,
  applyEvent,
  createLane,
  INFERRED_TURN_COMPLETE_AFTER_MS,
  MAX_REASONS,
  QUIET_AFTER_MS,
  STALE_AFTER_MS,
} from "../../src/engine/index.js";
import {
  type AdapterCapabilities,
  type AgentId,
  type LaneState,
  type NormalizedEvent,
  SCHEMA_VERSION,
  type ToolInfo,
} from "../../src/index.js";

const T0 = 1_759_000_000_000;

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

const noEditCapabilities: AdapterCapabilities = { ...fullCapabilities, editEvents: false };
const noFailCapabilities: AdapterCapabilities = { ...fullCapabilities, toolFailures: false };
const noTurnStartCapabilities: AdapterCapabilities = { ...fullCapabilities, turnStart: "none" };
const inferredTurnStartCapabilities: AdapterCapabilities = {
  ...fullCapabilities,
  turnStart: "inferred",
};
const noTurnEndCapabilities: AdapterCapabilities = { ...fullCapabilities, turnEnd: "none" };
const noPromptCapabilities: AdapterCapabilities = {
  ...fullCapabilities,
  permissionEvents: false,
  questionEvents: false,
};
const noCompactionCapabilities: AdapterCapabilities = { ...fullCapabilities, compaction: false };

function lane(
  capabilities: AdapterCapabilities = fullCapabilities,
  agent: AgentId = "claude-code",
): LaneState {
  return createLane({ laneId: 1, sessionId: "s1", agent, capabilities, now: T0 });
}

let nextId = 0;
function base(ts: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  nextId += 1;
  return {
    v: SCHEMA_VERSION,
    id: `capability-test-${nextId}`,
    ts,
    receivedAt: ts,
    agent: "claude-code",
    sessionId: "s1",
    ...extra,
  };
}

function turnStart(ts: number): NormalizedEvent {
  return { ...base(ts), kind: "turn.start" } as NormalizedEvent;
}

function inferredTurnStart(ts: number): NormalizedEvent {
  return {
    ...base(ts),
    kind: "turn.start",
    lifecycle: { reason: "unknown", confidence: "inferred" },
  } as NormalizedEvent;
}

function turnEndCompleted(ts: number, extra: Record<string, unknown> = {}): NormalizedEvent {
  return {
    ...base(ts),
    kind: "turn.end",
    lifecycle: { reason: "completed", confidence: "observed" },
    ...extra,
  } as NormalizedEvent;
}

function toolStart(ts: number, tool: ToolInfo): NormalizedEvent {
  return { ...base(ts), kind: "tool.start", tool } as NormalizedEvent;
}

function toolFail(ts: number, tool: ToolInfo): NormalizedEvent {
  return {
    ...base(ts),
    kind: "tool.fail",
    tool: { ...tool, outcome: { ok: false as const } },
  } as unknown as NormalizedEvent;
}

function editTool(fp: string): ToolInfo {
  return { name: "Edit", category: "edit", fingerprint: fp, target: "src/a.ts" };
}

function execRunTool(fp: string): ToolInfo {
  return { name: "Bash", category: "exec", execKind: "run", fingerprint: fp, target: "node x" };
}

function execTestTool(fp: string): ToolInfo {
  return { name: "Bash", category: "exec", execKind: "test", fingerprint: fp, target: "npm test" };
}

function compaction(ts: number): NormalizedEvent {
  return { ...base(ts), kind: "compaction" } as NormalizedEvent;
}

describe("editEvents = false", () => {
  it("absorbs editing activity into other and never raises the editing share", () => {
    let state = lane(noEditCapabilities);
    state = applyEvent(
      state,
      toolStart(T0 + 10_000, editTool("eeeedddd11112222")),
      noEditCapabilities,
    );
    expect(state.mode.other).toBeGreaterThan(0.25);
    expect(state.mode.editing).toBeLessThanOrEqual(0.25);
    expect(
      state.reasons.some(
        (reason) => reason.signal === "mode" && reason.text.includes("edits not visible"),
      ),
    ).toBe(true);
  });

  it("keeps edit-heavy lanes out of displayed editing", () => {
    let state = lane(noEditCapabilities);
    for (let step = 0; step < 6; step += 1) {
      state = applyEvent(state, toolStart(T0 + step * 4000, editTool("eeeedddd33334444")));
    }
    state = advance(state, T0 + 5 * 4000 + 6000);
    expect(state.displayedMode).not.toBe("editing");
  });

  it("holds edit churn and edit-fail cycles at exactly zero", () => {
    // Edit churn alone: six edits of one file with no failures anywhere, so
    // the only rows that could fire are the disabled edit rows.
    let state = lane(noEditCapabilities);
    for (let step = 0; step < 6; step += 1) {
      state = applyEvent(
        state,
        toolStart(T0 + step * 1000, editTool("eeeedddd55556666")),
        noEditCapabilities,
      );
    }
    expect(state.struggle).toBe(0);
    // The edit→fail cycle detector is disabled without edits: an
    // edit, fail, edit, same-fail run still collects the ordinary exec
    // repeat-failure evidence (+0.15) but never the +0.20 cycle bonus.
    const cycleAt = T0 + 60_000;
    state = applyEvent(state, toolStart(cycleAt, editTool("eeeedddd55556666")), noEditCapabilities);
    state = applyEvent(
      state,
      toolFail(cycleAt + 1000, execTestTool("ffff000011112222")),
      noEditCapabilities,
    );
    state = applyEvent(
      state,
      toolStart(cycleAt + 2000, editTool("eeeedddd55556666")),
      noEditCapabilities,
    );
    state = applyEvent(
      state,
      toolFail(cycleAt + 3000, execTestTool("ffff000011112222")),
      noEditCapabilities,
    );
    expect(state.struggle).toBeCloseTo(0.15, 1);
    expect(
      state.reasons.some(
        (reason) => reason.signal === "struggle" && reason.text.includes("Edit, fail"),
      ),
    ).toBe(false);
    expect(
      state.reasons.some(
        (reason) => reason.signal === "struggle" && reason.text.includes("edits not visible"),
      ),
    ).toBe(true);
  });
});

describe("toolFailures = false", () => {
  it("holds failure-based struggle rows at exactly zero", () => {
    let state = lane(noFailCapabilities);
    const fp = "ffff000033334444";
    for (let step = 0; step < 5; step += 1) {
      state = applyEvent(state, toolFail(T0 + step * 1000, execRunTool(fp)), noFailCapabilities);
    }
    expect(state.struggle).toBe(0);
    expect(
      state.reasons.some(
        (reason) => reason.signal === "struggle" && reason.text.includes("failures not visible"),
      ),
    ).toBe(true);
  });

  it("keeps retry and read-loop evidence when only failures are hidden", () => {
    let state = lane(noFailCapabilities);
    const execFp = "ffff000055556666";
    state = applyEvent(state, toolStart(T0, execRunTool(execFp)), noFailCapabilities);
    state = applyEvent(state, toolStart(T0 + 1000, execRunTool(execFp)), noFailCapabilities);
    expect(state.struggle).toBeGreaterThan(0);
  });
});

describe("turnStart capability rows", () => {
  it("accepts an inferred turn.start without re-firing arrival on an active lane", () => {
    let state = lane(inferredTurnStartCapabilities);
    state = applyEvent(state, turnStart(T0), inferredTurnStartCapabilities);
    const reasonsBefore = state.reasons.length;
    const revived = applyEvent(state, inferredTurnStart(T0 + 1000), inferredTurnStartCapabilities);
    expect(revived.lifecycle).toBe("active");
    expect(revived.lifecycleConfidence).toBe("inferred");
    expect(revived.reasons.length).toBe(reasonsBefore);
  });

  it("goes idle to active on the first tool event with turnStart = none", () => {
    const state = applyEvent(
      lane(noTurnStartCapabilities),
      toolStart(T0, execRunTool("aa")),
      noTurnStartCapabilities,
    );
    expect(state.lifecycle).toBe("active");
    expect(state.lifecycleConfidence).toBe("inferred");
    expect(state.reasons.some((reason) => reason.text.includes("inferred"))).toBe(true);
  });
});

describe("turnEnd = none", () => {
  it("infers turn_complete after 120 s of post-activity silence", () => {
    const active = applyEvent(
      lane(noTurnEndCapabilities),
      toolStart(T0, execRunTool("bb")),
      noTurnEndCapabilities,
    );
    const done = advance(active, T0 + INFERRED_TURN_COMPLETE_AFTER_MS, noTurnEndCapabilities);
    expect(done.lifecycle).toBe("turn_complete");
    expect(done.lifecycleConfidence).toBe("inferred");
  });

  it("never infers turn_complete while turn ends are observed", () => {
    const active = applyEvent(lane(), toolStart(T0, execRunTool("cc")));
    expect(advance(active, T0 + INFERRED_TURN_COMPLETE_AFTER_MS).lifecycle).toBe("quiet");
  });
});

describe("waiting inference without prompt events", () => {
  function completedWithMessage(ts: number, message: string): NormalizedEvent {
    return turnEndCompleted(ts, {
      lifecycle: { reason: "completed", confidence: "observed", message },
    });
  }

  it("infers waiting from a completed turn.end whose final message ends in ?", () => {
    let state = lane(noPromptCapabilities);
    state = applyEvent(state, turnStart(T0), noPromptCapabilities);
    state = applyEvent(
      state,
      completedWithMessage(T0 + 1000, "Should I continue?"),
      noPromptCapabilities,
    );
    expect(state.lifecycle).toBe("waiting");
    expect(state.lifecycleConfidence).toBe("inferred");
    expect(state.waitingReason).toBe("question");
  });

  it("never infers waiting from a completed turn.end without a trailing ?", () => {
    let state = lane(noPromptCapabilities);
    state = applyEvent(state, turnStart(T0), noPromptCapabilities);
    state = applyEvent(state, completedWithMessage(T0 + 1000, "Done."), noPromptCapabilities);
    expect(state.lifecycle).toBe("turn_complete");
  });

  it("stays turn_complete instead of drifting to waiting after 60 s of silence", () => {
    // turn_complete rests for 20 s then decays to idle per the §Lifecycle
    // diagram; the point here is it never becomes waiting on the way —
    // neither at 60 s of silence (idle by then, not waiting) nor at
    // any earlier probe.
    let state = lane(noPromptCapabilities);
    state = applyEvent(state, turnStart(T0), noPromptCapabilities);
    state = applyEvent(state, turnEndCompleted(T0 + 1000), noPromptCapabilities);
    expect(state.lifecycle).toBe("turn_complete");
    expect(advance(state, T0 + 1000 + 10_000, noPromptCapabilities).lifecycle).toBe(
      "turn_complete",
    );
    state = advance(state, T0 + 1000 + 60_000, noPromptCapabilities);
    expect(state.lifecycle).not.toBe("waiting");
    expect(state.lifecycle).toBe("idle");
  });

  it("stays turn_complete instead of drifting to waiting at turnEnd = none too", () => {
    // The 120 s inferred turn_complete resolves to idle after its 20 s rest
    // the same way; waiting is never inferred from silence.
    const active = applyEvent(
      lane({ ...noPromptCapabilities, turnEnd: "none" }),
      toolStart(T0, execRunTool("ee")),
      { ...noPromptCapabilities, turnEnd: "none" },
    );
    const done = advance(active, T0 + INFERRED_TURN_COMPLETE_AFTER_MS, {
      ...noPromptCapabilities,
      turnEnd: "none",
    });
    expect(done.lifecycle).toBe("turn_complete");
    const rested = advance(done, T0 + INFERRED_TURN_COMPLETE_AFTER_MS + 60_000, {
      ...noPromptCapabilities,
      turnEnd: "none",
    });
    expect(rested.lifecycle).not.toBe("waiting");
  });

  it("still enters waiting on observed prompt events at full fidelity", () => {
    let state = lane();
    state = applyEvent(state, turnStart(T0));
    state = applyEvent(
      state,
      turnEndCompleted(T0 + 1000, {
        lifecycle: { reason: "question", confidence: "observed" },
      }),
    );
    expect(state.lifecycle).toBe("waiting");
    expect(state.waitingReason).toBe("question");
  });

  it("accepts an inferred question from turn.end when explicit questions are hidden", () => {
    const caps: AdapterCapabilities = { ...fullCapabilities, questionEvents: false };
    let state = lane(caps);
    state = applyEvent(state, turnStart(T0), caps);
    state = applyEvent(
      state,
      turnEndCompleted(T0 + 1000, {
        lifecycle: { reason: "question", confidence: "inferred" },
      }),
      caps,
    );
    expect(state.lifecycle).toBe("waiting");
    expect(state.lifecycleConfidence).toBe("inferred");
    expect(state.waitingReason).toBe("question");
  });

  it("ignores a denied permission.request instead of reporting waiting", () => {
    let state = lane(noPromptCapabilities);
    state = applyEvent(state, turnStart(T0), noPromptCapabilities);
    const waiting = applyEvent(
      state,
      {
        ...base(T0 + 1000),
        kind: "permission.request",
        lifecycle: { reason: "permission", confidence: "observed" },
      } as NormalizedEvent,
      noPromptCapabilities,
    );
    expect(waiting.lifecycle).toBe("active");
    expect(waiting.waitingReason).toBeUndefined();
    expect(
      waiting.reasons.some(
        (reason) =>
          reason.signal === "lifecycle" && reason.text.includes("permissions not visible"),
      ),
    ).toBe(true);
  });

  it("ignores a denied question.asked instead of reporting waiting", () => {
    let state = lane(noPromptCapabilities);
    state = applyEvent(state, turnStart(T0), noPromptCapabilities);
    const waiting = applyEvent(
      state,
      {
        ...base(T0 + 1000),
        kind: "question.asked",
        lifecycle: { reason: "question", confidence: "observed" },
      } as NormalizedEvent,
      noPromptCapabilities,
    );
    expect(waiting.lifecycle).toBe("active");
    expect(waiting.waitingReason).toBeUndefined();
    expect(
      waiting.reasons.some(
        (reason) => reason.signal === "lifecycle" && reason.text.includes("questions not visible"),
      ),
    ).toBe(true);
  });

  it("ignores observed prompt-reason turn.ends when prompts are invisible", () => {
    for (const reason of ["question", "permission", "idle_prompt"] as const) {
      let state = lane(noPromptCapabilities);
      state = applyEvent(state, turnStart(T0), noPromptCapabilities);
      const ended = applyEvent(
        state,
        turnEndCompleted(T0 + 1000, {
          lifecycle: { reason, confidence: "observed" },
        }),
        noPromptCapabilities,
      );
      expect(ended.lifecycle).toBe("active");
      expect(ended.waitingReason).toBeUndefined();
      expect(
        ended.reasons.some(
          (reasonEntry) =>
            reasonEntry.signal === "lifecycle" &&
            reasonEntry.text.includes("Waiting evidence ignored"),
        ),
      ).toBe(true);
    }
  });

  it("still honors a visible permission prompt when only questions are hidden", () => {
    const caps: AdapterCapabilities = { ...fullCapabilities, questionEvents: false };
    let state = lane(caps);
    state = applyEvent(state, turnStart(T0), caps);
    const waiting = applyEvent(
      state,
      {
        ...base(T0 + 1000),
        kind: "permission.request",
        lifecycle: { reason: "permission", confidence: "observed" },
      } as NormalizedEvent,
      caps,
    );
    expect(waiting.lifecycle).toBe("waiting");
    expect(waiting.waitingReason).toBe("permission");
  });
});

describe("compaction = false", () => {
  it("leaves the lane untouched on compaction and keeps long silences quiet only", () => {
    const active = applyEvent(
      lane(noCompactionCapabilities),
      turnStart(T0),
      noCompactionCapabilities,
    );
    const compacted = applyEvent(active, compaction(T0 + 1000), noCompactionCapabilities);
    expect(compacted.lifecycle).toBe("active");
    expect(compacted.reasons).toEqual(active.reasons);
    const quiet = advance(active, T0 + QUIET_AFTER_MS, noCompactionCapabilities);
    expect(quiet.lifecycle).toBe("quiet");
    // With compaction = false a long silence stays quiet only: the lane
    // never goes stale, so there is no stale reason either.
    const longSilence = advance(quiet, T0 + STALE_AFTER_MS, noCompactionCapabilities);
    expect(longSilence.lifecycle).toBe("quiet");
    expect(
      longSilence.reasons.some(
        (reason) => reason.signal === "lifecycle" && reason.text.includes("stale"),
      ),
    ).toBe(false);
  });

  it("still goes stale after a long silence when compaction is visible", () => {
    const active = applyEvent(lane(), turnStart(T0));
    const quiet = advance(active, T0 + QUIET_AFTER_MS);
    const stale = advance(quiet, T0 + STALE_AFTER_MS);
    expect(stale.lifecycle).toBe("stale");
  });

  it("quiets the lane on compaction when compaction is visible", () => {
    const active = applyEvent(lane(), turnStart(T0));
    expect(applyEvent(active, compaction(T0 + 1000)).lifecycle).toBe("quiet");
  });
});

describe("exact-zero disabled struggle invariant", () => {
  it("holds struggle at exactly zero across a mixed disabled-evidence trajectory", () => {
    const caps: AdapterCapabilities = {
      ...fullCapabilities,
      editEvents: false,
      toolFailures: false,
    };
    let state = lane(caps);
    for (const [at, event] of [
      [T0, toolStart(T0, editTool("aa00112233445566"))],
      [T0 + 1000, toolStart(T0 + 1000, editTool("aa00112233445566"))],
      [T0 + 2000, toolFail(T0 + 2000, execRunTool("bb00112233445566"))],
      [T0 + 3000, toolStart(T0 + 3000, editTool("aa00112233445566"))],
      [T0 + 4000, toolFail(T0 + 4000, execRunTool("bb00112233445566"))],
      [T0 + 5000, toolStart(T0 + 5000, editTool("aa00112233445566"))],
      [T0 + 6000, toolFail(T0 + 6000, execTestTool("cc00112233445566"))],
      [T0 + 7000, toolStart(T0 + 7000, editTool("aa00112233445566"))],
      [T0 + 8000, toolFail(T0 + 8000, execTestTool("cc00112233445566"))],
    ] as const) {
      state = applyEvent(state, event, caps);
      expect(state.struggle).toBe(0);
      void at;
    }
    state = advance(state, T0 + 9000, caps);
    expect(state.struggle).toBe(0);
  });
});

describe("confidence labelling", () => {
  it("marks engine timeouts inferred and observed events observed", () => {
    const quiet = advance(applyEvent(lane(), turnStart(T0)), T0 + QUIET_AFTER_MS);
    expect(quiet.lifecycleConfidence).toBe("inferred");
    const revived = applyEvent(quiet, toolStart(T0 + QUIET_AFTER_MS + 1000, execRunTool("dd")));
    expect(revived.lifecycleConfidence).toBe("observed");
  });

  it("carries the inferred marking from inferred events", () => {
    const state = applyEvent(lane(), inferredTurnStart(T0));
    expect(state.lifecycleConfidence).toBe("inferred");
  });
});

describe("reasons", () => {
  it("names the fingerprint, count and window on struggle increments", () => {
    let state = lane();
    const fp = "ffff000077778888";
    state = applyEvent(state, toolFail(T0, execRunTool(fp)));
    state = applyEvent(state, toolFail(T0 + 1000, execRunTool(fp)));
    const latest = state.reasons[0];
    expect(latest?.signal).toBe("struggle");
    expect(latest?.delta).toBeCloseTo(0.15, 5);
    expect(latest?.text).toMatch(/failed again/);
    expect(latest?.text).toMatch(/2 times in 10 min/);
  });

  it("keeps reasons newest-first and capped at 20", () => {
    let state = lane();
    const fp = "ffff00009999aaaa";
    for (let step = 0; step < 30; step += 1) {
      const at = T0 + step * 1000;
      state = applyEvent(state, toolStart(at, execRunTool(fp)));
      state = applyEvent(state, toolFail(at + 10, execRunTool(fp)));
    }
    expect(state.reasons.length).toBeLessThanOrEqual(MAX_REASONS);
    expect(state.reasons.length).toBe(MAX_REASONS);
    for (let index = 1; index < state.reasons.length; index += 1) {
      const newer = state.reasons[index - 1]?.at ?? 0;
      const older = state.reasons[index]?.at ?? 0;
      expect(newer).toBeGreaterThanOrEqual(older);
    }
  });
});

describe("fidelity summary", () => {
  it("is null at full fidelity and plain words for degraded lanes", () => {
    expect(lane().fidelity).toBeNull();
    const degraded = lane({
      ...fullCapabilities,
      editEvents: false,
      permissionEvents: false,
      questionEvents: false,
    });
    expect(degraded.fidelity).toBe("edits and questions not visible");
  });

  it("does not list inferred turn starts or ends as invisible", () => {
    const inferredStarts = lane({ ...fullCapabilities, turnStart: "inferred" });
    expect(inferredStarts.fidelity).toBeNull();
    const inferredEnds = lane({ ...fullCapabilities, turnEnd: "inferred" });
    expect(inferredEnds.fidelity).toBeNull();
    const inferredBoth = lane({
      ...fullCapabilities,
      turnStart: "inferred",
      turnEnd: "inferred",
    });
    expect(inferredBoth.fidelity).toBeNull();
  });

  it("lists missing turn starts and ends as unavailable", () => {
    const noStarts = lane({ ...fullCapabilities, turnStart: "none" });
    expect(noStarts.fidelity).toBe("turn starts not visible");
    const noEnds = lane({ ...fullCapabilities, turnEnd: "none" });
    expect(noEnds.fidelity).toBe("turn ends not visible");
  });

  it("derives from capabilities, not from agent identity", () => {
    const caps = { ...fullCapabilities, editEvents: false };
    expect(lane(caps, "codex").fidelity).toBe(lane(caps, "opencode").fidelity);
  });
});

describe("agent-blind inference", () => {
  it("produces identical states for identical sequences and capabilities across agents", () => {
    const caps = { ...fullCapabilities, editEvents: false, turnEnd: "none" as const };
    const sequence = (agent: AgentId): NormalizedEvent[] => [
      { ...base(T0), agent, kind: "turn.start" } as NormalizedEvent,
      {
        ...base(T0 + 1000),
        agent,
        kind: "tool.start",
        tool: editTool("zz00112233445566"),
      } as NormalizedEvent,
      {
        ...base(T0 + 2000),
        agent,
        kind: "tool.fail",
        tool: { ...execRunTool("yy00112233445566"), outcome: { ok: false as const } },
      } as unknown as NormalizedEvent,
      { ...base(T0 + 3000), agent, kind: "compaction" } as NormalizedEvent,
    ];
    const run = (agent: AgentId): LaneState => {
      let state = lane(caps, agent);
      for (const event of sequence(agent)) state = applyEvent(state, event, caps);
      return advance(state, T0 + 4000, caps);
    };
    const first = run("codex");
    const second = run("opencode");
    expect({
      ...second,
      laneId: first.laneId,
      sessionId: first.sessionId,
      agent: first.agent,
    }).toEqual({
      ...first,
    });
  });
});
