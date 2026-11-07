// packages/core/test/scene/field.test.ts — behaviour and property tests
// for the harmonic field (ADR 0025, ADR 0027): the harmony is a pure
// function of clock and seed; it walks a chord-progression graph rich in
// maj7, maj9, 6/9, sus4, 9sus4, minor 9/11 and borrowed chords; the bass
// follows each chord's bass (inversions and pedals included); one voice
// moves per event, at most a major third, at least four seconds apart;
// the tonal centre travels by related moves and keeps coming home; blooms
// fall on sounding chord tones inside the lookahead window.

import { describe, expect, it } from "vitest";

import {
  createRng,
  FIELD_ACTIVATION_ORDER,
  FIELD_CHORDS,
  FIELD_ENERGY_MAX,
  FIELD_ENERGY_MIN,
  FIELD_ENERGY_START,
  FIELD_EVENT_GAP_MIN_S,
  FIELD_KEY_MOVES,
  FIELD_PING_HIGH,
  FIELD_PING_LOOKAHEAD_S,
  FIELD_PING_LOW,
  FIELD_PROGRESSIONS,
  FIELD_SLOTS,
  FIELD_STEP_MAX,
  FIELD_VOICES_AT_ENERGY,
  type FieldChordName,
  type FieldState,
  fieldAt,
  fieldChordBass,
  fieldChordTones,
  fieldEnergyStep,
  fieldNextChord,
  fieldPitchClass,
  fieldPitchClasses,
  type LaneRender,
  nextBoundaryAfter,
  render,
  renderWithMacro,
  SceneParamsSchema,
} from "../../src/index.js";

const D = 0;
const G = 5;
const B = 9;

function lane(overrides: Partial<LaneRender> = {}): LaneRender {
  return {
    laneId: 0,
    lifecycle: "active",
    mode: { exploring: 1, editing: 0, testing: 0, other: 0 },
    displayedMode: "exploring",
    activity: 0.8,
    progress: 0.2,
    struggle: 0.1,
    prominence: 0.5,
    foreground: false,
    gestures: [],
    ...overrides,
  };
}

/** Samples the field every `stepS` over `untilS` for a seed. */
function trajectory(seed: number, untilS: number, stepS = 1): FieldState[] {
  const rng = createRng(seed);
  const states: FieldState[] = [];
  for (let t = 0; t <= untilS; t += stepS) {
    states.push(fieldAt(t, rng));
  }
  return states;
}

