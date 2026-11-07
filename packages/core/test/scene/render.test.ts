// packages/core/test/scene/render.test.ts — behaviour tests for the
// docs/SOUND_DESIGN.md §Mapping formulas: presence and layer gains, the
// activity curve, lifecycle gains, the `other` split, tension on waiting,
// struggle texture, prominence proximity, Calm scaling, progress
// brightening, the turn_complete fade, idle silence, the loudness budget,
// and the near-silence case. Synthetic LaneRender inputs only; no audio.

import { describe, expect, it } from "vitest";

import {
  ACTIVITY_CURVE_EXPONENT,
  ACTIVITY_CURVE_FLOOR,
  AIR_RANGE_NARROW,
  AIR_RANGE_WIDE,
  activityCurve,
  BED_GAIN_NEAR_SILENCE_DBFS,
  BED_GAIN_NORMAL_DBFS,
  BRIGHTNESS_MAX_DB,
  BRIGHTNESS_MIN_DB,
  createRng,
  EMPTY_ROOM_BED_DBFS,
  EMPTY_ROOM_DENSITY_SCALE,
  EMPTY_ROOM_FIELD_SCALE,
  FIELD_VOICES_QUIET,
  FOREGROUND_GAIN_NUDGE_DB,
  fieldVoiceCap,
  LANE_CAP,
  type LaneRender,
  LIFECYCLE_GAIN_ACTIVE,
  LIFECYCLE_GAIN_QUIET,
  LIFECYCLE_GAIN_STALE,
  LIFECYCLE_GAIN_WAITING,
  LOUDNESS_BUDGET_LINEAR,
  LOUDNESS_KNEE_LINEAR,
  MACRO_PRESENCE_SEATS,
  macroPresence,
  PROGRESS_CUTOFF_BRIGHTENING,
  PULSE_PERIOD_RELAXED_S,
  PULSE_PERIOD_STUCK_S,
  REVERB_SEND_MAX,
  REVERB_SEND_MIN,
  ROUTINE_CALM_SCALE,
  render,
  renderWithMacro,
  type SceneParams,
  STUCK_GATE_MAX,
  STUCK_GATE_MIN,
  STUCK_RATE_FULL_HZ,
  STUCK_RATE_NARROW_HZ,
  TEXTURE_NEAR_SILENCE_DBFS,
  TURN_COMPLETE_FADE_SECONDS,
  TURN_COMPLETE_TARGET_GAIN,
  WIDTH_MAX,
  WIDTH_MIN,
} from "../../src/index.js";

function lane(overrides: Partial<LaneRender> = {}): LaneRender {
  return {
    laneId: 0,
    lifecycle: "active",
    mode: { exploring: 1, editing: 0, testing: 0, other: 0 },
    displayedMode: "exploring",
    activity: 1,
    progress: 0,
    struggle: 0,
    prominence: 0.25,
    foreground: false,
    gestures: [],
    ...overrides,
  };
}

function approx(actual: number, expected: number, epsilon = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(epsilon);
}

function voiceAt(scene: SceneParams, index: number): SceneParams["lanes"][number] {
  const voice = scene.lanes[index];
  if (voice === undefined) throw new Error(`expected lane at index ${index}`);
  return voice;
}

describe("activity curve", () => {
  it("leaves a quiet lane present and a busy lane full", () => {
    approx(activityCurve(0), ACTIVITY_CURVE_FLOOR);
    approx(activityCurve(1), 1);
    approx(
      activityCurve(0.5),
      ACTIVITY_CURVE_FLOOR + (1 - ACTIVITY_CURVE_FLOOR) * 0.5 ** ACTIVITY_CURVE_EXPONENT,
    );
  });
});

