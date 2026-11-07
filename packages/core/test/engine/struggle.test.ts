// packages/core/test/engine/struggle.test.ts — behaviour tests for the
// docs/STATE_ENGINE.md §Struggle (Tier 1) and §Progress counter-evidence: all
// seven struggle rows with their weights and windows, the novelty progress
// integrator with its five rows, the 1.5× relief and turn-complete cap, the
// 0.6/0.4 hysteresis, the decay math, and invariant 1. Synthetic sequences
// only; no tuning against real fixtures (calibration is p2-t09).

import { describe, expect, it } from "vitest";
import {
  advance,
  applyEvent,
  createLane,
  decayProgressValue,
  decayStruggleValue,
  PROGRESS_FIRST_GREEN_WEIGHT,
  PROGRESS_NEW_COMMAND_WEIGHT,
  PROGRESS_NEW_FILE_WEIGHT,
  PROGRESS_STRUGGLE_RELIEF,
  PROGRESS_TAU_MS,
  PROGRESS_TEST_SUMMARY_WEIGHT,
  PROGRESS_TURN_COMPLETE_STRUGGLE_CAP,
  PROGRESS_TURN_COMPLETE_WEIGHT,
  STRUGGLE_ATTENTION_THRESHOLD,
  STRUGGLE_EDIT_CHURN_WEIGHT,
  STRUGGLE_EDIT_CHURN_WINDOW_MS,
  STRUGGLE_EDIT_HEAVY_WEIGHT,
  STRUGGLE_FAIL_CYCLE_WEIGHT,
  STRUGGLE_FAIL_CYCLE_WINDOW_MS,
  STRUGGLE_FOURTH_FAIL_WEIGHT,
  STRUGGLE_HALF_LIFE_MS,
  STRUGGLE_MEMORY_WINDOW_MS,
  STRUGGLE_NO_EDIT_REPEAT_WEIGHT,
  STRUGGLE_NO_EDIT_REPEAT_WINDOW_MS,
  STRUGGLE_READ_LOOP_WEIGHT,
  STRUGGLE_READ_LOOP_WINDOW_MS,
  STRUGGLE_REARM_THRESHOLD,
  STRUGGLE_REPEAT_FAIL_WEIGHT,
  STRUGGLE_REPEAT_FAIL_WINDOW_MS,
} from "../../src/engine/index.js";
import {
  type AdapterCapabilities,
  type AgentId,
  type LaneState,
  type NormalizedEvent,
  SCHEMA_VERSION,
  type ToolInfo,
} from "../../src/index.js";

const T0 = 1_758_000_000_000;

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
function base(ts: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  nextId += 1;
  return {
    v: SCHEMA_VERSION,
    id: `struggle-test-${nextId}`,
    ts,
    receivedAt: ts,
    agent: "claude-code",
    sessionId: "s1",
    ...extra,
  };
}

function toolStart(ts: number, tool: ToolInfo): NormalizedEvent {
  return { ...base(ts), kind: "tool.start", tool } as NormalizedEvent;
}

function toolFail(
  ts: number,
  tool: ToolInfo & { outcome: { ok: false; testSummary?: { failed?: number } } },
): NormalizedEvent {
  return { ...base(ts), kind: "tool.fail", tool } as unknown as NormalizedEvent;
}

function toolEnd(
  ts: number,
  tool: ToolInfo & { outcome: { ok: true; testSummary?: { failed?: number } } },
): NormalizedEvent {
  return { ...base(ts), kind: "tool.end", tool } as unknown as NormalizedEvent;
}

function turnEndCompleted(ts: number): NormalizedEvent {
  return {
    ...base(ts),
    kind: "turn.end",
    lifecycle: { reason: "completed", confidence: "observed" },
  } as NormalizedEvent;
}