describe("chord vocabulary", () => {
  const names = Object.keys(FIELD_CHORDS) as FieldChordName[];

  it("goes somewhere from every chord, only to known chords, with weights that sum to one", () => {
    for (const name of names) {
      const options = FIELD_PROGRESSIONS[name];
      expect(options.length).toBeGreaterThan(0);
      for (const [target] of options) expect(names).toContain(target);
      const total = options.reduce((sum, [, weight]) => sum + weight, 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it("reaches every chord from the tonic", () => {
    const seen = new Set<FieldChordName>(["Imaj9"]);
    const queue: FieldChordName[] = ["Imaj9"];
    while (queue.length > 0) {
      const name = queue.shift() as FieldChordName;
      for (const [target] of FIELD_PROGRESSIONS[name]) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    expect([...seen].sort()).toEqual([...names].sort());
  });

  it("spells the chords the owner asked for: maj7, sus4, G and B at home", () => {
    expect(fieldChordTones("Imaj9", D)).toEqual([0, 4, 11, 2, 7, 9]);
    expect(fieldChordTones("Isus4", D)).toContain(G);
    expect(fieldChordTones("Isus4", D)).not.toContain(4);
    expect(fieldChordTones("IVmaj7#11", D)[0]).toBe(G);
    expect(fieldChordTones("vi9", D)[0]).toBe(B);
    expect(fieldChordBass("Imaj7/3", D)).toBe(4);
    expect(fieldChordBass("IVmaj9/I", D)).toBe(D);
    expect(fieldChordTones("Imaj9", 3)[0]).toBe(3);
  });

  it("follows the graph's weights", () => {
    expect(fieldNextChord("Isus4", 0)).toBe("Imaj9");
    expect(fieldNextChord("Isus4", 0.99)).toBe("I6/9");
  });
});

describe("energy walk", () => {
  it("charges one level at a time and releases from the peak", () => {
    expect(fieldEnergyStep(2, 0.1)).toBe(3);
    expect(fieldEnergyStep(2, 0.6)).toBe(2);
    expect(fieldEnergyStep(2, 0.9)).toBe(1);
    expect(fieldEnergyStep(FIELD_ENERGY_MAX, 0.1)).toBe(1);
    expect(fieldEnergyStep(FIELD_ENERGY_MAX, 0.9)).toBe(2);
    expect(fieldEnergyStep(FIELD_ENERGY_MIN, 0.9)).toBe(FIELD_ENERGY_MIN);
  });
});

describe("a rich harmonic life", () => {
  it("visits many chords and qualities, sounds G and B, and walks the bass", () => {
    for (const seed of [161, 7, 99, 2024]) {
      const states = trajectory(seed, 3600, 5);
      const chords = new Set(states.map((state) => state.chord));
      const qualities = new Set(states.map((state) => FIELD_CHORDS[state.chord].quality));
      const classes = new Set(states.flatMap((state) => [...fieldPitchClasses(state)]));
      let bassMoves = 0;
      for (let i = 1; i < states.length; i += 1) {
        if (states[i]?.bass !== states[i - 1]?.bass) bassMoves += 1;
      }
      expect(chords.size).toBeGreaterThanOrEqual(10);
      expect(qualities.has("sus4") || qualities.has("9sus4")).toBe(true);
      expect(qualities.has("maj7") || qualities.has("maj9")).toBe(true);
      expect(classes.has(G)).toBe(true);
      expect(classes.has(B)).toBe(true);
      // A chord every 15–40 s: the bass moves dozens of times an hour.
      expect(bassMoves).toBeGreaterThanOrEqual(30);
    }
  });
});

describe("voice leading", () => {
  it("moves one voice per event, at most a major third, at least four seconds apart", () => {
    for (const seed of [161, 99]) {
      const states = trajectory(seed, 3600, 1);
      let lastChangeAt = Number.NEGATIVE_INFINITY;
      for (let i = 1; i < states.length; i += 1) {
        const before = states[i - 1];
        const after = states[i];
        if (before === undefined || after === undefined) continue;
        let changed = 0;
        after.voices.forEach((voice, slot) => {
          const prior = before.voices[slot];
          if (prior === undefined || prior.midi === voice.midi) return;
          changed += 1;
          if (slot !== 0 && prior.midi !== null && voice.midi !== null) {
            expect(Math.abs(voice.midi - prior.midi)).toBeLessThanOrEqual(FIELD_STEP_MAX);
          }
        });
        expect(changed).toBeLessThanOrEqual(1);
        if (changed === 1) {
          expect(i - lastChangeAt).toBeGreaterThanOrEqual(FIELD_EVENT_GAP_MIN_S - 1);
          lastChangeAt = i;
        }
      }
    }
  });

  it("keeps every voice inside its slot window, never two on one pitch", () => {
    for (const seed of [161, 7, 99, 2024]) {
      for (const state of trajectory(seed, 3 * 3600, 13)) {
        state.voices.forEach((voice, slot) => {
          const spec = FIELD_SLOTS[slot];
          if (voice.midi === null) {
            expect(voice.level).toBe(0);
            return;
          }
          expect(voice.midi).toBeGreaterThanOrEqual(spec?.low ?? 0);
          expect(voice.midi).toBeLessThanOrEqual(spec?.high ?? 127);
          expect(voice.level).toBeGreaterThan(0);
          expect(voice.level).toBeLessThanOrEqual(1);
        });
        const pitches = state.voices.map((v) => v.midi).filter((m) => m !== null);
        expect(new Set(pitches).size).toBe(pitches.length);
      }
    }
  });

  it("mostly sounds the chord it is reaching for, with the bass on the chord's bass", () => {
    for (const seed of [161, 7]) {
      const states = trajectory(seed, 3600, 3);
      let inChord = 0;
      let onBass = 0;
      for (const state of states) {
        const tones = fieldChordTones(state.chord, state.tonic);
        const upper = state.voices.slice(1).filter((voice) => voice.midi !== null);
        if (upper.every((voice) => tones.includes(fieldPitchClass(voice.midi as number)))) {
          inChord += 1;
        }
        const ground = state.voices[0]?.midi;
        if (ground != null && fieldPitchClass(ground) === state.bass) onBass += 1;
      }
      expect(inChord / states.length).toBeGreaterThan(0.6);
      expect(onBass / states.length).toBeGreaterThan(0.8);
    }
  });

  it("settles to the voice count its energy declares by the end of every epoch", () => {
    const rng = createRng(161);
    let boundary = 0;
    for (let epoch = 0; epoch < 40; epoch += 1) {
      const next = nextBoundaryAfter(161, boundary);
      const settled = fieldAt(next - 1, rng);
      const sounding = settled.voices.filter((v) => v.midi !== null).length;
      expect(sounding).toBeLessThanOrEqual(FIELD_VOICES_AT_ENERGY[settled.energy - 1] ?? 0);
      boundary = next;
    }
  });

  it("starts at home on the tonic chord with the ground and the middle colour sounding", () => {
    expect(FIELD_ACTIVATION_ORDER.slice(0, 2)).toEqual([0, 2]);
    const start = fieldAt(0, createRng(161));
    expect(start.tonic).toBe(D);
    expect(start.chord).toBe("Imaj9");
    expect(start.energy).toBe(FIELD_ENERGY_START);
    expect(start.voices[2]?.midi).not.toBeNull();
    expect(fieldPitchClass(start.voices[0]?.midi ?? 0)).toBe(D);
  });
});

describe("blooms", () => {
  it("announces each bloom once by id inside the lookahead, on a chord tone in C5–C6", () => {
    const rng = createRng(161);
    const seen = new Map<number, number>();
    for (let t = 0; t < 1800; t += 0.5) {
      const state = fieldAt(t, rng);
      for (const ping of state.pings) {
        expect(ping.inS).toBeGreaterThanOrEqual(0);
        expect(ping.inS).toBeLessThan(FIELD_PING_LOOKAHEAD_S);
        expect(ping.midi).toBeGreaterThanOrEqual(FIELD_PING_LOW);
        expect(ping.midi).toBeLessThanOrEqual(FIELD_PING_HIGH);
        expect(ping.level).toBeGreaterThan(0);
        const then = fieldAt(t + ping.inS, rng);
        expect([...fieldPitchClasses(then), ...fieldChordTones(then.chord, then.tonic)]).toContain(
          fieldPitchClass(ping.midi),
        );
        const at = Math.round((t + ping.inS) * 100) / 100;
        const known = seen.get(ping.id);
        if (known !== undefined) expect(known).toBeCloseTo(at, 1);
        seen.set(ping.id, at);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(30);
    expect(seen.size).toBeLessThanOrEqual(130);
    const times = [...seen.values()].sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(14);
    }
  });
});

describe("field determinism and agent blindness", () => {
  it("is a pure function of clock and seed", () => {
    expect(fieldAt(1234, createRng(161))).toEqual(fieldAt(1234, createRng(161)));
    expect(fieldAt(1234, createRng(161))).not.toEqual(fieldAt(1234, createRng(162)));
    const rng = createRng(161);
    fieldAt(50_000, rng);
    expect(fieldAt(1234, rng)).toEqual(fieldAt(1234, createRng(161)));
  });

  it("renders the identical chord and blooms under idle, busy and waiting lanes", () => {
    const at = 900;
    const expected = renderWithMacro([], 0.6, {
      nowSeconds: at,
      seed: 161,
      presence: 0.7,
      calm: 0.6,
      applyWorld: true,
    }).macro;
    const traffic: LaneRender[][] = [
      [lane({ lifecycle: "idle", activity: 0 })],
      [
        lane({ lifecycle: "active", activity: 1, struggle: 1 }),
        lane({ laneId: 1, lifecycle: "waiting", activity: 1 }),
      ],
    ];
    for (const lanes of traffic) {
      const scene = renderWithMacro(
        lanes,
        0.6,
        { nowSeconds: at, seed: 161, presence: 0.7, calm: 0.6, applyWorld: true },
        lanes.map(() => 0),
      );
      expect(scene.macro.fieldVoices).toEqual(expected.fieldVoices);
      expect(scene.macro.pings).toEqual(expected.pings);
      expect(scene.macro.energy).toBe(expected.energy);
      expect(scene.macro.root).toBe(expected.root);
      expect(SceneParamsSchema.safeParse(scene).success).toBe(true);
    }
  });

  it("thins the chord under near-silence without changing it", () => {
    const routine = [lane({ activity: 0.5, struggle: 0.05 })];
    const loud = render(routine, 0.6);
    const hush = render(routine, 0.9);
    expect(hush.macro.fieldVoices).toEqual(loud.macro.fieldVoices);
    expect(hush.macro.fieldGain).toBeLessThan(loud.macro.fieldGain * 0.2);
  });

  it("gives the default render a sounding chord at epoch zero", () => {
    const scene = render([lane()], 0.6);
    expect(scene.macro.fieldVoices.filter((v) => v.midi !== null).length).toBeGreaterThanOrEqual(2);
    expect(scene.macro.energy).toBe(FIELD_ENERGY_START);
    expect(scene.macro.root).toBe(D);
  });
});

describe("tonal journey", () => {
  it("travels through many keys by related moves and keeps coming home to D", () => {
    for (const seed of [161, 7, 99, 2024]) {
      const rng = createRng(seed);
      const keys = new Set<number>();
      let homeEpochs = 0;
      let boundary = 0;
      let previous = fieldAt(0, rng);
      for (let epoch = 0; epoch < 150; epoch += 1) {
        boundary = nextBoundaryAfter(seed, boundary);
        const state = fieldAt(boundary + 0.01, rng);
        keys.add(state.tonic);
        if (state.tonic === 0) homeEpochs += 1;
        if (state.tonic !== previous.tonic) {
          const move = (state.tonic - previous.tonic + 12) % 12;
          expect([...FIELD_KEY_MOVES, (12 - previous.tonic) % 12]).toContain(move);
          expect(state.chord).toBe("Imaj9");
        }
        previous = state;
      }
      expect(keys.size).toBeGreaterThanOrEqual(6);
      expect(homeEpochs).toBeGreaterThanOrEqual(10);
    }
  });

  it("starts at home and leaves it within the first half hour", () => {
    const rng = createRng(161);
    expect(fieldAt(0, rng).tonic).toBe(0);
    const tonics = new Set<number>();
    for (let t = 0; t < 1800; t += 30) tonics.add(fieldAt(t, rng).tonic);
    expect(tonics.size).toBeGreaterThan(1);
  });
});