describe("presence and layer gains", () => {
  it("routes mode weights to their layers with activity, calm and lifecycle", () => {
    const calm = 0.6;
    const rendered = render(
      [
        lane({
          mode: { exploring: 0.6, editing: 0.3, testing: 0.1, other: 0 },
          activity: 0.8,
        }),
      ],
      calm,
    );
    const voice = voiceAt(rendered, 0);
    const laneGain = activityCurve(0.8) * (1 - ROUTINE_CALM_SCALE * calm) * LIFECYCLE_GAIN_ACTIVE;
    approx(voice.presence, laneGain);
    approx(voice.layers.air, laneGain * 0.6);
    approx(voice.layers.grain, laneGain * 0.3);
    approx(voice.layers.pulse, laneGain * 0.1);
  });

  it("splits other evenly between air and grain with no dedicated layer", () => {
    // Quiet enough that the loudness budget stays disengaged: with activity
    // 0 the presence is the curve floor, well below the knee, so the layer
    // gains read exactly.
    const rendered = render(
      [lane({ mode: { exploring: 0, editing: 0, testing: 0, other: 1 }, activity: 0 })],
      0,
    );
    const voice = voiceAt(rendered, 0);
    approx(voice.layers.air, voice.presence * 0.5);
    approx(voice.layers.grain, voice.presence * 0.5);
    approx(voice.layers.pulse, 0);
  });

  it("applies each lifecycle gain", () => {
    const cases = [
      ["active", LIFECYCLE_GAIN_ACTIVE],
      ["quiet", LIFECYCLE_GAIN_QUIET],
      ["stale", LIFECYCLE_GAIN_STALE],
      ["waiting", LIFECYCLE_GAIN_WAITING],
    ] as const;
    for (const [lifecycle, gain] of cases) {
      const rendered = render([lane({ lifecycle })], 0);
      approx(voiceAt(rendered, 0).presence, activityCurve(1) * gain);
    }
  });

  it("keeps an idle lane silent", () => {
    const rendered = render([lane({ lifecycle: "idle", activity: 1 })], 0);
    const voice = voiceAt(rendered, 0);
    approx(voice.presence, 0);
    approx(voice.layers.air, 0);
    approx(voice.layers.grain, 0);
    approx(voice.layers.pulse, 0);
    expect(voice.tension.on).toBe(false);
    approx(voice.tension.gain, 0);
  });

  it("produces no lanes for zero lanes", () => {
    const rendered = render([], 0.6);
    expect(rendered.lanes).toEqual([]);
    approx(rendered.bed.gainDbfs, EMPTY_ROOM_BED_DBFS);
  });

  it("renders three lanes with stable per-lane identity", () => {
    const rendered = render([lane({ laneId: 0 }), lane({ laneId: 1 }), lane({ laneId: 2 })], 0);
    expect(rendered.lanes.map((voice) => voice.laneId)).toEqual([0, 1, 2]);
  });
});

describe("tension on waiting", () => {
  it("holds the tension layer only while waiting", () => {
    const waiting = voiceAt(render([lane({ lifecycle: "waiting" })], 0.6), 0);
    expect(waiting.tension.on).toBe(true);
    approx(waiting.tension.gain, LIFECYCLE_GAIN_WAITING);
    const active = voiceAt(render([lane({ lifecycle: "active" })], 0.6), 0);
    expect(active.tension.on).toBe(false);
    approx(active.tension.gain, 0);
  });

  it("keeps the waiting tension gain invariant across Calm 0, 0.6 and 1", () => {
    for (const calm of [0, 0.6, 1]) {
      const waiting = voiceAt(render([lane({ lifecycle: "waiting" })], calm), 0);
      expect(waiting.tension.on).toBe(true);
      approx(waiting.tension.gain, LIFECYCLE_GAIN_WAITING);
    }
  });
});

