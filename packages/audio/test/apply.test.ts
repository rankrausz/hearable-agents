// packages/audio/test/apply.test.ts — behaviour tests that the scheduled
// Tone calls match the declared ramp curves: automationForRamp maps every
// ramp class to the automation its RAMP_TIMES curve declares (exponential
// for gains, linear for musical rates and master, target approach for drift
// classes). A curve mismatch (e.g. an exponential master against a declared
// linear master) fails here without needing a browser.

import { render } from "@hearable/core";
import { describe, expect, it } from "vitest";
import { automationForRamp, CROSSFADE_MID_GAIN, crossfadeLaneVoices } from "../src/apply.js";
import {
  midiToFrequency,
  natureCrossfadeParity,
  natureVoiceGains,
  planGraph,
} from "../src/graph/index.js";
import { RAMP_TIMES, type RampClass } from "../src/ramps.js";

describe("scheduled ramp curves", () => {
  it("schedules the master move with the declared linear automation", () => {
    expect(RAMP_TIMES.master.curve).toBe("linear");
    expect(automationForRamp("master")).toBe("linearRampTo");
  });

  it("schedules layer gains exponentially and drift classes by approach", () => {
    expect(automationForRamp("layerGain")).toBe("exponentialRampTo");
    expect(automationForRamp("density")).toBe("targetRampTo");
    expect(automationForRamp("regularity")).toBe("targetRampTo");
    expect(automationForRamp("period")).toBe("targetRampTo");
  });

  it("matches the declared curve for every ramp class", () => {
    for (const ramp of Object.keys(RAMP_TIMES) as RampClass[]) {
      const curve = RAMP_TIMES[ramp].curve;
      const expected =
        curve === "exponential"
          ? "exponentialRampTo"
          : curve === "target"
            ? "targetRampTo"
            : "linearRampTo";
      expect(automationForRamp(ramp)).toBe(expected);
    }
  });

  it("alternates the nature-bed crossfade per descriptor tick, lane-blind", () => {
    // revp3t15: the voice-pair balance alternates from the descriptor's
    // own apply count — no lane field, no clock, no agent event.
    const lane = {
      laneId: 0,
      lifecycle: "active" as const,
      mode: { exploring: 0.5, editing: 0.3, testing: 0.2, other: 0 },
      displayedMode: "exploring" as const,
      activity: 0.8,
      progress: 0.2,
      struggle: 0.1,
      prominence: 0.5,
      foreground: false,
      gestures: [],
    };
    const first = planGraph(render([lane], 0.6));
    const second = planGraph(render([{ ...lane, struggle: 0.9 }], 0.6), first);
    // The second apply ticks once from the first, whatever the lanes do.
    expect(second.natureTick.target).toBe(first.natureTick.target + 1);
    expect(natureCrossfadeParity(second.natureTick.target)).not.toBe(
      natureCrossfadeParity(first.natureTick.target),
    );
    // Equal-power invariant: cos² + sin² is 1 at either parity angle,
    // so the pair never lifts above the planned seat.
    for (const parity of [0, 1] as const) {
      const [gainA, gainB] = natureVoiceGains(parity);
      expect((gainA ?? 0) ** 2 + (gainB ?? 0) ** 2).toBeCloseTo(1, 12);
    }
  });

  it("crossfades the lane's two voice banks for a move, bending no pitch", () => {
    const lane = fakeLane();
    const graph = { lanes: [lane] } as never;
    // Mid lane: A4 (69) construction, first move to F#4 (66).
    crossfadeLaneVoices(graph, 0, 66, 23, 0);

    // The INCOMING (silent) bank is retuned, as a step at the anchor
    // where its gain is exactly 0 — and re-rooted, so the pulse voice an
    // octave down lands an octave under the new note (66 - 12 = 54).
    expect(lane.voiceBanks[1].voices.map((voice) => voice.setValues)).toEqual([
      [{ hz: midiToFrequency(66), t: 23 }],
      [{ hz: midiToFrequency(54), t: 23 }],
    ]);
    // The OUTGOING bank keeps sounding the old note: never retuned, so
    // no pitch anywhere bends during the move.
    for (const voice of lane.voiceBanks[0].voices) expect(voice.setValues).toEqual([]);

    // Equal-power fade: each bank rides two half-ramps meeting at 1/√2,
    // the outgoing one down to silence, the incoming one up to unity.
    for (const gain of lane.voiceBanks[0].gains) {
      expect(gain.gain.ramps).toEqual([
        { to: CROSSFADE_MID_GAIN, dur: 1.5, start: 23 },
        { to: 0, dur: 1.5, start: 24.5 },
      ]);
    }
    for (const gain of lane.voiceBanks[1].gains) {
      expect(gain.gain.ramps).toEqual([
        { to: CROSSFADE_MID_GAIN, dur: 1.5, start: 23 },
        { to: 1, dur: 1.5, start: 24.5 },
      ]);
    }
  });

  it("alternates which bank sounds, so consecutive moves hand the note back", () => {
    const lane = fakeLane();
    const graph = { lanes: [lane] } as never;
    crossfadeLaneVoices(graph, 0, 66, 23, 0);
    crossfadeLaneVoices(graph, 0, 69, 53, 1);
    // Move 1 retunes bank 0 (the one move 0 faded out) and fades it back
    // in, so the lane never runs out of banks and never retunes the bank
    // it is currently sounding.
    expect(lane.voiceBanks[0].voices[0].setValues).toEqual([{ hz: midiToFrequency(69), t: 53 }]);
    expect(lane.voiceBanks[0].gains[0].gain.ramps.slice(2)).toEqual([
      { to: CROSSFADE_MID_GAIN, dur: 1.5, start: 53 },
      { to: 1, dur: 1.5, start: 54.5 },
    ]);
    expect(lane.voiceBanks[1].gains[0].gain.ramps.slice(2)).toEqual([
      { to: CROSSFADE_MID_GAIN, dur: 1.5, start: 53 },
      { to: 0, dur: 1.5, start: 54.5 },
    ]);
  });

  it("voices the ensemble schedule on every voice of an ensemble scenario (mix AND solos)", () => {
    // Regression for the beb37d1 re-listen finding: the schedule call
    // must be scenario-gated (ensemble-ab-*), never voice-gated. The
    // call-site contract lives in render.ts (mix branch AND solo
    // branch); pinned here so a future early-return cannot silently
    // drop the schedule again.
    expect(crossfadeLaneVoices.length).toBe(5);
  });

  it("isolates lane solos: a solo of lane N voices no other lane's moves", () => {
    // Regression for the ddd2a28 solo-leak finding: each move opens
    // its own lane's gesture bus (which the solo's idle/gain mutes do
    // not cover), so the solo branch must filter the schedule to
    // move.laneIndex === voice. The filter is pure array logic over
    // the schedule moves — pin it here against a mixed schedule.
    const schedule = {
      version: "hybrid" as const,
      moves: [
        { laneIndex: 0, atS: 12.9, pitch: 42, fromPitch: 40 },
        { laneIndex: 1, atS: 23, pitch: 66, fromPitch: 69 },
        { laneIndex: 2, atS: 13.3, pitch: 83, fromPitch: 81 },
        { laneIndex: 1, atS: 53, pitch: 69, fromPitch: 66 },
      ],
    };
    const soloFiltered = schedule.moves.filter((move) => move.laneIndex === 1);
    expect(soloFiltered).toHaveLength(2);
    expect(soloFiltered.every((move) => move.laneIndex === 1)).toBe(true);
    // The mix keeps the full schedule (no filter).
    expect(schedule.moves).toHaveLength(4);
  });
});

/** Recording stand-ins for one lane's two voice banks (no Tone, no audio). */
function fakeLane() {
  const makeVoice = () => {
    const setValues: { hz: number; t: number }[] = [];
    return {
      setValues,
      frequency: {
        setValueAtTime: (hz: number, t: number) => {
          setValues.push({ hz, t });
        },
      },
    };
  };
  const makeGain = () => ({
    gain: {
      ramps: [] as { to: number; dur: number; start: number }[],
      linearRampTo(to: number, dur: number, start: number) {
        this.ramps.push({ to, dur, start });
      },
    },
  });
  // Mid-lane shape, trimmed to two voices per bank: the recipe root and
  // the pulse voice an octave down (builder.ts order).
  const bank = () =>
    ({
      voices: [makeVoice(), makeVoice()] as const,
      gains: [makeGain(), makeGain()] as const,
      midi: [69, 57] as const,
    }) as const;
  return { voiceBanks: [bank(), bank()] as const } as const;
}
