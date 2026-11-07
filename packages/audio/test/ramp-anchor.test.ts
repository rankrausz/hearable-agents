// packages/audio/test/ramp-anchor.test.ts — the anchoring contract for every
// scheduled ramp: a move scheduled AHEAD of the clock must sound at its own
// anchor, not at now(). The defect this pins (found on the p5-t01 audition
// re-listen): Tone's `*RampTo(value, rampTime, startTime?)` defaults
// startTime to now() and opens with its own `setRampPoint(startTime)`, whose
// `cancelAndHoldAtTime(now)` erases any hold point the caller placed in the
// future — so `setRampPoint(anchor)` followed by a bare `linearRampTo` runs
// the ramp at now() and drops the anchor. Invisible when anchor ≈ now (live
// applies; offline applies from a transport callback), total for anything
// scheduled ahead: in a 150 s offline render every such ramp piled into the
// first seconds, last writer winning — the A/B slice's four lane retunes all
// landed at t≈0, so the lane held ONE pitch for the whole slice and no pitch
// change was audible.
//
// The fake below is a Param stand-in that implements the same Tone semantics
// verified against tone@15's Param.js (setRampPoint = cancelAndHoldAtTime +
// setValueAtTime; `*RampTo` = setRampPoint(startTime ?? now) + ramp to
// startTime + rampTime), with `now` pinned at 0 the way Tone.Offline pins it
// while a render's plan is being scheduled. It evaluates the resulting
// timeline, so the assertions are about WHEN the value moves, not about which
// Tone method was called.

import type * as Tone from "tone";
import { describe, expect, it } from "vitest";
import { scheduleBusMove, scheduleEnvelope, scheduleMove } from "../src/apply.js";

type Event =
  | { kind: "set"; time: number; value: number }
  | { kind: "linear"; time: number; value: number }
  | { kind: "exponential"; time: number; value: number }
  | { kind: "target"; time: number; value: number };

/** Minimal Tone.Param stand-in: records automation and evaluates it. */
class FakeParam {
  /** Offline renders schedule their whole plan while now() is still 0. */
  readonly now = 0;
  value: number;
  private events: Event[] = [];

  constructor(initial: number) {
    this.value = initial;
  }

  private sorted(): Event[] {
    return [...this.events].sort((a, b) => a.time - b.time);
  }

  getValueAtTime(time: number): number {
    let value = this.value;
    let prevTime = 0;
    for (const event of this.sorted()) {
      if (event.time > time) {
        if (event.kind === "set") break;
        const span = event.time - prevTime;
        if (span <= 0) break;
        const progress = (time - prevTime) / span;
        return value + (event.value - value) * Math.min(1, Math.max(0, progress));
      }
      value = event.value;
      prevTime = event.time;
    }
    return value;
  }

  cancelAndHoldAtTime(time: number): void {
    const held = this.getValueAtTime(time);
    this.events = this.sorted().filter((event) => event.time < time);
    this.events.push({ kind: "set", time, value: held });
  }

  setRampPoint(time: number): void {
    const held = this.getValueAtTime(time);
    this.cancelAndHoldAtTime(time);
    this.events.push({ kind: "set", time, value: held });
  }

  private ramp(kind: Event["kind"], value: number, rampTime: number, startTime?: number): void {
    const start = startTime ?? this.now;
    this.setRampPoint(start);
    this.events.push({ kind, time: start + rampTime, value });
  }

  linearRampTo(value: number, rampTime: number, startTime?: number): void {
    this.ramp("linear", value, rampTime, startTime);
  }

  exponentialRampTo(value: number, rampTime: number, startTime?: number): void {
    this.ramp("exponential", value, rampTime, startTime);
  }

  targetRampTo(value: number, rampTime: number, startTime?: number): void {
    this.ramp("target", value, rampTime, startTime);
  }
}

/** The retune entry's own move shape: a detune-class frequency portamento. */
const detuneMove = (target: number) =>
  ({ path: "lanes.1.grain.voice0", ramp: "detune", current: 0, target }) as const;