describe("struggle texture", () => {
  it("closes the stuck gate and contracts the pulse as struggle rises", () => {
    const loose = voiceAt(render([lane({ struggle: 0 })], 0), 0);
    approx(loose.grain.stuckDepth, STUCK_GATE_MIN);
    approx(loose.grain.pulsePeriodS, PULSE_PERIOD_RELAXED_S);
    approx(loose.grain.stuckRateHz, STUCK_RATE_FULL_HZ);
    approx(loose.pulse.pulsePeriodS, PULSE_PERIOD_RELAXED_S);
    const stuck = voiceAt(render([lane({ struggle: 1 })], 0), 0);
    approx(stuck.grain.stuckDepth, STUCK_GATE_MAX);
    approx(stuck.grain.pulsePeriodS, PULSE_PERIOD_STUCK_S);
    approx(stuck.grain.stuckRateHz, STUCK_RATE_NARROW_HZ);
    approx(stuck.pulse.pulsePeriodS, PULSE_PERIOD_STUCK_S);
  });

  it("keeps the stuck gate shut below the stick threshold, then closes it", () => {
    approx(voiceAt(render([lane({ struggle: 0 })], 0), 0).grain.stuckDepth, STUCK_GATE_MIN);
    approx(voiceAt(render([lane({ struggle: 0.15 })], 0), 0).grain.stuckDepth, STUCK_GATE_MIN);
    const mid = voiceAt(render([lane({ struggle: 0.65 })], 0), 0).grain.stuckDepth;
    expect(mid).toBeGreaterThan(STUCK_GATE_MIN);
    expect(mid).toBeLessThan(STUCK_GATE_MAX);
    approx(voiceAt(render([lane({ struggle: 1 })], 0), 0).grain.stuckDepth, STUCK_GATE_MAX);
  });

  it("narrows the note set only above struggle 0.6", () => {
    expect(voiceAt(render([lane({ struggle: 0.6 })], 0), 0).grain.noteSet).toBe("full");
    expect(voiceAt(render([lane({ struggle: 0.61 })], 0), 0).grain.noteSet).toBe("narrow");
  });

  it("shrinks the air drift range as struggle rises", () => {
    approx(voiceAt(render([lane({ struggle: 0 })], 0), 0).air.cutoffRange, AIR_RANGE_WIDE);
    approx(voiceAt(render([lane({ struggle: 1 })], 0), 0).air.cutoffRange, AIR_RANGE_NARROW);
  });

  it("never raises gain with struggle", () => {
    const calm = voiceAt(render([lane({ struggle: 0 })], 0), 0);
    const stuck = voiceAt(render([lane({ struggle: 1 })], 0), 0);
    expect(stuck.layers.air).toBeLessThanOrEqual(calm.layers.air);
    expect(stuck.layers.grain).toBeLessThanOrEqual(calm.layers.grain);
    expect(stuck.layers.pulse).toBeLessThanOrEqual(calm.layers.pulse);
  });
});

describe("prominence proximity", () => {
  it("moves a lane closer without making it louder", () => {
    const far = voiceAt(render([lane({ prominence: 0 })], 0), 0);
    const near = voiceAt(render([lane({ prominence: 1 })], 0), 0);
    approx(far.proximity.reverbSend, REVERB_SEND_MIN);
    approx(near.proximity.reverbSend, REVERB_SEND_MAX);
    approx(far.proximity.brightnessDb, BRIGHTNESS_MIN_DB);
    approx(near.proximity.brightnessDb, BRIGHTNESS_MAX_DB);
    approx(far.proximity.width, WIDTH_MIN);
    approx(near.proximity.width, WIDTH_MAX);
    approx(far.layers.air, near.layers.air);
  });

  it("nudges only the foreground lane by +2 dB", () => {
    approx(voiceAt(render([lane({ foreground: false })], 0), 0).proximity.gainNudgeDb, 0);
    approx(
      voiceAt(render([lane({ foreground: true })], 0), 0).proximity.gainNudgeDb,
      FOREGROUND_GAIN_NUDGE_DB,
    );
  });
});

