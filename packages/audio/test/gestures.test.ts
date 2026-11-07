// Tests recorded piano cue meaning, harmonic fit and ramps; never claims a listening verdict.
import { FIELD_CHORDS, fieldChordTones } from "@hearable/core";
import { describe, expect, it } from "vitest";
import {
  baseLaneRender,
  driveScenario,
  evaluateGestureTriggers,
  GesturePlayer,
  type GestureVoiceEvent,
  gestureEvents,
  renderGesturePlan,
  scenarioFor,
} from "../src/gestures/index.js";
import { PIANO_CUE_END_S, pianoChord } from "../src/piano/chord.js";
import { pianoSamples } from "./piano-pcm.js";

function notesOf(events: readonly GestureVoiceEvent[]) {
  return events.filter((e) => e.kind === "note");
}
describe("gesture trigger evaluation", () => {
  it("fires a fresh gesture once and never re-fires an already-seen trigger", () => {
    const prev = [baseLaneRender(0)];
    const next = [baseLaneRender(0, [{ gesture: "arrive", at: 1 }])];
    expect(evaluateGestureTriggers(prev, next, 1)).toEqual([
      { laneIndex: 0, gesture: "arrive", at: 1 },
    ]);
    expect(evaluateGestureTriggers(next, next, 1.5)).toEqual([]);
  });

  it("suppresses non-question triggers within the 3 s refractory", () => {
    const prev = [baseLaneRender(0, [{ gesture: "arrive", at: 1 }])];
    const next = [
      baseLaneRender(0, [
        { gesture: "arrive", at: 1 },
        { gesture: "resolve", at: 3 },
      ]),
    ];
    expect(evaluateGestureTriggers(prev, next, 3)).toEqual([]);
  });

  it("lets question through the refractory and wins when several are due", () => {
    const prev = [baseLaneRender(0, [{ gesture: "arrive", at: 1 }])];
    const next = [
      baseLaneRender(0, [
        { gesture: "attention", at: 3 },
        { gesture: "question", at: 3 },
      ]),
    ];
    expect(evaluateGestureTriggers(prev, next, 3)).toEqual([
      { laneIndex: 0, gesture: "question", at: 3 },
    ]);
  });

  it("does not fire future or stale triggers", () => {
    expect(
      evaluateGestureTriggers(
        [baseLaneRender(0)],
        [baseLaneRender(0, [{ gesture: "arrive", at: 5 }])],
        1,
      ),
    ).toEqual([]);
    expect(
      evaluateGestureTriggers(
        [baseLaneRender(0)],
        [baseLaneRender(0, [{ gesture: "arrive", at: 1 }])],
        3,
      ),
    ).toEqual([]);
  });
});

describe("gesture player scheduling", () => {
  it("plays at most one gesture per lane at a time", () => {
    const player = new GesturePlayer();
    expect(player.play({ laneIndex: 0, gesture: "arrive", at: 1 }, 0.6)).not.toEqual([]);
    expect(player.play({ laneIndex: 0, gesture: "resolve", at: 1.5 }, 0.6)).toEqual([]);
  });

  it("lets question pre-empt, closing the lane's gesture bus first", () => {
    const player = new GesturePlayer();
    player.play({ laneIndex: 0, gesture: "attention", at: 1 }, 0.6);
    const events = player.play({ laneIndex: 0, gesture: "question", at: 1.2 }, 0.6);
    const cut = events[0];
    expect(cut?.kind).toBe("bus");
    if (cut?.kind === "bus") {
      expect(cut.from).toBe(1);
      expect(cut.to).toBe(0);
      expect(cut.endS - cut.startS).toBeGreaterThanOrEqual(0.005);
    }
    const firstNote = events.find((e) => e.kind === "note");
    if (firstNote?.kind === "note" && cut?.kind === "bus") {
      expect(firstNote.startS).toBeGreaterThanOrEqual(cut.endS - 1.2 - 1e-9);
    }
  });

  it("does not drop a completion while an arrival piano tail is still ringing", () => {
    const player = new GesturePlayer();
    player.play({ laneIndex: 0, gesture: "arrive", at: 1 }, 0.6);
    const completed = player.play({ laneIndex: 0, gesture: "resolve", at: 4.1 }, 0.6);
    expect(completed.filter((e) => e.kind === "note")).toHaveLength(5);
    expect(completed[0]).toMatchObject({ kind: "bus", from: 1, to: 0, startS: 0, endS: 0.05 });
  });
  it("keeps attention sparse: at least 12 s between piano rolls per lane", () => {
    const player = new GesturePlayer();
    expect(player.play({ laneIndex: 0, gesture: "attention", at: 2 }, 0.6)).not.toEqual([]);
    expect(player.play({ laneIndex: 0, gesture: "attention", at: 10 }, 0.6)).toEqual([]);
    expect(player.play({ laneIndex: 0, gesture: "attention", at: 14.5 }, 0.6)).not.toEqual([]);
  });
});