describe("ramps anchor at their own time, not at now()", () => {
  it("holds a scheduled move until its anchor and completes after it", () => {
    const param = new FakeParam(440);
    // One lane retune of the A/B slice: A4 → F#4 at 23 s.
    scheduleMove(param as unknown as Tone.Signal<"frequency">, detuneMove(369.99), 23);
    // Before the anchor the lane still carries its old pitch: the whole
    // point — this read 369.99 while the ramp piled at now().
    expect(param.getValueAtTime(0)).toBeCloseTo(440, 2);
    expect(param.getValueAtTime(10)).toBeCloseTo(440, 2);
    expect(param.getValueAtTime(22.9)).toBeCloseTo(440, 2);
    // After the anchor plus the detune ramp the move has landed.
    expect(param.getValueAtTime(23 + 12)).toBeCloseTo(369.99, 2);
  });

  it("keeps successive moves separate instead of collapsing them onto the start", () => {
    const param = new FakeParam(440);
    // The four hybrid lane-1 moves of the audition slice, scheduled in one
    // pass ahead of the clock the way the offline QA entry schedules them.
    for (const [atS, target] of [
      [23, 369.99],
      [53, 329.63],
      [90, 369.99],
      [120, 329.63],
    ] as const) {
      scheduleMove(param as unknown as Tone.Signal<"frequency">, detuneMove(target), atS);
    }
    // Each move is heard in its own window — the defect read the LAST
    // move's pitch (329.63) in every window including the first.
    expect(param.getValueAtTime(20)).toBeCloseTo(440, 2);
    expect(param.getValueAtTime(40)).toBeCloseTo(369.99, 2);
    expect(param.getValueAtTime(70)).toBeCloseTo(329.63, 2);
    expect(param.getValueAtTime(105)).toBeCloseTo(369.99, 2);
    expect(param.getValueAtTime(140)).toBeCloseTo(329.63, 2);
    // And the slice is not static: at least four distinct carried pitches.
    const carried = new Set(
      [20, 40, 70, 105, 140].map((t) => Math.round(param.getValueAtTime(t) * 100) / 100),
    );
    expect(carried.size).toBeGreaterThanOrEqual(3);
  });

  it("opens a gesture bus window at its own time and closes it at the plan's end", () => {
    const gain = new FakeParam(0);
    const bus = { gain } as unknown as Tone.Gain;
    // One routine-note articulation of the slice: open at the move, close
    // 1.55 s later. Both windows of the SAME plan, scheduled at once.
    scheduleBusMove(bus, laneBus(0, 0.02, 0, 1), 23);
    scheduleBusMove(bus, laneBus(1.55, 1.85, 1, 0), 23);
    // The close must not cancel its own open: the bus is shut before the
    // move, open across the notes, shut again afterwards.
    expect(gain.getValueAtTime(22.9)).toBeCloseTo(0, 3);
    expect(gain.getValueAtTime(23.5)).toBeCloseTo(1, 3);
    expect(gain.getValueAtTime(24.4)).toBeCloseTo(1, 3);
    expect(gain.getValueAtTime(25.5)).toBeLessThan(0.01);
  });

  it("sounds a gesture note envelope at its trigger, not at the render start", () => {
    const gain = new FakeParam(0);
    // The routine note's own envelope: 0.02 s attack, hold to 1.55 s,
    // 0.8 s release, triggered 60 s into the render.
    scheduleEnvelope(gain as unknown as Tone.Param<"gain">, 60, 0, 0.2, 0.02, 1.55, 0.8);
    // Silent before the trigger (the defect collapsed attack AND release
    // onto now(), leaving the note at zero for the whole render).
    expect(gain.getValueAtTime(10)).toBeCloseTo(0, 4);
    expect(gain.getValueAtTime(59.9)).toBeCloseTo(0, 4);
    // Open across the hold, back to silence after the release.
    expect(gain.getValueAtTime(60.5)).toBeCloseTo(0.2, 4);
    expect(gain.getValueAtTime(61.5)).toBeCloseTo(0.2, 4);
    expect(gain.getValueAtTime(62.4)).toBeCloseTo(0, 3);
  });
});

/** One gesture-bus window in the plan's own relative offsets. */
function laneBus(
  startS: number,
  endS: number,
  from: number,
  to: number,
): Parameters<typeof scheduleBusMove>[1] {
  return { kind: "bus", laneIndex: 1, startS, endS, from, to, curve: "linear" };
}