describe("calm", () => {
  it("scales routine presence, density and master gain at calm 0, 0.6 and 1", () => {
    for (const calm of [0, 0.6, 1]) {
      const rendered = render([lane()], calm);
      approx(rendered.masterGainDb, -6 * calm);
      approx(rendered.densityScale, 1 - 0.5 * calm);
      approx(
        voiceAt(rendered, 0).presence,
        activityCurve(1) * (1 - ROUTINE_CALM_SCALE * calm) * LIFECYCLE_GAIN_ACTIVE,
      );
    }
  });

  it("rests the bed at -40 dBFS only in the near-silence case", () => {
    const silent = render([lane({ lifecycle: "active", struggle: 0.1 })], 0.9);
    approx(silent.bed.gainDbfs, BED_GAIN_NEAR_SILENCE_DBFS);
    const busy = render([lane({ lifecycle: "waiting", struggle: 0.1 })], 0.9);
    approx(busy.bed.gainDbfs, BED_GAIN_NORMAL_DBFS);
    const loud = render([lane({ lifecycle: "active", struggle: 0.5 })], 0.9);
    approx(loud.bed.gainDbfs, BED_GAIN_NORMAL_DBFS);
  });

  it("keeps near-silence when the frame is padded with idle seats", () => {
    const routine = [0, 1, 2].map((laneId) => lane({ laneId, struggle: 0.1 }));
    const padded = [...routine, lane({ laneId: 3, lifecycle: "idle", activity: 0 })];
    approx(render(padded, 0.9).bed.gainDbfs, BED_GAIN_NEAR_SILENCE_DBFS);
    approx(render(routine, 0.9).bed.gainDbfs, BED_GAIN_NEAR_SILENCE_DBFS);
  });

  it("drops to the empty-room floor when every seat is idle", () => {
    const empty = [0, 1, 2, 3].map((laneId) => lane({ laneId, lifecycle: "idle", activity: 0 }));
    const world = { nowSeconds: 300, seed: 161, presence: 0, calm: 0, applyWorld: true };
    const scene = renderWithMacro(empty, 0, world);
    approx(scene.bed.gainDbfs, EMPTY_ROOM_BED_DBFS);
    expect(scene.macro.textureSwell).toBe(0);
    const quiet = lane({ lifecycle: "quiet", activity: 0 });
    const working = renderWithMacro([quiet, ...empty.slice(1)], 0, world);
    approx(scene.macro.fieldGain, working.macro.fieldGain * EMPTY_ROOM_FIELD_SCALE);
    approx(scene.densityScale, working.densityScale * EMPTY_ROOM_DENSITY_SCALE);
  });

  it("wakes the room as soon as one lane is not idle", () => {
    const one = [lane({ lifecycle: "waiting" }), lane({ laneId: 1, lifecycle: "idle" })];
    expect(render(one, 0).bed.gainDbfs).toBeGreaterThan(EMPTY_ROOM_BED_DBFS);
  });

  it("caps near-silence textures at -48 dBFS", () => {
    const ceiling = 10 ** (TEXTURE_NEAR_SILENCE_DBFS / 20);
    const rendered = render([lane({ lifecycle: "active", struggle: 0.1 })], 0.9);
    for (const voice of rendered.lanes) {
      expect(voice.layers.air).toBeLessThanOrEqual(ceiling + 1e-12);
      expect(voice.layers.grain).toBeLessThanOrEqual(ceiling + 1e-12);
      expect(voice.layers.pulse).toBeLessThanOrEqual(ceiling + 1e-12);
    }
  });
});

describe("progress brightening", () => {
  it("shifts the air cutoff up to +20% with progress", () => {
    approx(voiceAt(render([lane({ progress: 0 })], 0), 0).air.cutoff, 1);
    approx(
      voiceAt(render([lane({ progress: 1 })], 0), 0).air.cutoff,
      1 + PROGRESS_CUTOFF_BRIGHTENING,
    );
  });

  it("picks the upper register only above progress 0.6", () => {
    expect(voiceAt(render([lane({ progress: 0.6 })], 0), 0).grain.upperRegister).toBe(false);
    expect(voiceAt(render([lane({ progress: 0.61 })], 0), 0).grain.upperRegister).toBe(true);
  });
});

describe("turn_complete fade", () => {
  it("fades to the silence target over 4 s after resolve", () => {
    expect(TURN_COMPLETE_FADE_SECONDS).toBe(4);
    const start = voiceAt(render([lane({ lifecycle: "turn_complete" })], 0, [0]), 0);
    approx(start.presence, activityCurve(1) * 1 * 1);
    const done = voiceAt(render([lane({ lifecycle: "turn_complete" })], 0, [1]), 0);
    approx(done.presence, TURN_COMPLETE_TARGET_GAIN);
    approx(done.layers.air, 0);
  });
});

