// packages/core/test/engine/mode.test.ts — behaviour tests for the
// docs/STATE_ENGINE.md §Mode blend: the per-category EMA update, the tool
// mapping table (including execKind routing), subagent half-weighting, both
// hysteresis conditions (0.15 margin, 5 s hold, at most one switch per 5 s),
// the sum-to-one invariant, and the interleaved read-between-edits flicker
// scenario plus its sustained-testing counterpart. These tests must stay
// inside core and rely on no adapter; capability gating beyond the weight
// read belongs to p2-t04.

import { describe, expect, it } from "vitest";
import {
  blendModeWeights,
  emaFactor,
  MODE_SUBAGENT_WEIGHT,
  MODE_SWITCH_HOLD_MS,
  MODE_SWITCH_MARGIN,
  MODE_TAU_MS,
  MODE_UNCERTAIN_OTHER_WEIGHT,
} from "../../src/engine/index.js";
import {
  type AdapterCapabilities,
  type AgentId,
  advance,
  applyEvent,
  createLane,
  type DisplayedMode,
  type LaneState,
  type NormalizedEvent,
  SCHEMA_VERSION,
  type ToolInfo,
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

const typedCapabilities: AdapterCapabilities = { ...fullCapabilities, toolKinds: "typed" };

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

function toolStart(
  ts: number,
  tool: ToolInfo,
  extra: Record<string, unknown> = {},
): NormalizedEvent {
  nextId += 1;
  return {
    v: SCHEMA_VERSION,
    id: `mode-test-${nextId}`,
    ts,
    receivedAt: ts,
    agent: "claude-code",
    sessionId: "s1",
    kind: "tool.start",
    tool,
    ...extra,
  } as NormalizedEvent;
}

function toolFor(category: ToolInfo["category"], name = "Tool"): ToolInfo {
  return { name, category, fingerprint: "aaaabbbbccccdddd" };
}

function execTool(execKind: NonNullable<ToolInfo["execKind"]>): ToolInfo {
  return { name: "Bash", category: "exec", execKind, fingerprint: "eeeeffff00001111" };
}

function modeSum(state: LaneState): number {
  return state.mode.exploring + state.mode.editing + state.mode.testing + state.mode.other;
}

describe("EMA update", () => {
  it("leaves the blend untouched on the first tool event (Δt = 0)", () => {
    const state = applyEvent(lane(), toolStart(T0, toolFor("edit", "Edit")));
    expect(state.mode).toEqual({ exploring: 0.25, editing: 0.25, testing: 0.25, other: 0.25 });
  });

  it("blends the tool's category by 1 − exp(−Δt/τ) with the others at 0", () => {
    const dt = 10_000;
    const afterFirst = applyEvent(lane(), toolStart(T0, toolFor("edit", "Edit")));
    const state = applyEvent(afterFirst, toolStart(T0 + dt, toolFor("edit", "Edit")));
    const alpha = 1 - Math.exp(-dt / MODE_TAU_MS);
    expect(state.mode.editing).toBeCloseTo(
      blendModeWeights(
        { exploring: 0.25, editing: 0.25, testing: 0.25, other: 0.25 },
        "editing",
        alpha,
      ).editing,
      12,
    );
    expect(state.mode.editing).toBeGreaterThan(0.25);
    expect(state.mode.exploring).toBeLessThan(0.25);
  });

  it("builds editing dominance over a sustained edit stretch", () => {
    let state = lane();
    for (let step = 0; step < 12; step += 1) {
      state = applyEvent(state, toolStart(T0 + step * 2000, toolFor("edit", "Edit")));
    }
    expect(state.mode.editing).toBeGreaterThan(0.6);
    expect(state.mode.exploring).toBeLessThan(0.15);
    expect(state.mode.testing).toBeLessThan(0.15);
  });

  it("ignores non-tool events for the blend but re-evaluates the display", () => {
    let state = lane();
    for (let step = 0; step < 12; step += 1) {
      state = applyEvent(state, toolStart(T0 + step * 2000, toolFor("edit", "Edit")));
    }
    const weights = state.mode;
    const later = applyEvent(state, {
      v: SCHEMA_VERSION,
      id: "mode-test-note",
      ts: T0 + 12 * 2000 + 1000,
      receivedAt: T0 + 12 * 2000 + 1000,
      agent: "claude-code",
      sessionId: "s1",
      kind: "notification",
      meta: { kind: "streaming" },
    } as NormalizedEvent);
    expect(later.mode).toEqual(weights);
  });
});

describe("category mapping", () => {
  const rows: { category: ToolInfo["category"]; expected: DisplayedMode }[] = [
    { category: "read", expected: "exploring" },
    { category: "search", expected: "exploring" },
    { category: "web", expected: "exploring" },
    { category: "edit", expected: "editing" },
    { category: "other", expected: "other" },
  ];

  for (const { category, expected } of rows) {
    it(`routes ${category} tools to ${expected}`, () => {
      // A lone same-category stretch tilts the blend toward its bucket.
      let state = lane();
      for (let step = 0; step < 20; step += 1) {
        state = applyEvent(state, toolStart(T0 + step * 2000, toolFor(category)));
      }
      expect(state.mode[expected]).toBeGreaterThan(0.5);
    });
  }

  it("routes test, build and lint execs to testing", () => {
    for (const execKind of ["test", "build", "lint"] as const) {
      let state = lane();
      for (let step = 0; step < 20; step += 1) {
        state = applyEvent(state, toolStart(T0 + step * 2000, execTool(execKind)));
      }
      expect(state.mode.testing).toBeGreaterThan(0.5);
    }
  });

  it("routes run, git, install and other execs to other", () => {
    for (const execKind of ["run", "git", "install", "other"] as const) {
      let state = lane();
      for (let step = 0; step < 20; step += 1) {
        state = applyEvent(state, toolStart(T0 + step * 2000, execTool(execKind)));
      }
      expect(state.mode.other).toBeGreaterThan(0.5);
    }
  });

  it("treats an exec tool with no execKind as other", () => {
    let state = lane();
    for (let step = 0; step < 20; step += 1) {
      state = applyEvent(
        state,
        toolStart(T0 + step * 2000, {
          name: "Bash",
          category: "exec",
          fingerprint: "eeeeffff00001111",
        }),
      );
    }
    expect(state.mode.other).toBeGreaterThan(0.5);
  });

  it("reads the given kind at full weight when toolKinds is typed", () => {
    const dt = 10_000;
    const byName = applyEvent(
      applyEvent(lane(), toolStart(T0, toolFor("other", "TodoWrite"))),
      toolStart(T0 + dt, toolFor("other", "TodoWrite")),
    );
    const typed = applyEvent(
      lane({ capabilities: typedCapabilities }),
      toolStart(T0, toolFor("other", "mcp__x__y")),
      typedCapabilities,
    );
    const typedNext = applyEvent(
      typed,
      toolStart(T0 + dt, toolFor("other", "mcp__x__y")),
      typedCapabilities,
    );
    // Typed sources state the kind outright, so the blend moves the full
    // factor; byName `other` is an uncertain guess and moves half as far.
    const full = 1 - Math.exp(-dt / MODE_TAU_MS);
    expect(typedNext.mode.other).toBeCloseTo(0.25 + full * 0.75, 10);
    expect(byName.mode.other).toBeCloseTo(0.25 + (full / 2) * 0.75, 10);
    expect(typedNext.mode.other).toBeGreaterThan(byName.mode.other);
  });
});

describe("subagent weighting", () => {
  it("moves a subagent tool event half as far as a parent one", () => {
    const dt = 10_000;
    const parent = applyEvent(
      applyEvent(lane(), toolStart(T0, toolFor("edit", "Edit"))),
      toolStart(T0 + dt, toolFor("edit", "Edit")),
    );
    const subagent = applyEvent(
      applyEvent(lane(), toolStart(T0, toolFor("edit", "Edit"))),
      toolStart(T0 + dt, toolFor("edit", "Edit"), {
        sessionId: "sub1",
        parentSessionId: "s1",
      }),
    );
    const full = 1 - Math.exp(-dt / MODE_TAU_MS);
    const fullTarget = 0.25 + full * 0.75;
    const halfTarget = 0.25 + (full / 2) * 0.75;
    expect(parent.mode.editing).toBeCloseTo(fullTarget, 10);
    expect(subagent.mode.editing).toBeCloseTo(halfTarget, 10);
    expect(subagent.sessionId).toBe("s1");
  });
});

describe("displayed-mode hysteresis", () => {
  it("holds the display while a fresh challenger waits out the 5 s hold", () => {
    // Three edits already push editing past the margin, but the challenger
    // has only just appeared: the 5 s hold has not matured, so the display
    // stays put.
    let state = lane();
    for (let step = 0; step < 3; step += 1) {
      state = applyEvent(state, toolStart(T0 + step * 2000, toolFor("edit", "Edit")));
    }
    expect(state.displayedMode).toBe("other");
    expect(state.mode.editing - state.mode.other).toBeGreaterThanOrEqual(MODE_SWITCH_MARGIN);
    expect(state.internal.modeChallenger).toBe("editing");
  });

  it("stays below the margin on a single edit, tracking no challenger", () => {
    let state = lane();
    state = applyEvent(state, toolStart(T0, toolFor("edit", "Edit")));
    state = applyEvent(state, toolStart(T0 + 2000, toolFor("edit", "Edit")));
    expect(state.displayedMode).toBe("other");
    expect(state.mode.editing - state.mode.other).toBeLessThan(MODE_SWITCH_MARGIN);
    expect(state.internal.modeChallenger).toBeNull();
  });

  it("switches once the margin has held for ≥ 5 s", () => {
    let state = lane();
    for (let step = 0; step < 6; step += 1) {
      state = applyEvent(state, toolStart(T0 + step * 2000, toolFor("edit", "Edit")));
    }
    // Editing now leads by the margin and has since step 2; the hold matures
    // and the display flips with a reason.
    expect(state.displayedMode).toBe("editing");
    expect(state.reasons[0]?.signal).toBe("mode");
    expect(state.reasons[0]?.text).toMatch(/editing/);
  });

  it("does not switch while the margin lapses, even after 5 s", () => {
    // Interleaved reads keep editing from ever holding the margin.
    let state = lane();
    const kinds = ["edit", "read", "edit", "read", "edit", "read"] as const;
    kinds.forEach((category, step) => {
      state = applyEvent(state, toolStart(T0 + step * 1000, toolFor(category)));
    });
    const held = advance(state, T0 + 6000 + MODE_SWITCH_HOLD_MS);
    expect(held.displayedMode).toBe("other");
  });

  it("changes at most once per 5 s even when the lead flips", () => {
    let state = lane();
    for (let step = 0; step < 6; step += 1) {
      state = applyEvent(state, toolStart(T0 + step * 2000, toolFor("edit", "Edit")));
    }
    expect(state.displayedMode).toBe("editing");
    const firstSwitchAt = state.internal.modeSwitchedAt;
    // A testing burst immediately after cannot flip again until the rate
    // limit expires: every pair of switches stays ≥ 5 s apart.
    const switches: number[] = [];
    let cursor = state;
    for (let step = 0; step < 20; step += 1) {
      const at = firstSwitchAt + 1000 + step * 500;
      const before = cursor.displayedMode;
      cursor = applyEvent(cursor, toolStart(at, execTool("test")));
      if (cursor.displayedMode !== before) switches.push(at);
    }
    for (let index = 1; index < switches.length; index += 1) {
      expect((switches[index] as number) - (switches[index - 1] as number)).toBeGreaterThanOrEqual(
        MODE_SWITCH_HOLD_MS,
      );
    }
    expect(switches.length).toBeLessThanOrEqual(1);
  });

  it("matures the hold in advance with no further events", () => {
    let state = lane();
    for (let step = 0; step < 3; step += 1) {
      state = applyEvent(state, toolStart(T0 + step * 2000, toolFor("edit", "Edit")));
    }
    expect(state.displayedMode).toBe("other");
    expect(state.internal.modeChallenger).toBe("editing");
    // Silence moves the 5 s hold forward without moving the weights.
    const since = state.internal.modeChallengerSince;
    expect(since).not.toBeNull();
    const matured = advance(state, (since as number) + MODE_SWITCH_HOLD_MS);
    expect(matured.displayedMode).toBe("editing");
    expect(matured.mode).toEqual(state.mode);
  });
});

describe("sum-to-one invariant", () => {
  it("keeps the weights summing to 1 ± 1e-6 after any sequence", () => {
    const script: ToolInfo[] = [
      toolFor("read", "Read"),
      toolFor("edit", "Edit"),
      execTool("test"),
      toolFor("search", "Grep"),
      toolFor("web", "WebFetch"),
      execTool("run"),
      toolFor("other", "TodoWrite"),
      toolFor("edit", "Edit"),
    ];
    let state = lane();
    script.forEach((tool, step) => {
      state = applyEvent(state, toolStart(T0 + step * 1370, tool));
      expect(Math.abs(modeSum(state) - 1)).toBeLessThanOrEqual(1e-6);
      const settled = advance(state, T0 + step * 1370 + 610);
      expect(Math.abs(modeSum(settled) - 1)).toBeLessThanOrEqual(1e-6);
    });
  });
});

describe("flicker scenario", () => {
  it("keeps displayedMode = editing through interleaved reads", () => {
    let state = lane();
    // Establish editing first.
    for (let step = 0; step < 8; step += 1) {
      state = applyEvent(state, toolStart(T0 + step * 2000, toolFor("edit", "Edit")));
    }
    expect(state.displayedMode).toBe("editing");
    // Then interleave a read between every edit: the blend wobbles, the
    // display never flickers.
    const seen: DisplayedMode[] = [state.displayedMode];
    for (let step = 0; step < 10; step += 1) {
      const tool = step % 2 === 0 ? toolFor("read", "Read") : toolFor("edit", "Edit");
      state = applyEvent(state, toolStart(T0 + 16_000 + step * 1500, tool));
      seen.push(state.displayedMode);
    }
    expect(seen.every((mode) => mode === "editing")).toBe(true);
  });

  it("flips exactly once on a sustained testing stretch", () => {
    let state = lane();
    for (let step = 0; step < 8; step += 1) {
      state = applyEvent(state, toolStart(T0 + step * 2000, toolFor("edit", "Edit")));
    }
    expect(state.displayedMode).toBe("editing");
    let switches = 0;
    let previous = state.displayedMode;
    for (let step = 0; step < 24; step += 1) {
      state = applyEvent(state, toolStart(T0 + 16_000 + step * 2000, execTool("test")));
      if (state.displayedMode !== previous) {
        switches += 1;
        previous = state.displayedMode;
      }
    }
    expect(state.displayedMode).toBe("testing");
    expect(switches).toBe(1);
  });
});

describe("tuning constants", () => {
  it("keeps τ = 20 s, the 0.15 margin, the 5 s hold and the weights in tuning.ts", () => {
    expect(MODE_TAU_MS).toBe(20_000);
    expect(MODE_SWITCH_MARGIN).toBe(0.15);
    expect(MODE_SWITCH_HOLD_MS).toBe(5_000);
    expect(MODE_SUBAGENT_WEIGHT).toBe(0.5);
    expect(MODE_UNCERTAIN_OTHER_WEIGHT).toBe(0.5);
  });

  it("uses the documented blend factor shape", () => {
    expect(emaFactor(0)).toBe(0);
    expect(emaFactor(MODE_TAU_MS)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(emaFactor(-100)).toBe(0);
  });
});
