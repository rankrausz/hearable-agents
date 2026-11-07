// packages/core/test/attention/invariants.test.ts — property tests for the
// attention invariants in docs/STATE_ENGINE.md §Attention model:
// determinism (same signals + clock + Calm yield deep-equal renders), at
// most one foreground, the 15 s hold unless waiting pre-empts, the waiting
// base Calm-invariance, and agent-blindness (no agent field exists on the
// input, so identical signals always agree). The generator is local and
// seeded: failures are reproducible without a new dependency.

import { describe, expect, it } from "vitest";

import {
  ATTENTION_FOREGROUND_HOLD_MS,
  type AttentionInput,
  type AttentionState,
  attentionProminenceFor,
  computeAttention,
  initialAttentionState,
} from "../../src/index.js";

const T0 = 1_760_000_000_000;

class SeededRandom {
  private value: number;

  constructor(seed: number) {
    this.value = seed >>> 0;
  }

  next(): number {
    this.value = (1664525 * this.value + 1013904223) >>> 0;
    return this.value / 0x1_0000_0000;
  }

  integer(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

const LIFECYCLES: readonly AttentionInput["lifecycle"][] = [
  "idle",
  "active",
  "quiet",
  "stale",
  "waiting",
  "turn_complete",
];

const MODES: readonly AttentionInput["displayedMode"][] = [
  "exploring",
  "editing",
  "testing",
  "other",
];

function randomLane(random: SeededRandom, laneId: number): AttentionInput {
  const lifecycle = LIFECYCLES[random.integer(LIFECYCLES.length)] ?? "active";
  const waitingReason =
    lifecycle === "waiting"
      ? ((["question", "permission", "idle_prompt"] as const)[random.integer(3)] ?? "question")
      : undefined;
  return {
    laneId,
    lifecycle,
    ...(waitingReason === undefined ? {} : { waitingReason }),
    mode: { exploring: 0.4, editing: 0.3, testing: 0.2, other: 0.1 },
    displayedMode: MODES[random.integer(MODES.length)] ?? "exploring",
    activity: random.next(),
    progress: random.next(),
    struggle: random.next(),
    lastEventAt: T0,
  };
}

function randomSnapshot(seed: number, laneCount: number): AttentionInput[] {
  const snapshotRandom = new SeededRandom(seed);
  return Array.from({ length: laneCount }, (_, index) => randomLane(snapshotRandom, index));
}

function drive(
  snapshots: readonly (readonly AttentionInput[])[],
  calm: number,
  startAt = T0,
  stepMs = 1_000,
): { readonly states: readonly AttentionState[] } {
  let state = initialAttentionState();
  const states: AttentionState[] = [state];
  snapshots.forEach((lanes, index) => {
    state = computeAttention(lanes, calm, state, startAt + index * stepMs).state;
    states.push(state);
  });
  return { states };
}

describe("attention invariants", () => {
  it("is deterministic for the same signals, clock and Calm", () => {
    for (const seed of [401, 409, 419, 421]) {
      const lanes = randomSnapshot(seed, 1 + (seed % 3));
      const calm = (seed % 100) / 100;
      const first = computeAttention(lanes, calm, initialAttentionState(), T0);
      const second = computeAttention(lanes, calm, initialAttentionState(), T0);
      expect(second).toEqual(first);
      const replayed = drive([lanes, lanes], calm);
      expect(replayed.states[2]).toEqual(replayed.states[1]);
    }
  });

  it("holds at most one foreground lane on every tick", () => {
    for (const seed of [503, 509, 521, 523, 541]) {
      const random = new SeededRandom(seed);
      let state = initialAttentionState();
      for (let tick = 0; tick < 12; tick += 1) {
        const lanes = randomSnapshot(seed * 100 + tick, 3);
        const { renders, state: next } = computeAttention(
          lanes,
          random.next(),
          state,
          T0 + tick * 1_000,
        );
        expect(renders.filter((render) => render.foreground)).toHaveLength(
          next.foregroundLaneId === null ? 0 : 1,
        );
        if (next.foregroundLaneId !== null) {
          expect(
            renders.find((render) => render.laneId === next.foregroundLaneId)?.foreground,
          ).toBe(true);
        }
        state = next;
      }
    }
  });

  it("holds foreground 15 s unless waiting pre-empts", () => {
    for (const seed of [601, 607, 613, 617]) {
      let state = initialAttentionState();
      let holder: number | null = null;
      let heldSince = T0;
      for (let tick = 0; tick < 25; tick += 1) {
        const now = T0 + tick * 1_000;
        const lanes = randomSnapshot(seed * 31 + tick, 2);
        const { renders, state: next } = computeAttention(lanes, 0.3, state, now);
        const waitingIds = new Set(
          lanes.filter((lane) => lane.lifecycle === "waiting").map((lane) => lane.laneId),
        );
        if (holder !== null && holder !== next.foregroundLaneId) {
          const heldMs = now - heldSince;
          const preemptedByWaiting =
            next.foregroundLaneId !== null && waitingIds.has(next.foregroundLaneId);
          const holderStillWaiting =
            waitingIds.has(holder) &&
            next.foregroundLaneId !== null &&
            (renders.find((render) => render.laneId === next.foregroundLaneId)?.prominence ?? 0) >=
              (renders.find((render) => render.laneId === holder)?.prominence ?? 0);
          expect(
            heldMs >= ATTENTION_FOREGROUND_HOLD_MS || preemptedByWaiting || holderStillWaiting,
            `seed=${seed} tick=${tick} holder=${holder} heldMs=${heldMs}`,
          ).toBe(true);
        }
        if (next.foregroundLaneId !== holder) {
          holder = next.foregroundLaneId;
          heldSince = now;
        }
        state = next;
      }
    }
  });

  it("keeps the waiting base Calm-invariant", () => {
    for (const seed of [701, 709, 719, 727, 733]) {
      const lanes = randomSnapshot(seed, 3);
      for (const now of [T0, T0 + 4_000, T0 + 30_000]) {
        for (const lane of lanes) {
          if (lane.lifecycle !== "waiting") continue;
          const atCalm0 = attentionProminenceFor(lane, undefined, 0, now);
          const atCalm1 = attentionProminenceFor(lane, undefined, 1, now);
          // Same waiting base and same transition bump at a fixed clock; only
          // the struggle term moves with Calm, and it moves down, never up.
          expect(atCalm1).toBeLessThanOrEqual(atCalm0);
          expect(atCalm0 - atCalm1).toBeLessThanOrEqual(0.6 * lane.struggle + 1e-9);
        }
      }
    }
  });

  it("never branches on agent identity: the input carries no agent field", () => {
    for (const seed of [809, 811, 821, 823]) {
      const lanes = randomSnapshot(seed, 2);
      for (const lane of lanes) {
        expect("agent" in lane).toBe(false);
        expect("lifecycleConfidence" in lane).toBe(false);
        expect("capabilities" in lane).toBe(false);
      }
      const calm = 0.6;
      expect(computeAttention(lanes, calm, initialAttentionState(), T0)).toEqual(
        computeAttention(
          JSON.parse(JSON.stringify(lanes)) as AttentionInput[],
          calm,
          initialAttentionState(),
          T0,
        ),
      );
    }
  });
});