describe("loudness budget", () => {
  it("leaves a single quiet lane untouched", () => {
    const before = render([lane({ activity: 0 })], 0);
    const total = before.lanes.reduce(
      (sum, voice) => sum + voice.layers.air + voice.layers.grain + voice.layers.pulse,
      0,
    );
    expect(total).toBeLessThanOrEqual(LOUDNESS_BUDGET_LINEAR);
  });

  it("holds the texture sum within the budget for three loud lanes", () => {
    const rendered = render(
      [
        lane({ laneId: 0, activity: 1, prominence: 0.9 }),
        lane({ laneId: 1, activity: 1, prominence: 0.2 }),
        lane({ laneId: 2, activity: 1, prominence: 0.1 }),
      ],
      0,
    );
    const total = rendered.lanes.reduce(
      (sum, voice) => sum + voice.layers.air + voice.layers.grain + voice.layers.pulse,
      0,
    );
    expect(total).toBeLessThanOrEqual(LOUDNESS_BUDGET_LINEAR + 1e-9);
  });

  it("approaches the budget from below at four lanes, least prominent first", () => {
    // Seeded property over the full four-seat cap: the soft knee is the
    // same curve with one more contributor, so the sum never crosses the
    // budget, never steps below the knee, and the cut lands on the least
    // prominent lane before any nearer one.
    expect(LANE_CAP).toBe(4);
    const rng = createRng(0x7b03);
    const textures = (voice: SceneParams["lanes"][number]): number =>
      voice.layers.air + voice.layers.grain + voice.layers.pulse;
    for (let trial = 0; trial < 500; trial += 1) {
      const lanes = Array.from({ length: LANE_CAP }, (_, laneId) =>
        lane({
          laneId,
          activity: rng.next(),
          struggle: rng.next(),
          progress: rng.next(),
          prominence: rng.next(),
        }),
      );
      // Below the near-silence Calm, so a lane rendered alone and in the
      // ensemble differ only by the budget.
      const calm = rng.next() * 0.79;
      const rendered = render(lanes, calm);
      const unbudgeted = lanes.map((one) => textures(voiceAt(render([one], calm), 0)));
      const before = unbudgeted.reduce((sum, value) => sum + value, 0);
      const after = rendered.lanes.reduce((sum, voice) => sum + textures(voice), 0);
      expect(rendered.lanes).toHaveLength(LANE_CAP);
      expect(after).toBeLessThanOrEqual(LOUDNESS_BUDGET_LINEAR + 1e-9);
      if (before <= LOUDNESS_KNEE_LINEAR) {
        expect(after).toBeCloseTo(before, 12);
        continue;
      }
      expect(after).toBeLessThan(before);
      expect(after).toBeGreaterThanOrEqual(LOUDNESS_KNEE_LINEAR - 1e-9);
      const order = lanes
        .map((one, index) => ({ index, prominence: one.prominence }))
        .sort((a, b) => a.prominence - b.prominence);
      // A lane keeps any texture only once every less prominent lane gave
      // all of its own.
      let seenKept = false;
      for (const { index } of order) {
        const kept = textures(voiceAt(rendered, index)) / (unbudgeted[index] || 1);
        if (seenKept) expect(kept).toBeCloseTo(1, 9);
        if (kept > 1e-9) seenKept = true;
      }
    }
  });

  it("makes background lanes yield before the prominent lane", () => {
    const loud: LaneRender = lane({ activity: 1, prominence: 0.1 });
    const solo = voiceAt(render([loud], 0), 0);
    const mixed = render([loud, lane({ laneId: 1, activity: 1, prominence: 0.9 })], 0);
    const background = voiceAt(mixed, 0);
    const foreground = voiceAt(mixed, 1);
    const soloSum = solo.layers.air + solo.layers.grain + solo.layers.pulse;
    const backgroundSum = background.layers.air + background.layers.grain + background.layers.pulse;
    const foregroundSum = foreground.layers.air + foreground.layers.grain + foreground.layers.pulse;
    expect(backgroundSum).toBeLessThan(soloSum);
    expect(foregroundSum).toBeGreaterThanOrEqual(backgroundSum);
  });
});

describe("input clamping", () => {
  it("clamps out-of-range calm and signals to their edges", () => {
    const rendered = render([lane({ activity: 2, struggle: -1, prominence: 5, progress: 99 })], 99);
    approx(rendered.masterGainDb, -6);
    const voice = voiceAt(rendered, 0);
    // struggle -1 clamps to 0, so the stuck gate reads shut.
    approx(voice.grain.stuckDepth, STUCK_GATE_MIN);
    approx(voice.proximity.reverbSend, REVERB_SEND_MAX);
    approx(voice.air.cutoff, 1 + PROGRESS_CUTOFF_BRIGHTENING);
  });
});

