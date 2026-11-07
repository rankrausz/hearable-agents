// packages/audio/test/plan.test.ts — behaviour tests for the pure
// SceneParams → ramp-plan mapping: every graph parameter gets a ramp class,
// the first plan holds (currents equal targets), later plans ramp from the
// previous targets, and tension uses attack on entry and release on exit.

import {
  type LaneRender,
  PULSE_PERIOD_RELAXED_S,
  PULSE_PERIOD_STUCK_S,
  render,
  renderWithMacro,
  type SceneParams,
  STUCK_GATE_MAX,
  STUCK_GATE_MIN,
  STUCK_RATE_FULL_HZ,
  STUCK_RATE_NARROW_HZ,
} from "@hearable/core";
import { describe, expect, it } from "vitest";

import {
  allParameters,
  gestureCalmCompensation,
  natureCrossfadeParity,
  planGraph,
  rateForPeriodS,
} from "../src/graph/index.js";
import { scenarioDrive } from "../src/qa/scenarios.js";
import { RAMP_TIMES } from "../src/ramps.js";

function laneRender(overrides: Partial<LaneRender> = {}): LaneRender {
  return {
    laneId: 0,
    lifecycle: "active",
    mode: { exploring: 0.5, editing: 0.3, testing: 0.2, other: 0 },
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

function sceneParams(lanes: LaneRender[], calm = 0.6): SceneParams {
  return render(lanes, calm);
}

describe("ramp plan", () => {
  it("exposes every graph parameter with its ramp class", () => {
    const params = sceneParams([
      laneRender(),
      laneRender({ laneId: 1 }),
      laneRender({ laneId: 2 }),
    ]);
    const plan = planGraph(params);
    expect(plan.lanes).toHaveLength(3);
    const flat = allParameters(plan);
    // 15 graph-level (master, bed, nature bed + tick, macro swell/cutoff/
    // field/pulse, field seat gain, 6 field voice gains) + 3 lanes × 14
    // lane entries (4 layer/cutoff/density + stuck depth/rate + pulse
    // gain/period + tension + reverb/brightness/width/pan + gesture
    // calm-comp). The count pins the contract: every entry below is
    // independently scheduled in apply.ts, so a miscount fails here
    // instead of hiding a dead or duplicated move.
    expect(flat).toHaveLength(15 + 3 * 14);
    const paths = flat.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    const byPath = new Map(flat.map((entry) => [entry.path, entry.ramp]));
    expect(byPath.get("master.gain")).toBe("master");
    expect(byPath.get("bed.gain")).toBe("room");
    // The sampled nature bed: density-scaled seat on the slow approach,
    // plus the lane-blind crossfade tick on the same class.
    expect(byPath.get("nature.bed")).toBe("density");
    expect(byPath.get("nature.tick")).toBe("density");
    // The macro world's own voice: swell on the slow density approach,
    // cutoffs on the cutoff class, pulse rate on the period approach.
    expect(byPath.get("macro.swell")).toBe("density");
    expect(byPath.get("macro.cutoff")).toBe("cutoff");
    expect(byPath.get("macro.field")).toBe("cutoff");
    expect(byPath.get("macro.pulse")).toBe("period");
    // The harmonic field (ADR 0025): seat on the density approach, each
    // slot level on the 12 s fieldVoice ramp.
    expect(byPath.get("macro.field.gain")).toBe("density");
    for (let slot = 0; slot < 6; slot += 1) {
      expect(byPath.get(`macro.field.voice${slot}.gain`)).toBe("fieldVoice");
    }
    expect(byPath.get("lanes.0.air.gain")).toBe("layerGain");
    expect(byPath.get("lanes.0.air.cutoff")).toBe("cutoff");
    expect(byPath.get("lanes.0.grain.density")).toBe("density");
    expect(byPath.get("lanes.0.grain.stuck")).toBe("regularity");
    expect(byPath.get("lanes.0.grain.stuckRate")).toBe("period");
    expect(byPath.get("lanes.0.pulse.periodRate")).toBe("period");
    expect(byPath.get("lanes.0.gesture.calm")).toBe("master");
    expect(byPath.get("lanes.0.pan")).toBe("pan");
    expect(byPath.get("lanes.0.width")).toBe("width");
    expect(byPath.get("lanes.0.reverb.send")).toBe("reverbSend");
    expect(byPath.get("lanes.0.brightness")).toBe("brightness");
  });

  it("seats the nature bed low on the density scale only", () => {
    // p3-t15 (ADR 0017 macro independence): the bed target is the
    // density share of the −44 dBFS seat — Calm thins it exactly the way
    // it thins routine density, and no lane field can steer it. Lane
    // traffic (mode, struggle, lifecycle) at fixed Calm plans the
    // identical bed; Calm moves it.
    const calm = (value: number): number =>
      planGraph(sceneParams([laneRender()], value)).nature.target;
    expect(calm(0.6)).toBeCloseTo(0.7 * 10 ** (-44 / 20), 12);
    expect(calm(0.6)).toBeLessThan(10 ** (-33 / 20));
    const busy = planGraph(
      sceneParams(
        [
          laneRender({
            mode: { exploring: 0.1, editing: 0.8, testing: 0.1, other: 0 },
            struggle: 1,
            lifecycle: "waiting",
          }),
        ],
        0.6,
      ),
    );
    const quiet = planGraph(sceneParams([laneRender({ lifecycle: "quiet" })], 0.6));
    expect(busy.nature.target).toBe(quiet.nature.target);
    expect(calm(0.9)).toBeLessThan(calm(0.6));
    expect(calm(0.6)).toBeLessThan(calm(0));
    expect(planGraph(sceneParams([laneRender()])).nature.ramp).toBe("density");
  });

  it("advances the nature-bed tick per apply and alternates the pair, lane-blind", () => {
    // revp3t15: the tick counts applies from the descriptor alone — lane
    // traffic (mode, struggle, lifecycle) at fixed Calm plans the same
    // alternation the tick proves, and the parity flips every apply.
    const busy = sceneParams(
      [
        laneRender({
          mode: { exploring: 0.1, editing: 0.8, testing: 0.1, other: 0 },
          struggle: 1,
          lifecycle: "waiting",
        }),
      ],
      0.6,
    );
    const idle = sceneParams([laneRender({ lifecycle: "idle" })], 0.6);
    let a = planGraph(busy);
    let b = planGraph(idle);
    expect(a.natureTick.target).toBe(0);
    expect(b.natureTick.target).toBe(0);
    for (let tick = 1; tick < 4; tick += 1) {
      const nextA = planGraph(busy, a);
      const nextB = planGraph(idle, b);
      expect(nextA.natureTick.target).toBe(tick);
      // Same tick from lane-heavy and lane-idle traffic: lane-blind.
      expect(nextB.natureTick.target).toBe(nextA.natureTick.target);
      expect(natureCrossfadeParity(nextA.natureTick.target)).not.toBe(
        natureCrossfadeParity(a.natureTick.target),
      );
      a = nextA;
      b = nextB;
    }
    // First apply holds (current equals target), later applies advance.
    expect(a.natureTick.current).toBe(a.natureTick.target);
  });

  it("holds on first apply and ramps on the second", () => {
    const first = planGraph(sceneParams([laneRender()]));
    for (const entry of allParameters(first)) {
      expect(entry.current).toBe(entry.target);
    }
    const louder = sceneParams([
      laneRender({ mode: { exploring: 0.1, editing: 0.8, testing: 0.1, other: 0 } }),
    ]);
    const second = planGraph(louder, first);
    const air = second.lanes[0]?.airGain;
    expect(air?.current).toBe(first.lanes[0]?.airGain.target);
    expect(air?.target).not.toBe(air?.current);
  });

  it("closes the stuck gate and contracts the pulse without detuning", () => {
    const loose = planGraph(sceneParams([laneRender({ struggle: 0 })]));
    expect(loose.lanes[0]?.grainStuck.target).toBe(STUCK_GATE_MIN);
    expect(loose.lanes[0]?.grainStuckRate.target).toBe(STUCK_RATE_FULL_HZ);
    expect(loose.lanes[0]?.pulsePeriodRate.target).toBe(rateForPeriodS(PULSE_PERIOD_RELAXED_S));
    const stuck = planGraph(sceneParams([laneRender({ struggle: 1 })]));
    expect(stuck.lanes[0]?.grainStuck.target).toBe(STUCK_GATE_MAX);
    expect(stuck.lanes[0]?.grainStuckRate.target).toBe(STUCK_RATE_NARROW_HZ);
    expect(stuck.lanes[0]?.pulsePeriodRate.target).toBe(rateForPeriodS(PULSE_PERIOD_STUCK_S));
    expect(stuck.lanes[0]?.grainStuck.ramp).toBe("regularity");
    expect(stuck.lanes[0]?.grainStuckRate.ramp).toBe("period");
    expect(stuck.lanes[0]?.pulsePeriodRate.ramp).toBe("period");
  });

  it("inverts the master Calm trim on the gesture trim at every Calm", () => {
    // ADR 0018 end-to-end invariance, plan half: the gesture trim's
    // linear target times the master's linear trim is exactly 1, so the
    // gesture path holds its level while routine presence falls.
    for (const calm of [0, 0.3, 0.6, 0.9, 1]) {
      const plan = planGraph(sceneParams([laneRender()], calm));
      const masterLinear = 10 ** (plan.master.target / 20);
      const trimLinear = plan.lanes[0]?.gestureCalm.target ?? Number.NaN;
      expect(trimLinear).toBeCloseTo(gestureCalmCompensation(plan.master.target), 12);
      expect(masterLinear * trimLinear).toBeCloseTo(1, 12);
    }
  });

  it("yields the routine path while waiting so the question onset separates", () => {
    // The waiting lane's own routine path ducks (tension holds the band
    // instead); the active lane holds at 0 dB of duck. The duck eases with
    // Calm (3.5 dB at calm 0 → 2 dB at calm 1) so it never double-ducks an
    // already quiet floor.
    const plan = planGraph(
      sceneParams([
        laneRender({ laneId: 0, lifecycle: "waiting" }),
        laneRender({ laneId: 1, lifecycle: "active" }),
      ]),
    );
    expect(plan.lanes[0]?.gestureCalm.target).toBeCloseTo(
      gestureCalmCompensation(plan.master.target),
      12,
    );
    expect(plan.lanes[0]?.gestureCalm.ramp).toBe("master");
  });

  it("attacks tension in 3 s and releases it in 5 s", () => {
    const routine = planGraph(sceneParams([laneRender()]));
    expect(routine.lanes[0]?.tensionGain.ramp).toBe("tensionAttack");
    const waiting = planGraph(sceneParams([laneRender({ lifecycle: "waiting" })]), routine);
    expect(waiting.lanes[0]?.tensionGain.ramp).toBe("tensionAttack");
    expect(RAMP_TIMES[waiting.lanes[0]?.tensionGain.ramp ?? "tensionAttack"].seconds).toBe(3.0);
    const released = planGraph(sceneParams([laneRender()]), waiting);
    expect(released.lanes[0]?.tensionGain.ramp).toBe("tensionRelease");
    expect(RAMP_TIMES[released.lanes[0]?.tensionGain.ramp ?? "tensionRelease"].seconds).toBe(5.0);
  });

  it("drives density through the 4 s drift ramp in grains/s", () => {
    const first = planGraph(sceneParams([laneRender()]));
    const density = first.lanes[0]?.grainDensity;
    expect(density?.ramp).toBe("density");
    expect(density?.target).toBeGreaterThanOrEqual(0.5);
    expect(density?.target).toBeLessThanOrEqual(4);
    const calmer = sceneParams([laneRender()], 0.9);
    const second = planGraph(calmer, first);
    expect(second.lanes[0]?.grainDensity.target).toBeLessThan(density?.target ?? 0);
  });

  it("declares the master move linear at 1.0 s", () => {
    const plan = planGraph(sceneParams([laneRender()]));
    expect(plan.master.ramp).toBe("master");
    expect(RAMP_TIMES.master.curve).toBe("linear");
    expect(RAMP_TIMES.master.seconds).toBe(1.0);
  });

  it("maps width onto the widener balance near unity", () => {
    const plan = planGraph(
      sceneParams([laneRender(), laneRender({ laneId: 1 }), laneRender({ laneId: 2 })]),
    );
    for (const lane of plan.lanes) {
      expect(lane.width.target).toBeGreaterThanOrEqual(0.5);
      expect(lane.width.target).toBeLessThanOrEqual(0.75);
    }
  });

  it("maps pans per lane register", () => {
    const plan = planGraph(
      sceneParams([laneRender(), laneRender({ laneId: 1 }), laneRender({ laneId: 2 })]),
    );
    expect(plan.lanes[0]?.pan.target).toBe(-0.6);
    expect(plan.lanes[1]?.pan.target).toBe(0);
    expect(plan.lanes[2]?.pan.target).toBe(0.6);
  });

  it("tracks prominence on the per-lane reverb send (foreground-switch mapping)", () => {
    // The browser mix cannot separate wet from dry, so this Node-level
    // assertion owns the mapping half of the foreground-switch scenario:
    // the send target must rise monotonically as prominence falls (far =
    // wet) and land on the documented shares of REVERB_SEND_BASE.
    const plan = planGraph(
      sceneParams([
        laneRender({ laneId: 0, prominence: 1, foreground: true }),
        laneRender({ laneId: 1, prominence: 0.15 }),
        laneRender({ laneId: 2, prominence: 0.5 }),
      ]),
    );
    const sends = plan.lanes.map((lane) => lane.reverbSend.target);
    expect(sends[0]).toBeLessThan(sends[2] ?? 0);
    expect(sends[2]).toBeLessThan(sends[1] ?? 0);
    for (const send of sends) {
      expect(send).toBeGreaterThan(0);
      expect(send).toBeLessThanOrEqual(0.5);
    }
  });

  it("orders the reverb send A->B->C across the foreground-switch steps", () => {
    // ORDER half of the mapping: in each scenario step the foreground
    // lane must hold the driest (lowest) send. Mirrors the browser solo
    // matrix, which proves the audio half (each lane loudest in its own
    // window); together they cover mapping + render without claiming a
    // wet/dry ratio the mix cannot separate.
    const drive = scenarioDrive("foreground-switch");
    expect(drive.steps).toHaveLength(3);
    for (const step of drive.steps) {
      const plan = planGraph(render([...step.lanes], drive.calm));
      const sends = plan.lanes.map((lane) => lane.reverbSend.target);
      const foreground = step.lanes.findIndex((lane) => lane.foreground);
      expect(foreground).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < sends.length; i++) {
        if (i !== foreground) {
          expect(sends[foreground]).toBeLessThan(sends[i] ?? 0);
        }
      }
    }
  });

  it("ramps the macro swell on the slow density approach", () => {
    const first = planGraph(sceneParams([laneRender()]));
    expect(first.macroSwell.ramp).toBe("density");
    expect(first.macroSwell.current).toBe(first.macroSwell.target);
    expect(first.macroSwell.target).toBeGreaterThanOrEqual(0);
    expect(first.macroSwell.target).toBeLessThanOrEqual(1);
    const louder = sceneParams([laneRender({ activity: 1 })]);
    const second = planGraph(louder, first);
    expect(second.macroSwell.current).toBe(first.macroSwell.target);
  });

  it("voices the checkpoint through cutoffs and pulse on declared classes", () => {
    // revp3t12: the checkpoint's harmonic content reaches audio — swell
    // air-band and field low-pass on the 2 s cutoff class, breathing
    // rate on the 4 s period approach. No new class invented.
    const first = planGraph(sceneParams([laneRender()]));
    expect(first.macroCutoff.ramp).toBe("cutoff");
    expect(first.macroField.ramp).toBe("cutoff");
    expect(first.macroPulse.ramp).toBe("period");
    expect(RAMP_TIMES.cutoff.seconds).toBe(2.0);
    expect(RAMP_TIMES.period.seconds).toBe(4.0);
    expect(first.macroCutoff.target).toBeGreaterThanOrEqual(800);
    expect(first.macroCutoff.target).toBeLessThanOrEqual(3000);
    expect(first.macroField.target).toBeGreaterThanOrEqual(1100);
    expect(first.macroField.target).toBeLessThanOrEqual(1700);
    expect(first.macroPulse.target).toBeGreaterThanOrEqual(0.05);
    expect(first.macroPulse.target).toBeLessThanOrEqual(0.45);
    // A new checkpoint moves all three: the world re-voices audibly.
    const params = renderWithMacro([laneRender()], 0.6, {
      nowSeconds: 500,
      seed: 161,
      presence: 0.7,
      calm: 0.6,
      applyWorld: true,
    });
    const second = planGraph(params, first);
    expect(second.macroCutoff.current).toBe(first.macroCutoff.target);
    expect(second.macroField.current).toBe(first.macroField.target);
    expect(second.macroPulse.current).toBe(first.macroPulse.target);
  });

  it("ramps toward silence through positive gains only", () => {
    const loud = planGraph(sceneParams([laneRender({ activity: 1 })]));
    const silent = planGraph(sceneParams([laneRender({ lifecycle: "idle" })]), loud);
    for (const entry of allParameters(silent)) {
      if (entry.ramp === "layerGain") {
        expect(entry.target).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