describe("recorded piano cue voicing", () => {
  it("draws every cue from the actual extended, borrowed or suspended chord in every tonal centre", () => {
    for (const chord of Object.keys(FIELD_CHORDS) as (keyof typeof FIELD_CHORDS)[]) {
      for (let tonic = 0; tonic < 12; tonic++) {
        const tones = fieldChordTones(chord, tonic);
        const bass = (FIELD_CHORDS[chord].bass + tonic) % 12;
        for (const cue of ["arrive", "question", "resolve", "attention", "overflow"] as const) {
          for (let lane = 0; lane < 4; lane++) {
            const notes = pianoChord(cue, lane, { chord, tonic, bass });
            expect(notes.length).toBe(cue === "attention" || cue === "overflow" ? 4 : 5);
            expect(new Set(notes).size).toBe(notes.length);
            for (const midi of notes) {
              expect(midi).toBeGreaterThanOrEqual(45);
              expect(midi).toBeLessThanOrEqual(84);
              expect([...tones, bass]).toContain((((midi - 2) % 12) + 12) % 12);
            }
          }
        }
      }
    }
  });
  it("rises on arrival, falls on completion, and holds overlapping recorded strings", () => {
    for (const gesture of ["arrive", "question", "resolve", "attention"] as const) {
      const events = driveScenario(scenarioFor(gesture, 0));
      const notes = notesOf(events);
      expect(notes.length).toBe(gesture === "attention" ? 4 : 5);
      for (const [i, note] of notes.entries()) {
        expect(note.instrument).toBe("piano");
        expect(note.attackS).toBeGreaterThanOrEqual(0.005);
        expect(note.pan).toBe(-0.6);
        expect(note.releaseS).toBeGreaterThanOrEqual(0.005);
        if (i > 0) {
          expect(note.startS).toBeGreaterThan(notes[i - 1]?.startS ?? 0);
          expect(notes[i - 1]?.holdUntilS ?? 0).toBeGreaterThan(note.startS);
        }
      }
      const pitches = notes.map((n) => n.midi);
      expect(pitches).toEqual([...pitches].sort((a, b) => (gesture === "resolve" ? b - a : a - b)));
      expect(events.every((e) => e.kind === "note" || e.kind === "bus")).toBe(true);
    }
  });
  it("keeps attention softer at higher Calm without changing its harmony", () => {
    const a = notesOf(gestureEvents({ laneIndex: 0, gesture: "attention", at: 0 }, 0));
    const b = notesOf(gestureEvents({ laneIndex: 0, gesture: "attention", at: 0 }, 1));
    expect(a.map((n) => n.midi)).toEqual(b.map((n) => n.midi));
    expect((b[0]?.gain ?? 0) / (a[0]?.gain ?? 1)).toBeCloseTo(10 ** (-4 / 20), 8);
  });
  it("renders the actual PCM with a natural decay, silence after release and no clicks", () => {
    for (const gesture of ["arrive", "question", "resolve", "attention"] as const) {
      const events = driveScenario(scenarioFor(gesture, 0));
      const result = renderGesturePlan(events, 8, { pianoSamples });
      const peak = Math.max(...result.left.subarray(0, 1000).map(Math.abs));
      expect(Number.isFinite(peak)).toBe(true);
      let max = 0,
        jump = 0,
        early = 0,
        late = 0;
      for (let i = 1; i < result.left.length; i++) {
        max = Math.max(max, Math.abs(result.left[i] ?? 0));
        jump = Math.max(jump, Math.abs((result.left[i] ?? 0) - (result.left[i - 1] ?? 0)));
        if (i < result.sampleRate) early += (result.left[i] ?? 0) ** 2;
        if (i > result.sampleRate * PIANO_CUE_END_S[gesture]) late += (result.left[i] ?? 0) ** 2;
      }
      expect(max).toBeGreaterThan(0.001);
      expect(jump).toBeLessThanOrEqual(0.3);
      expect(late).toBe(0);
      expect(early).toBeGreaterThan(0);
    }
  });
  it("rejects piano renders without recordings instead of silently synthesizing them", () => {
    expect(() =>
      renderGesturePlan(gestureEvents({ laneIndex: 0, gesture: "arrive", at: 0 }, 0.6), 5),
    ).toThrow("Piano PCM");
  });
});
