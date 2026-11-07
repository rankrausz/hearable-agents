// packages/daemon/test/lanes.test.ts — lane allocation behaviour, per the
// task's lane criterion: three MVP lanes, extra sessions tracked and queued,
// lane freed on session.end or after laneReleaseAfterMs idle, subagents folded
// into the parent lane, queue promoted when a lane frees.

import { describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.js";
import { LaneManager, laneKeyOf, seatOrderFor } from "../src/lanes.js";
import { Sessions } from "../src/sessions.js";
import { drillEvent, sessionStartEvent } from "./doubles.js";

function fixture(releaseAfterMs = 60_000, laneCount = 3) {
  let now = 0;
  const sessions = new Sessions();
  const clock: Clock = () => now;
  const lanes = new LaneManager(laneCount, releaseAfterMs, sessions, clock);
  // Mirrors applyIngest's per-event sequence: observe (stamping receivedAt
  // from the fixture clock), assign the lane, and keep the session warm; both
  // endings remove the session record from the registry.
  const accept = (event: Parameters<typeof drillEvent>[0]) => {
    const stamped = drillEvent({ ...event, receivedAt: now });
    sessions.observe(stamped, null, now);
    lanes.accept(stamped);
    if (stamped.kind === "session.end" || stamped.kind === "subagent.end") {
      sessions.remove(stamped.sessionId);
      return;
    }
    sessions.touch(stamped.sessionId, now);
  };
  return {
    sessions,
    lanes,
    accept,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("lane allocation", () => {
  it("assigns three sessions to three lanes and queues the fourth", () => {
    const fx = fixture();
    for (const session of ["a", "b", "c", "d"]) {
      fx.accept({ ...sessionStartEvent(session), sessionId: session });
    }
    const snapshot = fx.lanes.snapshot();
    expect(snapshot.lanes.map((lane) => lane.state)).toEqual(["active", "active", "active"]);
    expect(snapshot.queued.map((ref) => ref.sessionId)).toEqual(["d"]);
    expect(fx.lanes.occupiedCount()).toBe(3);
  });

  it("promotes the queued session into the first session's seat when it ends", () => {
    const fx = fixture();
    for (const session of ["a", "b", "c", "d"]) {
      fx.accept({ ...sessionStartEvent(session), sessionId: session });
    }
    fx.accept({ kind: "session.end", sessionId: "a" });
    const snapshot = fx.lanes.snapshot();
    expect(snapshot.lanes[1]?.sessions[0]?.sessionId).toBe("d");
    expect(snapshot.queued).toEqual([]);
  });

  it("frees a lane after laneReleaseAfterMs of idle and promotes the queue", () => {
    const fx = fixture(1000);
    for (const session of ["a", "b", "c", "d"]) {
      fx.accept({ ...sessionStartEvent(session), sessionId: session });
    }
    fx.advance(1500);
    fx.lanes.advance();
    const snapshot = fx.lanes.snapshot();
    expect(snapshot.lanes.map((lane) => lane.state)).toEqual(["free", "active", "free"]);
    expect(snapshot.lanes[1]?.sessions[0]?.sessionId).toBe("d");
    expect(snapshot.queued).toEqual([]);
  });

  it("keeps a lane active while its owner keeps emitting activity", () => {
    const fx = fixture(1000);
    fx.accept({ ...sessionStartEvent("a"), sessionId: "a" });
    fx.advance(900);
    fx.accept({ kind: "turn.start", sessionId: "a" });
    fx.advance(900);
    fx.lanes.advance();
    expect(fx.lanes.occupiedCount()).toBe(1);
  });

  it("promotes the queue in order as lanes free up", () => {
    const fx = fixture(60_000);
    for (const session of ["a", "b", "c", "d", "e", "f"]) {
      fx.accept({ ...sessionStartEvent(session), sessionId: session });
    }
    expect(fx.lanes.snapshot().queued.map((ref) => ref.sessionId)).toEqual(["d", "e", "f"]);
    fx.accept({ kind: "session.end", sessionId: "a" });
    fx.accept({ kind: "session.end", sessionId: "b" });
    const snapshot = fx.lanes.snapshot();
    expect(snapshot.lanes[1]?.sessions[0]?.sessionId).toBe("d");
    expect(snapshot.lanes[0]?.sessions[0]?.sessionId).toBe("e");
    expect(snapshot.queued.map((ref) => ref.sessionId)).toEqual(["f"]);
  });

  it("drops a queued session from the queue when it ends while waiting", () => {
    const fx = fixture(60_000);
    for (const session of ["a", "b", "c", "d"]) {
      fx.accept({ ...sessionStartEvent(session), sessionId: session });
    }
    fx.accept({ kind: "session.end", sessionId: "d" });
    fx.accept({ kind: "session.end", sessionId: "a" });
    const snapshot = fx.lanes.snapshot();
    // Lane 0 is free now (queue was empty when a ended), and d never took it.
    const occupied = snapshot.lanes
      .filter((lane) => lane.state === "active")
      .map((lane) => lane.sessions[0]?.sessionId);
    expect(occupied).toEqual(["b", "c"]);
    expect(snapshot.queued).toEqual([]);
  });

  it("removes a queued subagent's parent key when the subagent ends before the parent appears", () => {
    const fx = fixture(60_000);
    for (const session of ["a", "b", "c"]) {
      fx.accept({ ...sessionStartEvent(session), sessionId: session });
    }
    // A subagent whose parent "ghost" has never been seen queues under the
    // parent key.
    fx.accept({
      kind: "session.start",
      sessionId: "sub",
      parentSessionId: "ghost",
    });
    expect(fx.lanes.snapshot().queued.map((ref) => ref.sessionId)).toEqual(["sub"]);
    // The subagent ends before the parent ever appears; the ghost key must
    // leave the queue entirely, not be promoted later as a lane with no live
    // session.
    fx.accept({
      kind: "subagent.end",
      sessionId: "sub",
      parentSessionId: "ghost",
    });
    fx.accept({ kind: "session.end", sessionId: "a" });
    const snapshot = fx.lanes.snapshot();
    const occupied = snapshot.lanes
      .filter((lane) => lane.state === "active")
      .map((lane) => lane.sessions[0]?.sessionId);
    expect(occupied).toEqual(["b", "c"]);
    // No lane sits "active" with no sessions, and nothing is queued.
    expect(
      snapshot.lanes.some((lane) => lane.state === "active" && lane.sessions.length === 0),
    ).toBe(false);
    expect(snapshot.queued).toEqual([]);
  });

  it("shows a queued subagent (not its unseen parent) in the queue", () => {
    const fx = fixture(60_000);
    for (const session of ["a", "b", "c"]) {
      fx.accept({ ...sessionStartEvent(session), sessionId: session });
    }
    fx.accept({ kind: "session.start", sessionId: "sub", parentSessionId: "ghost" });
    const queued = fx.lanes.snapshot().queued.map((ref) => ref.sessionId);
    expect(queued).toEqual(["sub"]);
  });
});

describe("subagents", () => {
  it("folds a subagent into the parent's lane", () => {
    const fx = fixture();
    fx.accept({ ...sessionStartEvent("parent"), sessionId: "parent" });
    fx.accept({ ...sessionStartEvent("sub"), sessionId: "sub", parentSessionId: "parent" });
    const snapshot = fx.lanes.snapshot();
    const laneSessions = snapshot.lanes.flatMap((lane) =>
      lane.sessions.map((ref) => ref.sessionId),
    );
    expect(laneSessions).toEqual(["parent", "sub"]);
    expect(fx.lanes.occupiedCount()).toBe(1);
  });

  it("folds a subagent into the parent lane even when the parent was never seen", () => {
    const fx = fixture();
    fx.accept({ ...sessionStartEvent("sub"), sessionId: "sub", parentSessionId: "parent" });
    // Parent shows up later; both must land in the same lane.
    fx.accept({ ...sessionStartEvent("parent"), sessionId: "parent" });
    const snapshot = fx.lanes.snapshot();
    expect(fx.lanes.occupiedCount()).toBe(1);
    const laneSessions = new Set(
      snapshot.lanes.flatMap((lane) => lane.sessions.map((ref) => ref.sessionId)),
    );
    expect(laneSessions.has("parent")).toBe(true);
    expect(laneSessions.has("sub")).toBe(true);
  });

  it("does not free the parent lane when the subagent ends", () => {
    const fx = fixture();
    fx.accept({ ...sessionStartEvent("parent"), sessionId: "parent" });
    fx.accept({ ...sessionStartEvent("sub"), sessionId: "sub", parentSessionId: "parent" });
    fx.accept({ kind: "subagent.end", sessionId: "sub", parentSessionId: "parent" });
    expect(fx.lanes.occupiedCount()).toBe(1);
  });

  it("subagent activity keeps a folded lane from the idle release", () => {
    const fx = fixture(1000);
    fx.accept({ ...sessionStartEvent("parent"), sessionId: "parent" });
    fx.advance(900);
    fx.accept({ kind: "tool.start", sessionId: "sub", parentSessionId: "parent" });
    fx.advance(900);
    fx.lanes.advance();
    expect(fx.lanes.occupiedCount()).toBe(1);
  });
});

describe("centre-first seating", () => {
  it("seats a solo session in the mid seat", () => {
    const fx = fixture();
    fx.accept({ ...sessionStartEvent("solo"), sessionId: "solo" });
    expect(fx.lanes.laneIdForKey("solo")).toBe(1);
    expect(fx.lanes.snapshot().lanes.map((lane) => lane.state)).toEqual(["free", "active", "free"]);
  });

  it("seats arrivals mid, then low, then high with three lanes", () => {
    const fx = fixture();
    for (const session of ["a", "b", "c"]) {
      fx.accept({ ...sessionStartEvent(session), sessionId: session });
    }
    expect(["a", "b", "c"].map((key) => fx.lanes.laneIdForKey(key))).toEqual([1, 0, 2]);
  });

  it("seats the fourth arrival in the upper seat with four lanes", () => {
    const fx = fixture(60_000, 4);
    for (const session of ["a", "b", "c", "d"]) {
      fx.accept({ ...sessionStartEvent(session), sessionId: session });
    }
    expect(["a", "b", "c", "d"].map((key) => fx.lanes.laneIdForKey(key))).toEqual([1, 0, 2, 3]);
  });

  it("gives a freed mid seat to the next joiner while low and high stay occupied", () => {
    const fx = fixture();
    for (const session of ["a", "b", "c"]) {
      fx.accept({ ...sessionStartEvent(session), sessionId: session });
    }
    fx.accept({ kind: "session.end", sessionId: "a" });
    fx.accept({ ...sessionStartEvent("d"), sessionId: "d" });
    expect(fx.lanes.laneIdForKey("d")).toBe(1);
    expect(fx.lanes.laneIdForKey("b")).toBe(0);
    expect(fx.lanes.laneIdForKey("c")).toBe(2);
  });

  it("keeps the snapshot ordered by lane id regardless of arrival order", () => {
    const fx = fixture();
    for (const session of ["a", "b", "c"]) {
      fx.accept({ ...sessionStartEvent(session), sessionId: session });
    }
    const snapshot = fx.lanes.snapshot();
    expect(snapshot.lanes.map((lane) => lane.laneId)).toEqual([0, 1, 2]);
    expect(snapshot.lanes.map((lane) => lane.sessions[0]?.sessionId)).toEqual(["b", "a", "c"]);
  });

  it("applies the seat order only to lanes that exist for the configured count", () => {
    expect(seatOrderFor(1)).toEqual([0]);
    expect(seatOrderFor(2)).toEqual([1, 0]);
    expect(seatOrderFor(3)).toEqual([1, 0, 2]);
    expect(seatOrderFor(4)).toEqual([1, 0, 2, 3]);
    expect(seatOrderFor(6)).toEqual([1, 0, 2, 3, 4, 5]);
  });
});

/** Deterministic PRNG so a failing sequence is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Step =
  | { op: "activity"; sessionId: string; parentSessionId?: string }
  | { op: "end"; sessionId: string; parentSessionId?: string }
  | { op: "idle"; ms: number };

const ROOTS = ["r0", "r1", "r2", "r3", "r4", "r5"];
// Sub-agents with a parent that may never appear exercise folding into an unseen key.
const SUBAGENTS = [
  { sessionId: "s0", parentSessionId: "r0" },
  { sessionId: "s1", parentSessionId: "r1" },
  { sessionId: "s2", parentSessionId: "r3" },
  { sessionId: "s3", parentSessionId: "ghost" },
];

function randomStep(rng: () => number): Step {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
  const roll = rng();
  if (roll < 0.35) {
    return { op: "activity", sessionId: pick(ROOTS) };
  }
  if (roll < 0.55) {
    return { op: "activity", ...pick(SUBAGENTS) };
  }
  if (roll < 0.7) {
    return { op: "end", sessionId: pick(ROOTS) };
  }
  if (roll < 0.8) {
    return { op: "end", ...pick(SUBAGENTS) };
  }
  return { op: "idle", ms: Math.floor(rng() * 1500) };
}

function placedLanes(lanes: LaneManager, keys: readonly string[]): Map<string, number> {
  const placed = new Map<string, number>();
  for (const key of keys) {
    const laneId = lanes.laneIdForKey(key);
    if (laneId !== undefined) {
      placed.set(key, laneId);
    }
  }
  return placed;
}

describe("seat identity property", () => {
  const keys = [...ROOTS, "ghost"];

  for (const laneCount of [3, 4]) {
    it(`never moves a live lane key across random join, leave, subagent and idle sequences (${laneCount} lanes)`, () => {
      for (let seed = 1; seed <= 200; seed += 1) {
        const rng = mulberry32(seed * 7919 + laneCount);
        const fx = fixture(1000, laneCount);
        const order = seatOrderFor(laneCount);
        for (let index = 0; index < 120; index += 1) {
          const step = randomStep(rng);
          const before = placedLanes(fx.lanes, keys);
          const context = `seed ${seed}, step ${index}: ${JSON.stringify(step)}`;
          let subject: string | undefined;
          if (step.op === "idle") {
            fx.advance(step.ms);
            fx.lanes.advance();
          } else {
            subject = laneKeyOf(step.sessionId, step.parentSessionId);
            const kind =
              step.op === "activity"
                ? "turn.start"
                : step.parentSessionId === undefined
                  ? "session.end"
                  : "subagent.end";
            fx.accept({
              kind,
              sessionId: step.sessionId,
              ...(step.parentSessionId === undefined
                ? {}
                : { parentSessionId: step.parentSessionId }),
            });
          }
          const after = placedLanes(fx.lanes, keys);

          for (const [key, laneId] of before) {
            const now = after.get(key);
            if (now !== undefined) {
              expect(now, `${context} moved ${key}`).toBe(laneId);
            }
            if (step.op === "activity") {
              // A join or activity for one key never releases anybody else.
              expect(now, `${context} released ${key}`).toBe(laneId);
            } else if (step.op === "end" && key !== subject) {
              expect(now, `${context} released ${key}`).toBe(laneId);
            }
          }

          const laneIds = [...after.values()];
          expect(new Set(laneIds).size, `${context} shared a lane`).toBe(laneIds.length);

          if (step.op === "activity" && subject !== undefined && !before.has(subject)) {
            const placed = after.get(subject);
            if (placed !== undefined) {
              const firstFree = order.find((laneId) => ![...before.values()].includes(laneId));
              expect(placed, `${context} skipped a preferred free seat`).toBe(firstFree);
            }
          }

          const snapshot = fx.lanes.snapshot();
          expect(snapshot.lanes.map((lane) => lane.laneId)).toEqual(
            Array.from({ length: laneCount }, (_, laneId) => laneId),
          );
        }
      }
    });
  }
});
