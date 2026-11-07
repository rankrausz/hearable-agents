// Proves piano scheduling coordinates and pre-emption; must not construct audio nodes in Node.
import { describe, expect, it, vi } from "vitest";

vi.mock("tone", () => ({}));

import { compensatedGesturePeak, scheduleGesturePlan } from "../src/apply.js";
import { CUT_RELEASE_S, GesturePlayer, gestureEvents } from "../src/gestures/index.js";

const calls: { path: string; start?: number }[] = [];
function recordingParam(path: string) {
  return {
    value: 0,
    linearRampTo(_to: number, _time: number, start?: number) {
      calls.push({ path, start });
    },
    exponentialRampTo(_to: number, _time: number, start?: number) {
      calls.push({ path, start });
    },
  };
}
function fakeGraph() {
  calls.length = 0;
  return { lanes: [{ gestureBus: { gain: recordingParam("bus") } }] };
}
function rampStarts(path: string) {
  return calls.filter((c) => c.path === path).map((c) => c.start);
}
describe("piano cue scheduling time coordinates", () => {
  it("schedules recorded notes at their absolute rolled offsets and holds", () => {
    const attacks: unknown[][] = [];
    const sampler = {
      triggerAttackRelease: (...args: unknown[]) => attacks.push(args),
      releaseAll: vi.fn(),
      release: 0.65,
    };
    const graph = { ...fakeGraph(), piano: { lanes: [sampler] } };
    const player = new GesturePlayer();
    player.play({ laneIndex: 0, gesture: "attention", at: 1 }, 0.6);
    const events = player.play({ laneIndex: 0, gesture: "question", at: 1.2 }, 0.6);
    scheduleGesturePlan(graph as never, events, 100);
    const notes = events.filter((e) => e.kind === "note");
    expect(sampler.releaseAll).toHaveBeenCalledWith(100, CUT_RELEASE_S);
    expect(attacks).toHaveLength(5);
    for (const [i, note] of notes.entries()) {
      expect(attacks[i]).toEqual([
        440 * 2 ** ((note.midi - 69) / 12),
        note.holdUntilS - note.startS,
        100 + note.startS,
        note.gain,
      ]);
    }
    expect(rampStarts("bus")[0]).toBe(100);
    expect(rampStarts("bus")[1]).toBe(100 + CUT_RELEASE_S);
  });
  it("preserves the existing Calm compensation and attention taper", () => {
    for (const calm of [0, 0.6, 1]) {
      const master = -6 * calm;
      for (const gesture of ["arrive", "question", "resolve", "attention"] as const) {
        const events = gestureEvents({ laneIndex: 0, gesture, at: 0 }, calm);
        for (const e of events)
          if (e.kind === "note")
            expect(compensatedGesturePeak(e.gain, master) * 10 ** (master / 20)).toBeCloseTo(
              e.gain,
              12,
            );
      }
    }
  });
  it("fails loudly when the piano bank is absent", () => {
    expect(() =>
      scheduleGesturePlan(
        fakeGraph() as never,
        gestureEvents({ laneIndex: 0, gesture: "arrive", at: 0 }, 0.6),
        0,
      ),
    ).toThrow("Piano samples");
  });
});