function turnStart(ts: number): NormalizedEvent {
  return { ...base(ts), kind: "turn.start" } as NormalizedEvent;
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

function readTool(fp: string): ToolInfo {
  return { name: "Read", category: "read", fingerprint: fp, target: "src/a.ts" };
}

function failOf(tool: ToolInfo): ToolInfo & { outcome: { ok: false } } {
  return { ...tool, outcome: { ok: false as const } };
}

function struggleReasons(state: LaneState): string[] {
  return state.reasons.filter((r) => r.signal === "struggle").map((r) => r.text);
}

describe("tuning constants", () => {
  it("keeps every documented weight, window, half-life, threshold and multiplier in tuning.ts", () => {
    expect(STRUGGLE_REPEAT_FAIL_WEIGHT).toBe(0.15);
    expect(STRUGGLE_REPEAT_FAIL_WINDOW_MS).toBe(600_000);
    expect(STRUGGLE_FOURTH_FAIL_WEIGHT).toBe(0.25);
    expect(STRUGGLE_EDIT_CHURN_WEIGHT).toBe(0.1);
    expect(STRUGGLE_EDIT_CHURN_WINDOW_MS).toBe(300_000);
    expect(STRUGGLE_EDIT_HEAVY_WEIGHT).toBe(0.2);
    expect(STRUGGLE_NO_EDIT_REPEAT_WEIGHT).toBe(0.1);
    expect(STRUGGLE_NO_EDIT_REPEAT_WINDOW_MS).toBe(180_000);
    expect(STRUGGLE_FAIL_CYCLE_WEIGHT).toBe(0.2);
    expect(STRUGGLE_FAIL_CYCLE_WINDOW_MS).toBe(900_000);
    expect(STRUGGLE_READ_LOOP_WEIGHT).toBe(0.05);
    expect(STRUGGLE_READ_LOOP_WINDOW_MS).toBe(300_000);
    expect(STRUGGLE_HALF_LIFE_MS).toBe(600_000);
    expect(STRUGGLE_MEMORY_WINDOW_MS).toBe(900_000);
    expect(STRUGGLE_ATTENTION_THRESHOLD).toBe(0.6);
    expect(STRUGGLE_REARM_THRESHOLD).toBe(0.4);
    expect(PROGRESS_TAU_MS).toBe(180_000);
    expect(PROGRESS_NEW_FILE_WEIGHT).toBe(0.1);
    expect(PROGRESS_NEW_COMMAND_WEIGHT).toBe(0.05);
    expect(PROGRESS_FIRST_GREEN_WEIGHT).toBe(0.3);
    expect(PROGRESS_TEST_SUMMARY_WEIGHT).toBe(0.2);
    expect(PROGRESS_TURN_COMPLETE_WEIGHT).toBe(0.2);
    expect(PROGRESS_STRUGGLE_RELIEF).toBe(1.5);
    expect(PROGRESS_TURN_COMPLETE_STRUGGLE_CAP).toBe(0.2);
  });
});

describe("Tier-1 struggle rows", () => {
  it("adds +0.15 per same-exec repeat after the first within 10 min", () => {
    const fp = "eeeeffff00002222";
    let state = lane();
    state = applyEvent(state, toolFail(T0, failOf(execRunTool(fp))));
    expect(state.struggle).toBe(0);
    state = applyEvent(state, toolFail(T0 + 1000, failOf(execRunTool(fp))));
    expect(state.struggle).toBeCloseTo(0.15, 2);
    expect(struggleReasons(state).some((t) => t.includes("failed again"))).toBe(true);
    state = applyEvent(state, toolFail(T0 + 2000, failOf(execRunTool(fp))));
    expect(state.struggle).toBeCloseTo(0.3, 1);
  });

  it("ignores repeats outside the 10 min failure window", () => {
    const fp = "eeeeffff00003333";
    let state = lane();
    state = applyEvent(state, toolFail(T0, failOf(execRunTool(fp))));
    state = applyEvent(
      state,
      toolFail(T0 + STRUGGLE_REPEAT_FAIL_WINDOW_MS + 1000, failOf(execRunTool(fp))),
    );
    expect(state.struggle).toBe(0);
  });

  it("adds +0.25 per repeat from the 4th failure on top of the base row", () => {
    const fp = "eeeeffff00004444";
    let state = lane();
    for (let step = 0; step < 4; step += 1) {
      state = applyEvent(state, toolFail(T0 + step * 1000, failOf(execRunTool(fp))));
    }
    // 2nd +0.15, 3rd +0.15, 4th +0.15 +0.25 = 0.70 before decay.
    expect(state.struggle).toBeGreaterThan(0.6);
    expect(state.struggle).toBeLessThanOrEqual(0.71);
    expect(struggleReasons(state).some((t) => t.includes("4th time"))).toBe(true);
  });

  it("never applies exec-failure rows to failing edits or reads", () => {
    let state = lane();
    for (let step = 0; step < 4; step += 1) {
      state = applyEvent(state, toolFail(T0 + step * 1000, failOf(editTool("aaaabbbbcccc0050"))));
    }
    expect(struggleReasons(state).some((t) => t.includes("failed again"))).toBe(false);
    expect(struggleReasons(state).some((t) => t.includes("4th time"))).toBe(false);
    let reading = lane();
    for (let step = 0; step < 4; step += 1) {
      reading = applyEvent(
        reading,
        toolFail(T0 + step * 1000, failOf(readTool("aaaabbbbcccc0051"))),
      );
    }
    expect(struggleReasons(reading).some((t) => t.includes("failed again"))).toBe(false);
    expect(reading.struggle).toBe(0);
  });

  it("adds +0.10 per same-file edit beyond the 2nd within 5 min", () => {
    const fp = "aaaabbbbcccc0001";
    let state = lane();
    state = applyEvent(state, toolStart(T0, editTool(fp)));
    state = applyEvent(state, toolStart(T0 + 1000, editTool(fp)));
    expect(state.struggle).toBe(0);
    state = applyEvent(state, toolStart(T0 + 2000, editTool(fp)));
    expect(state.struggle).toBeCloseTo(STRUGGLE_EDIT_CHURN_WEIGHT, 2);
  });

  it("adds +0.20 per same-file edit beyond the 5th on top of the base row", () => {
    const fp = "aaaabbbbcccc0002";
    let state = lane();
    for (let step = 0; step < 6; step += 1) {
      state = applyEvent(state, toolStart(T0 + step * 1000, editTool(fp)));
    }
    // Edits 3,4,5 each +0.10; 6th +0.10 +0.20 = 0.60 before decay.
    expect(state.struggle).toBeGreaterThan(0.5);
    expect(state.struggle).toBeLessThanOrEqual(0.61);
  });

  it("ignores same-file edits outside the 5 min churn window", () => {
    const fp = "aaaabbbbcccc0003";
    let state = lane();
    state = applyEvent(state, toolStart(T0, editTool(fp)));
    state = applyEvent(state, toolStart(T0 + 1000, editTool(fp)));
    state = applyEvent(state, toolStart(T0 + STRUGGLE_EDIT_CHURN_WINDOW_MS + 2000, editTool(fp)));
    expect(state.struggle).toBe(0);
  });

  it("adds +0.10 for an identical exec with no edit in between within 3 min", () => {
    const fp = "eeeeffff00005555";
    let state = lane();
    state = applyEvent(state, toolStart(T0, execRunTool(fp)));
    const afterSecond = applyEvent(state, toolStart(T0 + 1000, execRunTool(fp)));
    expect(afterSecond.struggle).toBeGreaterThan(0);
    expect(afterSecond.struggle).toBeCloseTo(STRUGGLE_NO_EDIT_REPEAT_WEIGHT, 1);
  });

  it("does not fire the no-edit row when an edit lands between the runs", () => {
    const fp = "eeeeffff00006666";
    let state = lane();
    state = applyEvent(state, toolStart(T0, execRunTool(fp)));
    state = applyEvent(state, toolStart(T0 + 1000, editTool("aaaabbbbcccc0009")));
    const before = state.struggle;
    state = applyEvent(state, toolStart(T0 + 2000, execRunTool(fp)));
    // Only novelty relief moved struggle between the two execs, clamped at 0.
    expect(state.struggle).toBe(before);
    expect(struggleReasons(state).some((t) => t.includes("no edit"))).toBe(false);
  });

  it("does not fire the no-edit row outside the 3 min window", () => {
    const fp = "eeeeffff00007777";
    let state = lane();
    state = applyEvent(state, toolStart(T0, execRunTool(fp)));
    state = applyEvent(
      state,
      toolStart(T0 + STRUGGLE_NO_EDIT_REPEAT_WINDOW_MS + 1000, execRunTool(fp)),
    );
    expect(struggleReasons(state).some((t) => t.includes("no edit"))).toBe(false);
  });

  it("adds +0.20 per edit→fail→edit→same-fail cycle within 15 min", () => {
    const fp = "eeeeffff00008888";
    let state = lane();
    state = applyEvent(state, toolStart(T0, editTool("aaaabbbbcccc0010")));
    state = applyEvent(state, toolFail(T0 + 1000, failOf(execTestTool(fp))));
    state = applyEvent(state, toolStart(T0 + 2000, editTool("aaaabbbbcccc0010")));
    const before = state.struggle;
    state = applyEvent(state, toolFail(T0 + 3000, failOf(execTestTool(fp))));
    expect(state.struggle).toBeGreaterThan(before);
    expect(struggleReasons(state).some((t) => t.includes("Edit, fail"))).toBe(true);
  });

  it("does not complete the cycle when the second failure differs", () => {
    const fp = "eeeeffff00009999";
    let state = lane();
    state = applyEvent(state, toolStart(T0, editTool("aaaabbbbcccc0011")));
    state = applyEvent(state, toolFail(T0 + 1000, failOf(execTestTool(fp))));
    state = applyEvent(state, toolStart(T0 + 2000, editTool("aaaabbbbcccc0011")));
    state = applyEvent(state, toolFail(T0 + 3000, failOf(execTestTool("eeeeffff00001010"))));
    expect(struggleReasons(state).some((t) => t.includes("Edit, fail"))).toBe(false);
  });

  it("adds +0.05 per same read/search beyond the 3rd within 5 min", () => {
    const fp = "aaaabbbbcccc0012";
    let state = lane();
    for (let step = 0; step < 3; step += 1) {
      state = applyEvent(state, toolStart(T0 + step * 1000, readTool(fp)));
    }
    expect(state.struggle).toBe(0);
    state = applyEvent(state, toolStart(T0 + 3000, readTool(fp)));
    expect(state.struggle).toBeCloseTo(STRUGGLE_READ_LOOP_WEIGHT, 2);
    state = applyEvent(state, toolStart(T0 + 4000, { ...readTool(fp), category: "search" }));
    // Search shares the read loop keyed by fingerprint, so a fifth repeat adds again.
    expect(state.struggle).toBeCloseTo(2 * STRUGGLE_READ_LOOP_WEIGHT, 1);
  });

  it("clamps struggle to [0, 1] under a long failure burst", () => {
    const fp = "eeeeffff00001111";
    let state = lane();
    for (let step = 0; step < 30; step += 1) {
      state = applyEvent(state, toolFail(T0 + step * 1000, failOf(execRunTool(fp))));
      expect(state.struggle).toBeGreaterThanOrEqual(0);
      expect(state.struggle).toBeLessThanOrEqual(1);
    }
    expect(state.struggle).toBe(1);
  });
});

describe("progress integrator and counter-evidence", () => {
  it("adds +0.10 for a new file fingerprint once per turn", () => {
    let state = lane();
    state = applyEvent(state, toolStart(T0, editTool("aaaabbbbcccc0020")));
    expect(state.progress).toBeCloseTo(PROGRESS_NEW_FILE_WEIGHT, 5);
    const progressAfterFirst = state.progress;
    state = applyEvent(state, toolStart(T0 + 1000, editTool("aaaabbbbcccc0020")));
    expect(state.progress).toBeLessThanOrEqual(progressAfterFirst);
  });

  it("adds +0.05 for a new command fingerprint once per turn", () => {
    let state = lane();
    state = applyEvent(state, toolStart(T0, execRunTool("eeeeffff00001212")));
    expect(state.progress).toBeCloseTo(PROGRESS_NEW_COMMAND_WEIGHT, 5);
  });

  it("adds +0.30 for the first green after red", () => {
    const fp = "eeeeffff00001313";
    let state = lane();
    state = applyEvent(state, toolFail(T0, failOf(execTestTool(fp))));
    const progressBeforeGreen = state.progress;
    state = applyEvent(
      state,
      toolEnd(T0 + 1000, { ...execTestTool(fp), outcome: { ok: true as const } }),
    );
    expect(state.progress - progressBeforeGreen).toBeCloseTo(PROGRESS_FIRST_GREEN_WEIGHT, 2);
    // A second green for the same fingerprint is not new progress.
    const progressAfterGreen = state.progress;
    state = applyEvent(
      state,
      toolEnd(T0 + 2000, { ...execTestTool(fp), outcome: { ok: true as const } }),
    );
    expect(state.progress).toBeLessThanOrEqual(progressAfterGreen);
  });

  it("fires first green for a red in an earlier turn", () => {
    const fp = "eeeeffff00001314";
    let state = lane();
    state = applyEvent(state, toolFail(T0, failOf(execTestTool(fp))));
    state = applyEvent(state, turnEndCompleted(T0 + 1000));
    state = applyEvent(state, turnStart(T0 + 2000));
    const before = state.progress;
    state = applyEvent(
      state,
      toolEnd(T0 + 3000, { ...execTestTool(fp), outcome: { ok: true as const } }),
    );
    expect(state.progress - before).toBeCloseTo(PROGRESS_FIRST_GREEN_WEIGHT, 2);
  });

  it("adds +0.20 when a test summary shows fewer failures, ignored otherwise", () => {
    const fp = "eeeeffff00001414";
    let state = lane();
    state = applyEvent(
      state,
      toolFail(T0, {
        ...execTestTool(fp),
        outcome: { ok: false as const, testSummary: { failed: 5 } },
      }),
    );
    const before = state.progress;
    state = applyEvent(
      state,
      toolEnd(T0 + 1000, {
        ...execTestTool(fp),
        outcome: { ok: true as const, testSummary: { failed: 2 } },
      }),
    );
    // Test-summary relief (+0.20) stacks with first-green relief (+0.30) here.
    expect(state.progress - before).toBeCloseTo(
      PROGRESS_TEST_SUMMARY_WEIGHT + PROGRESS_FIRST_GREEN_WEIGHT,
      1,
    );
    // No testSummary present: no Tier-2 parsing, no relief beyond first green.
    let plain = lane();
    plain = applyEvent(plain, toolFail(T0, failOf(execTestTool(fp))));
    const plainBefore = plain.progress;
    plain = applyEvent(
      plain,
      toolEnd(T0 + 1000, { ...execTestTool(fp), outcome: { ok: true as const } }),
    );
    expect(plain.progress - plainBefore).toBeCloseTo(PROGRESS_FIRST_GREEN_WEIGHT, 2);
  });

  it("subtracts 1.5× each progress weight from struggle", () => {
    // Build struggle, then relieve it with a novel file: +0.10 progress
    // removes 0.15 struggle.
    let state = lane();
    const fp = "eeeeffff00001515";
    state = applyEvent(state, toolFail(T0, failOf(execRunTool(fp))));
    state = applyEvent(state, toolFail(T0 + 1000, failOf(execRunTool(fp))));
    const struggled = state.struggle;
    expect(struggled).toBeCloseTo(0.15, 1);
    state = applyEvent(state, toolStart(T0 + 2000, editTool("aaaabbbbcccc0030")));
    expect(state.struggle).toBeCloseTo(
      Math.max(0, struggled - PROGRESS_STRUGGLE_RELIEF * PROGRESS_NEW_FILE_WEIGHT),
      1,
    );
  });

  it("relieves 1.5×0.20 before the 0.2 cap on turn.end(completed)", () => {
    const fp = "eeeeffff00001616";
    let state = lane();
    for (let step = 0; step < 5; step += 1) {
      state = applyEvent(state, toolFail(T0 + step * 1000, failOf(execRunTool(fp))));
    }
    expect(state.struggle).toBeGreaterThan(0.2);
    const progressBefore = state.progress;
    const struggleBefore = state.struggle;
    state = applyEvent(state, turnEndCompleted(T0 + 6000));
    // Relief subtracts 1.5 × 0.20 first; the high starting value still lands
    // on the cap.
    expect(
      struggleBefore - PROGRESS_STRUGGLE_RELIEF * PROGRESS_TURN_COMPLETE_WEIGHT,
    ).toBeGreaterThan(PROGRESS_TURN_COMPLETE_STRUGGLE_CAP);
    expect(state.struggle).toBe(PROGRESS_TURN_COMPLETE_STRUGGLE_CAP);
    expect(state.progress - progressBefore).toBeCloseTo(PROGRESS_TURN_COMPLETE_WEIGHT, 2);
  });

  it("releases a stuck lane fast on first green: no post-recovery ratchet", () => {
    // ADR 0019 golden-trajectory proof at unit scale: a lane stuck at 0.65
    // (three repeat-fails + the 4th-fail kicker) drops below the 0.4
    // re-arm on the first green (+0.30 progress relieves 0.45 struggle),
    // so the structural voice opens back up instead of staying stuck.
    const fp = "eeeeffff00001717";
    let state = lane();
    for (let step = 0; step < 4; step += 1) {
      state = applyEvent(state, toolFail(T0 + step * 1000, failOf(execRunTool(fp))));
    }
    expect(state.struggle).toBeGreaterThanOrEqual(0.6);
    const stuck = state.struggle;
    state = applyEvent(
      state,
      toolEnd(T0 + 5000, { ...execTestTool(fp), outcome: { ok: true as const } }),
    );
    expect(state.struggle).toBeLessThan(0.4);
    expect(state.struggle).toBeLessThan(stuck - 0.3);
  });

  it("subtracts the turn-complete relief at low struggle before clamping", () => {
    // One repeat-fail leaves struggle at 0.15: relief subtracts 1.5 × 0.20
    // (0.30) and clamps at 0 rather than leaving the value untouched.
    const fp = "eeeeffff00001617";
    let state = lane();
    state = applyEvent(state, toolFail(T0, failOf(execRunTool(fp))));
    state = applyEvent(state, toolFail(T0 + 1000, failOf(execRunTool(fp))));
    expect(state.struggle).toBeGreaterThan(0);
    expect(state.struggle).toBeLessThanOrEqual(PROGRESS_TURN_COMPLETE_STRUGGLE_CAP);
    state = applyEvent(state, turnEndCompleted(T0 + 2000));
    expect(state.struggle).toBe(0);
  });
});

describe("decay math", () => {
  it("halves struggle every 10 min ± 5% in advance", () => {
    const fp = "eeeeffff00001717";
    let state = lane();
    state = applyEvent(state, toolFail(T0, failOf(execRunTool(fp))));
    state = applyEvent(state, toolFail(T0 + 1000, failOf(execRunTool(fp))));
    const hot = state.struggle;
    expect(hot).toBeGreaterThan(0);
    const halved = advance(state, T0 + 1000 + STRUGGLE_HALF_LIFE_MS);
    expect(halved.struggle).toBeCloseTo(hot / 2, 2);
    expect(Math.abs(halved.struggle - hot / 2) / (hot / 2)).toBeLessThanOrEqual(0.05);
    expect(decayStruggleValue(0.8, STRUGGLE_HALF_LIFE_MS)).toBeCloseTo(0.4, 10);
  });

  it("decays progress with τ = 3 min in advance", () => {
    let state = lane();
    state = applyEvent(state, toolStart(T0, editTool("aaaabbbbcccc0040")));
    const hot = state.progress;
    const oneTau = advance(state, T0 + PROGRESS_TAU_MS);
    expect(oneTau.progress).toBeCloseTo(hot * Math.exp(-1), 2);
    expect(decayProgressValue(0.8, PROGRESS_TAU_MS)).toBeCloseTo(0.8 * Math.exp(-1), 10);
  });

  it("converges activity, progress and struggle toward 0 with no events", () => {
    const fp = "eeeeffff00001818";
    let state = lane();
    state = applyEvent(state, toolFail(T0, failOf(execRunTool(fp))));
    state = applyEvent(state, toolFail(T0 + 1000, failOf(execRunTool(fp))));
    state = applyEvent(state, toolStart(T0 + 2000, editTool("aaaabbbbcccc0041")));
    const settled = advance(state, T0 + 2000 + 10 * STRUGGLE_HALF_LIFE_MS);
    expect(settled.struggle).toBeLessThan(0.01);
    expect(settled.progress).toBeLessThan(0.01);
    expect(settled.activity).toBeLessThan(0.01);
  });
});

describe("0.6/0.4 hysteresis", () => {
  function stuckState(): LaneState {
    const fp = "eeeeffff00001919";
    let state = lane();
    for (let step = 0; step < 4; step += 1) {
      state = applyEvent(state, toolFail(T0 + step * 1000, failOf(execRunTool(fp))));
    }
    expect(state.struggle).toBeGreaterThanOrEqual(STRUGGLE_ATTENTION_THRESHOLD);
    return state;
  }

  it("appends a reason on the upward crossing and disarms", () => {
    const state = stuckState();
    expect(state.reasons.some((r) => r.signal === "struggle" && r.text.includes("0.6"))).toBe(true);
    expect(state.internal.struggleArmed).toBe(false);
  });

  it("does not fire again until struggle drops below 0.4", () => {
    let state = stuckState();
    const crossings = state.reasons.filter((r) => r.text.includes("0.6")).length;
    // More failures while disarmed: struggle climbs but no new crossing reason.
    state = applyEvent(state, toolFail(T0 + 5000, failOf(execRunTool("eeeeffff00001919"))));
    expect(state.reasons.filter((r) => r.text.includes("0.6")).length).toBe(crossings);
    // Relief below 0.4 re-arms; the next climb fires exactly once more.
    state = applyEvent(state, turnEndCompleted(T0 + 6000));
    expect(state.internal.struggleArmed).toBe(true);
    const refired = stuckStateFrom(state, T0 + 7000);
    expect(refired.reasons.filter((r) => r.text.includes("0.6")).length).toBeGreaterThan(crossings);
  });

  it("keeps hysteresis state in working memory, not in the UI-bound shape", () => {
    const state = stuckState();
    const uiShape = { ...state, internal: undefined as never };
    expect("struggleArmed" in uiShape).toBe(false);
    expect(typeof state.internal.struggleArmed).toBe("boolean");
  });

  function stuckStateFrom(from: LaneState, at: number): LaneState {
    const fp = "eeeeffff00002020";
    let state = from;
    for (let step = 0; step < 4; step += 1) {
      state = applyEvent(state, toolFail(at + step * 1000, failOf(execRunTool(fp))));
    }
    return state;
  }
});

describe("invariant 1", () => {
  it("never decreases struggle on an identical tool.fail repeat with no other events", () => {
    const fp = "eeeeffff00002121";
    let state = lane();
    let previous = state.struggle;
    for (let step = 0; step < 10; step += 1) {
      state = applyEvent(state, toolFail(T0 + step * 1000, failOf(execRunTool(fp))));
      expect(state.struggle).toBeGreaterThanOrEqual(previous);
      previous = state.struggle;
    }
  });
});