describe("padding to the lane cap", () => {
  // p7b-t03 invariant: the live frame is padded with idle seats up to
  // LANE_CAP. An empty fourth seat must leave the three-seat mix and every
  // macro input exactly as the unpadded three-seat frame renders them.
  const LIFECYCLES: readonly LaneRender["lifecycle"][] = [
    "active",
    "quiet",
    "waiting",
    "stale",
    "idle",
    "turn_complete",
  ];

  it("renders a padded frame exactly as the unpadded three-seat frame", () => {
    const rng = createRng(0x7b0301);
    for (let trial = 0; trial < 300; trial += 1) {
      const three = [0, 1, 2].map((laneId) =>
        lane({
          laneId,
          lifecycle: LIFECYCLES[Math.floor(rng.next() * LIFECYCLES.length)] ?? "active",
          activity: rng.next(),
          struggle: rng.next() * 0.5,
          progress: rng.next(),
          prominence: rng.next(),
        }),
      );
      const padded = [
        ...three,
        ...Array.from({ length: LANE_CAP - three.length }, (_, index) =>
          lane({ laneId: three.length + index, lifecycle: "idle", activity: 0, prominence: 0 }),
        ),
      ];
      const calm = rng.next();
      const nowSeconds = rng.next() * 600;
      const unpaddedParams = renderWithMacro(three, calm, {
        nowSeconds,
        seed: 161,
        presence: macroPresence(three),
        calm,
        applyWorld: true,
      });
      const paddedParams = renderWithMacro(padded, calm, {
        nowSeconds,
        seed: 161,
        presence: macroPresence(padded),
        calm,
        applyWorld: true,
      });
      expect(macroPresence(padded)).toBe(macroPresence(three));
      expect(paddedParams.lanes.slice(0, three.length)).toEqual(unpaddedParams.lanes);
      expect(paddedParams.macro).toEqual(unpaddedParams.macro);
      expect(paddedParams.bed).toEqual(unpaddedParams.bed);
      expect(paddedParams.masterGainDb).toBe(unpaddedParams.masterGainDb);
      expect(paddedParams.densityScale).toBe(unpaddedParams.densityScale);
      // The mean over the three seats — the pre-fourth-seat live presence.
      const mean = three.reduce((sum, one) => sum + one.activity, 0) / MACRO_PRESENCE_SEATS;
      expect(macroPresence(three)).toBeCloseTo(mean, 12);
    }
  });

  it("caps presence at 1 when a fourth agent is busy", () => {
    const four = [0, 1, 2, 3].map((laneId) => lane({ laneId, activity: 1 }));
    expect(macroPresence(four)).toBe(1);
  });
});

describe("harmony follows the agents' activity", () => {
  const world = (presence: number) => ({
    nowSeconds: 1500,
    seed: 161,
    presence,
    calm: 0,
    applyWorld: true,
  });

  it("opens the chord out from three voices for quiet agents to five for busy ones", () => {
    expect(fieldVoiceCap(0)).toBe(FIELD_VOICES_QUIET);
    expect(fieldVoiceCap(1)).toBe(5);
    for (let presence = 0; presence < 1; presence += 0.1) {
      expect(fieldVoiceCap(presence + 0.1)).toBeGreaterThanOrEqual(fieldVoiceCap(presence));
    }
  });

  it("silences the latest voices first and never changes a pitch", () => {
    const active = [lane({ lifecycle: "active" })];
    for (let t = 0; t < 3600; t += 97) {
      const busy = renderWithMacro(active, 0, { ...world(1), nowSeconds: t }).macro;
      const quiet = renderWithMacro(active, 0, { ...world(0), nowSeconds: t }).macro;
      expect(quiet.fieldVoices.map((voice) => voice.midi)).toEqual(
        busy.fieldVoices.map((voice) => voice.midi),
      );
      const sounding = quiet.fieldVoices.filter((voice) => voice.level > 0).length;
      expect(sounding).toBeLessThanOrEqual(FIELD_VOICES_QUIET);
      expect(quiet.palette).toEqual(busy.palette);
      // The ground voice is first in the activation order: it always stays.
      if (busy.fieldVoices[0]?.midi != null) {
        expect(quiet.fieldVoices[0]?.level).toBe(busy.fieldVoices[0]?.level);
      }
    }
  });
});
