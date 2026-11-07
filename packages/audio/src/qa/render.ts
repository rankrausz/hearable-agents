// packages/audio/src/qa/render.ts — the browser QA render: one named
// scenario through Tone.Offline with the fixed seed. What this is for: the
// single code path e2e/audio-qa.spec.ts bundles for all eight scenarios —
// the same createScene/apply calls the live page makes, with every apply
// anchored at the transport callback time (so ramps land when the scenario
// says they do), drift from the seeded stepper, and Math.random pinned to
// the seeded RNG for the render. What it must not do: assert anything or
// touch the network — assertions live in the spec.

import { type LaneRender, macroPresence, render, renderWithMacro } from "@hearable/core";
import * as Tone from "tone";
import {
  applyToGraph,
  crossfadeLaneVoices,
  scheduleGesturePlan,
  scheduleOverflowCue,
} from "../apply.js";
import { createSeededDriftStepper, SPATIAL_CORRELATION_SECONDS } from "../drift.js";
import {
  driveScenario,
  evaluateGestureTriggers,
  type GestureName,
  GesturePlayer,
  scenarioFor,
} from "../gestures/index.js";
import { createScene, type GraphDescriptor, natureOffsets } from "../graph/index.js";
import { createOutputGate } from "../output-gate.js";
import { overflowCuePlan } from "../overflow.js";
import { PIANO_ASSET_URLS } from "../piano/assets.js";
import natureWavUrl from "../scenes/clearing/assets/nature-bed-soft-rain-12s.wav?url";
import type { ReplayDrive } from "./replay.js";
import {
  type EnsembleQaSchedule,
  QA_SEED,
  type QaScenarioName,
  scenarioDrive,
  TONAL_JOURNEY_START_S,
} from "./scenarios.js";

/** Re-exported for the Node trajectory tests (single pure surface). */
export { natureOffsets };

/**
 * The bundler-resolved URL the QA render fetches the nature bed from.
 * Live resolves the same `?url` import in the web build; the QA harness
 * serves the bundled bytes at this URL, so both fetch identical bytes
 * through the identical graph path.
 */
export const natureBundleUrl: string = natureWavUrl;

/** One rendered QA mix: stereo channels plus the sample rate. */
export type QaRenderResult = {
  readonly sampleRate: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
};

/** Which voice of a scenario a QA render isolates. */
export type QaRenderVoice =
  | "mix"
  | "bed"
  | "macro"
  | "nature"
  | 0
  | 1
  | 2
  | { readonly laneTimeline: number };

/**
 * Lane timeline solo (ADR 0025 follow-up): the named lane follows the
 * scenario's timeline through the mix path — every other lane idle, the
 * bed, the harmonic field, the swell, the nature bed and the shared air
 * parked — so a gate about the lane's own voice (the struggle-ramp
 * repetition read) hears the lane and not the world behind it. Unlike the
 * numeric lane solo, which is one static snapshot, this one moves with
 * the scenario.
 */
function laneTimelineOf(voice: QaRenderVoice): number | null {
  return typeof voice === "object" ? voice.laneTimeline : null;
}

/**
 * Minute-span clock for the spatial wander (p3-t16): every QA scenario
 * sounds the wander on `nowSeconds = renderT * SPATIAL_MINUTE_SPAN + 1`
 * (one wander epoch step inside a 60 s render at the same minute cadence
 * a long session hears), while the macro world, density and gestures
 * still read the true render time. Solos read the same scaled solo time,
 * so solos and mix never disagree on the space. Only the wander reads
 * this clock — nothing else moves.
 */
export const SPATIAL_MINUTE_SPAN = (2 * SPATIAL_CORRELATION_SECONDS) / 60;

function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function calmAt(drive: ReturnType<typeof scenarioDrive>): (t: number) => number {
  return (t: number) => {
    let calm = drive.calm;
    let prevT = 0;
    let prevCalm = drive.calm;
    for (const [atS, value] of drive.calmTrack) {
      if (t < atS) {
        const span = atS - prevT;
        return span <= 0 ? value : prevCalm + ((value - prevCalm) * (t - prevT)) / span;
      }
      prevT = atS;
      prevCalm = value;
      calm = value;
    }
    return calm;
  };
}

/**
 * Fade progress for turn_complete lanes: 0 at resolve (10 s), 1 when the
 * 4 s release ends (14 s). Every other lifecycle ignores the value.
 */
function fadeProgressFor(
  name: QaScenarioName,
  lanes: readonly LaneRender[],
  t: number,
): readonly number[] {
  if (name !== "resolve-fades") return lanes.map(() => 0);
  return lanes.map((lane) =>
    lane.lifecycle === "turn_complete" ? Math.min(1, Math.max(0, (t - 10) / 4)) : 0,
  );
}

/**
 * Macro modulation for a QA step (p3-t12): the scene clock is the render
 * time, the seed is the QA seed, and meso presence is the mean lane
 * presence — agent traffic scales the world, never re-triggers it.
 * `macro-evolution` and `harmonic-field` opt into the world's audible
 * voice on the render clock, `empty-room` too with its presence read from
 * the lanes (the room empties when the agent stops), and `tonal-journey`
 * on the clock offset to seed 161's first move of the tonal centre; every
 * other scenario sounds the world at its first checkpoint (the chord of
 * epoch 0, static).
 */
function macroFor(
  name: QaScenarioName,
  lanes: readonly LaneRender[],
  calm: number,
  t: number,
  seed: number,
): Parameters<typeof renderWithMacro>[2] | undefined {
  if (name === "empty-room") {
    return { nowSeconds: t, seed, presence: macroPresence(lanes), calm, applyWorld: true };
  }
  if (name === "tonal-journey") {
    return { nowSeconds: t + TONAL_JOURNEY_START_S, seed, presence: 0.7, calm, applyWorld: true };
  }
  if (name !== "macro-evolution" && name !== "harmonic-field") return undefined;
  return { nowSeconds: t, seed, presence: 0.7, calm, applyWorld: true };
}

function renderStep(
  name: QaScenarioName,
  lanes: readonly LaneRender[],
  calm: number,
  t: number,
  seed: number,
  fade: readonly number[],
): ReturnType<typeof render> {
  const macro = macroFor(name, lanes, calm, t, seed);
  if (macro === undefined) return render([...lanes], calm, fade);
  return renderWithMacro([...lanes], calm, macro, fade);
}

/**
 * Holds gain params at the exponential floor from `t` on, cancelling the
 * ramps the last apply scheduled: the solo voices mute nodes the applies
 * keep ramping, so the mute is re-asserted at every apply anchor.
 */
function parkSilent(params: readonly Tone.Param<"gain">[], t: number): void {
  for (const param of params) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(1e-7, t);
  }
}

export async function renderQaScenario(
  name: QaScenarioName,
  seed: number = QA_SEED,
  voice: QaRenderVoice = "mix",
  soloAtS = 0,
  ensembleSchedule?: EnsembleQaSchedule,
  playback?: readonly { atS: number; open: boolean }[],
): Promise<QaRenderResult> {
  const drive = scenarioDrive(name, seed);
  const calmFor = calmAt(drive);
  // Math.random is pinned to the seeded RNG for the render. Honest scope:
  // this seeds drift-adjacent JS randomness only — Tone's noise buffers,
  // noise start offsets and reverb IR draw from their own unseeded source,
  // so same-seed re-renders agree on levels, not bytes (see the
  // determinism check in e2e/audio-qa.spec.ts).
  const random = seededRandom(seed);
  const originalRandom = Math.random;
  Math.random = random;
  try {
    const buffer = await Tone.Offline(async (context) => {
      const laneCount =
        Math.max(...drive.steps.flatMap((step) => step.lanes.map((l) => l.laneId))) + 1;
      // Bundler-resolved asset URL + the render seed as offsets: live and
      // QA fetch identical bytes through the identical decode path, never
      // a divergent loader. Exported for the QA harness (the test server
      // maps this URL to the bundled bytes) and the live web build.
      const graph = createScene(Tone, {
        laneCount,
        natureAssetUrl: natureWavUrl,
        pianoAssetUrls: PIANO_ASSET_URLS,
        natureOffsets: natureOffsets(seed),
      });
      await graph.reverb.ready;
      // The nature bed shares the await-ready lifecycle: the QA and live
      // paths await the same `ready` surface before sounding anything, so
      // the two never diverge on asset loading.
      await graph.nature.ready;
      await graph.piano?.ready;
      if (playback !== undefined) {
        const gate = createOutputGate(Tone, graph);
        for (const step of playback) {
          context.transport.schedule((time) => gate.setOpen(step.open, time), step.atS);
        }
      }

      if (voice === "bed") {
        // Bed solo: every lane idle, so texture gains plan to silence and
        // the render carries the drone alone (the macro world is muted:
        // this solo isolates the drone, not the composition). No wander:
        // the bed is centre-panned by construction, never a lane region.
        const idle =
          drive.steps[0]?.lanes.map((lane) => ({ ...lane, lifecycle: "idle" as const })) ?? [];
        applyToGraph(graph, render([...idle], calmFor(0)), undefined, 0);
        graph.macro.swellGain.gain.value = 1e-7;
        graph.macro.fieldGain.gain.value = 1e-7;
      } else if (voice === "macro") {
        // Harmonic-field solo (ADR 0025; before it, the checkpoint trio plus
        // swell): every lane idle and the bed, the texture swell, the nature
        // bed and the shared air muted, so the render carries the chord
        // alone through the seeded epoch schedule. The field is a floor,
        // not a feature, so the gates compare per-window chroma/centroid
        // movement and bound the level, never chase it. The loop below
        // only builds the offline graph events (same-context nodes); the
        // transport scheduleRepeat underneath sounds the epoch trajectory
        // over time. Proves the harmonic content reaches audio. No wander:
        // every lane is idle, so there is no region to breathe.
        const idle =
          drive.steps[0]?.lanes.map((lane) => ({ ...lane, lifecycle: "idle" as const })) ?? [];
        const stepper = createSeededDriftStepper(seed);
        let descriptor: GraphDescriptor | undefined;
        const stepAt = (t: number): void => {
          const params = renderStep(
            name,
            idle,
            calmFor(t),
            t,
            seed,
            idle.map(() => 0),
          );
          // The chord is read with the scenario's own agents, not the idled
          // lanes: with every lane idle the room would empty (ADR 0027) and
          // the solo would measure the empty-room field, 26 dB under the
          // chord a listener hears while agents work.
          const world = renderStep(
            name,
            drive.steps[0]?.lanes ?? [],
            calmFor(t),
            t,
            seed,
            idle.map(() => 0),
          ).macro;
          descriptor = applyToGraph(
            graph,
            stepper.step({ ...params, macro: world }, 0.5),
            descriptor,
            t,
          );
          // Every apply ramps the bed, the nature bed and the swell back
          // toward their planned targets, so the solo re-parks them at
          // the anchor after each apply (a one-time mute would be undone
          // half a second later, and the "field solo" would be mostly
          // drone — which is exactly what the earlier numbers measured).
          parkSilent([graph.bed.gain.gain, graph.nature.gain.gain, graph.macro.swellGain.gain], t);
        };
        context.transport.scheduleRepeat(
          (t: number) => {
            stepAt(t);
          },
          0.5,
          0,
        );
        graph.bed.gain.gain.value = 1e-7;
        graph.air.gain.gain.value = 1e-7;
        graph.nature.gain.gain.value = 1e-7;
        graph.macro.swellGain.gain.value = 1e-7;
      } else if (typeof voice === "number") {
        // Lane solo with bed, macro world AND shared air muted: the
        // target lane's texture layers sound alone (its gesture bus
        // stays shut, so no gesture voices leak in); every other lane,
        // the bed, the macro voice and the mix-shared air plan to
        // silence. The ensemble schedule IS voiced here too
        // (scenario-gated, not voice-gated): a lane-1 solo of an
        // ensemble scenario isolates the moving lane WITH its moves,
        // which is how the per-move diagnosis separates the retune
        // from the mix. Bed/macro/air mute parks those gain nodes at the
        // exponential floor directly — all are pure levels with no
        // musical trajectory to preserve. The source
        // state is the step active at soloAtS (default 0): scenarios whose
        // assertion is about the late state (resolve-fades) pass the late
        // time; the foreground matrix passes each window's midpoint so the
        // solo hears the same step the window measures. The wander reads
        // the solo time on the same minute-span clock as the mix (the
        // solo's single apply lands inside the same epoch the window
        // measures), so solos and mix never disagree on the space.
        const soloT = soloAtS;
        const srcStep = [...drive.steps].reverse().find((s) => s.atS <= soloT) ?? drive.steps[0];
        const lanes = srcStep?.lanes ?? [];
        const params = render(
          lanes.map((lane) =>
            lane.laneId === voice
              ? lane
              : {
                  ...lane,
                  lifecycle: "idle" as const,
                  mode: { exploring: 0, editing: 0, testing: 0, other: 0 },
                },
          ),
          calmFor(soloT),
          fadeProgressFor(name, lanes, soloT),
        );
        applyToGraph(graph, params, undefined, 0, {
          seed,
          nowSeconds: soloT * SPATIAL_MINUTE_SPAN + 1,
        });
        // Scenario-gated, lane-filtered (beb37d1 re-listen finding +
        // ddd2a28 solo-leak fix): the ensemble schedule voices on EVERY
        // voice of an ensemble-ab-* scenario, solos included — otherwise
        // a solo renders the schedule silently and WITH/WITHOUT read
        // identically. In a numeric lane solo only that lane's moves
        // sound (each move opens its own lane's gesture bus, which the
        // idle/gain mutes above do not cover); the mix keeps the full
        // schedule.
        voiceEnsembleSchedule(graph, name, ensembleSchedule, voice);
        graph.bed.gain.gain.value = 1e-7;
        graph.macro.swellGain.gain.value = 1e-7;
        graph.macro.fieldGain.gain.value = 1e-7;
        // The shared HF air and the nature bed are mix-shared, not
        // lane-local: park both at the floor for lane solos the same way
        // the bed and macro are parked, so the solo hears the lane's own
        // trajectory the way the gate compares it (early vs late state).
        graph.air.gain.gain.value = 1e-7;
        graph.nature.gain.gain.value = 1e-7;
      }
      if (voice === "macro") {
        context.transport.start(0);
        return;
      }
      if (voice === "nature") {
        // Nature-bed solo (p3-t15): every lane idle, the drone and the
        // macro world muted, so the render carries the sampled bed alone
        // at its mix seat — the QA scenario entry proves the seat (low,
        // density-following, lane-blind) without gating a level the mix
        // cannot separate from the floor. Solo only; never a threshold.
        // The players start at the Offline origin when `ready` resolves
        // (before the transport starts); the solo applies the seat
        // directly and holds it through the transport schedule below —
        // the level reads the settled seat, never the startup climb.
        // No wander: every lane is idle, so there is no region to breathe.
        const idle =
          drive.steps[0]?.lanes.map((lane) => ({ ...lane, lifecycle: "idle" as const })) ?? [];
        const stepper = createSeededDriftStepper(seed);
        let descriptor: GraphDescriptor | undefined;
        const stepAt = (t: number): void => {
          const params = renderStep(
            name,
            idle,
            calmFor(t),
            t,
            seed,
            idle.map(() => 0),
          );
          descriptor = applyToGraph(graph, stepper.step(params, 0.5), descriptor, t);
          // Same re-parking as the macro solo: the applies would otherwise
          // ramp the bed, swell and field back up under the nature bed.
          parkSilent(
            [graph.bed.gain.gain, graph.macro.swellGain.gain, graph.macro.fieldGain.gain],
            t,
          );
        };
        context.transport.scheduleRepeat(
          (t: number) => {
            stepAt(t);
          },
          0.5,
          0,
        );
        graph.bed.gain.gain.value = 1e-7;
        graph.macro.swellGain.gain.value = 1e-7;
        graph.macro.fieldGain.gain.value = 1e-7;
        graph.air.gain.gain.value = 1e-7;
        context.transport.start(0);
        return;
      }
      const timelineLane = laneTimelineOf(voice);
      if (voice !== "mix" && timelineLane === null) return;
      if (timelineLane !== null) {
        graph.air.gain.gain.value = 1e-7;
      }
      const stepper = createSeededDriftStepper(seed);
      let descriptor: GraphDescriptor | undefined;
      // The transport anchors every apply at its callback time: Tone.now()
      // stays 0 inside Offline, so scheduling at now would pile every ramp
      // at t=0. Anchoring at the callback time lands each ramp when the
      // scenario says it happens; the repeat must be scheduled after the
      // reverb-ready await — a repeat scheduled before it never fires.
      // Slow spatial movement (p3-t16, ADR 0017): the render seed + render
      // time select the seeded macro wander (minute epochs, lane-blind) —
      // space moves on the macro schedule, never on lane state or agent
      // events. Every scenario sounds the wander on the minute-span clock
      // (one epoch step inside the render at the same cadence a long
      // session hears); the macro world, density and gestures still read
      // the true render time.
      const spaceSeed = seed;
      context.transport.scheduleRepeat(
        (t: number) => {
          const step = [...drive.steps].reverse().find((s) => s.atS <= t) ?? drive.steps[0];
          const stepLanes = step?.lanes ?? [];
          const lanes =
            timelineLane === null
              ? stepLanes
              : stepLanes.map((lane) =>
                  lane.laneId === timelineLane
                    ? lane
                    : {
                        ...lane,
                        lifecycle: "idle" as const,
                        mode: { exploring: 0, editing: 0, testing: 0, other: 0 },
                      },
                );
          const params = renderStep(
            name,
            lanes,
            calmFor(t),
            t,
            seed,
            fadeProgressFor(name, lanes, t),
          );
          descriptor = applyToGraph(graph, stepper.step(params, 0.5), descriptor, t, {
            seed: spaceSeed,
            // The wander sounds the minute-span clock (one epoch step
            // inside the render); everything else reads the true time.
            nowSeconds: t * SPATIAL_MINUTE_SPAN + 1,
          });
          if (timelineLane !== null) {
            parkSilent(
              [
                graph.bed.gain.gain,
                graph.nature.gain.gain,
                graph.macro.swellGain.gain,
                graph.macro.fieldGain.gain,
              ],
              t,
            );
          }
        },
        0.5,
        0,
      );
      // waiting-holds and resolve-fades play their gesture through the same
      // named GESTURE_SCENARIOS inputs the gesture suite proves in Node.
      // Voices are created up front (same-context nodes); the transport
      // callback only opens the gesture bus, so the gesture sounds from 10 s
      // without crossing the offline contexts. The gesture-plan call below
      // MUST run synchronously inside this Offline callback (before the
      // transport starts): nodes created here belong to the Offline
      // context, and a plan scheduled from a nested transport callback
      // would sound nothing. The same holds for voiceEnsembleSchedule.
      const gesture = gestureForScenario(name);
      if (gesture !== null) {
        const laneIndex = drive.gestures[0]?.laneIndex ?? 1;
        const triggerAt = name.startsWith("ensemble-ab-") ? 60 : 10;
        const events = driveScenario(scenarioFor(gesture, laneIndex, calmFor(triggerAt)));
        // Single anchoring: the event plan's offsets are relative to the
        // trigger, and scheduleGesturePlan adds `now` to every offset
        // (note startS, bus startS/endS, swell startS). Pass the trigger
        // time as `now` and hand the plan over unshifted — shifting the
        // events AND passing now would sound the gesture twice as late.
        scheduleGesturePlan(graph, events, triggerAt);
      }
      // Named extra cues (ensemble A/B resolve at 110 s): same named
      // GESTURE_SCENARIOS inputs, scheduled at their own trigger times.
      for (const extra of extraGesturesFor(name)) {
        const laneIndex = drive.gestures[1]?.laneIndex ?? 2;
        scheduleGesturePlan(
          graph,
          driveScenario(scenarioFor(extra.gesture, laneIndex, calmFor(extra.at))),
          extra.at,
        );
      }
      // Named routine-note schedule (ensemble A/B): the caller threads
      // the version's move plan (see EnsembleQaSchedule) — the audition
      // schedulers' plans or the p5-t02 core harmonic planner's
      // `HarmonicMove` plans voiced through the p5-t03 seam
      // (`harmonicVoicePlan`, same shape, tagged `"harmonic"`) — and the
      // entry crossfades each move's lane over the `crossfade` class.
      voiceEnsembleSchedule(graph, name, ensembleSchedule);
      context.transport.start(0);
    }, drive.durationS);
    const left = Float32Array.from(buffer.getChannelData(0));
    const right = Float32Array.from(buffer.getChannelData(1));
    return { sampleRate: buffer.sampleRate, left, right };
  } finally {
    Math.random = originalRandom;
  }
}

function gestureForScenario(name: QaScenarioName): GestureName | null {
  if (name === "waiting-holds") return "question";
  if (name === "resolve-fades") return "resolve";
  if (name === "ensemble-ab-independent" || name === "ensemble-ab-hybrid") return "question";
  return null;
}

/**
 * Voices a named ensemble routine-note schedule onto the graph: each
 * (lane, time, pitch) move crossfades the lane's two voice banks over the
 * crossfade class (3 s) — the old note fades out while the new one fades
 * in — and nothing else. The move IS the lane changing note.
 *
 * It used to glide the pitch instead (portamento class); the owner heard
 * that as too weird at any length, so the pitch no longer bends at all.
 *
 * The p5-t01 refinement after the owner's listen removed the soft
 * two-note articulation that used to sound on each move through the
 * lane's gesture bus: with the sustained voices actually moving, the
 * articulation was a second, percussive event on top of the morph —
 * "sudden notes", the one thing a routine move must not be. The hard
 * cues (question at 60 s, resolve at 110 s) are untouched: those are
 * production grammar and are SUPPOSED to arrive as events.
 */
function voiceEnsembleSchedule(
  graph: Parameters<typeof scheduleGesturePlan>[0],
  name: QaScenarioName,
  schedule: EnsembleQaSchedule | undefined,
  laneFilter?: QaRenderVoice,
): void {
  if (
    schedule === undefined ||
    (name !== "ensemble-ab-independent" && name !== "ensemble-ab-hybrid")
  ) {
    return;
  }
  // The lane's own sustained voices hand the note over on the
  // crossfade class (3 s), anchored at the move time, so the lane's
  // continuous texture carries the new pitch until the next move. No
  // event is voiced on top: the pitch change is the whole gesture.
  // Lane filter (ddd2a28 solo-leak fix): a numeric lane solo retunes
  // only that lane, so a solo isolates one lane's trajectory. The mix
  // (no filter) keeps the full schedule.
  const moves =
    typeof laneFilter === "number"
      ? schedule.moves.filter((move) => move.laneIndex === laneFilter)
      : schedule.moves;
  // Per-lane move index: which of the lane's two voice banks is handing
  // the note over. Moves arrive in schedule order, so counting them per
  // lane keeps the crossfade stateless (even moves hand bank 0 -> 1, odd
  // moves hand it back).
  const moveIndex = new Map<number, number>();
  for (const move of moves) {
    const index = moveIndex.get(move.laneIndex) ?? 0;
    moveIndex.set(move.laneIndex, index + 1);
    crossfadeLaneVoices(graph, move.laneIndex, move.pitch, move.atS, index);
  }
}

/**
 * Extra cue triggers per QA scenario beyond the single gestureForScenario
 * cue: the ensemble A/B slices carry both the waiting question (60 s) and
 * the completion resolve (110 s) on lane 2, so the render proves the
 * shared hard cues sound identically under both routine-note schedules.
 */
function extraGesturesFor(name: QaScenarioName): readonly { at: number; gesture: GestureName }[] {
  if (name === "ensemble-ab-independent" || name === "ensemble-ab-hybrid") {
    return [{ at: 110, gesture: "resolve" }];
  }
  return [];
}

/**
 * Renders a p4-t06 replay drive through the same graph calls the live page
 * makes (apps/web/src/audio.ts): per-step scene applies anchored at the
 * transport callback time (the live feed's 0.5 s scene-param ticks), seeded
 * drift, the seeded macro wander, and the gesture path the live page takes —
 * evaluateGestureTriggers over the streamed LaneRender frames (busy holds,
 * question pre-emption, attention spacing enforced by the player) plus
 * scheduleGesturePlan at each due trigger's render time. The drive's per-step
 * LaneRender frames are the daemon's output (engine signals plus attention
 * prominence/foreground/gestures), so the render proves the integrated
 * mapping, not the sandbox sliders. Fade progress follows the 4 s release
 * from each lane's OWN turn_complete entry: the first step whose lifecycle
 * reads turn_complete starts that lane's 0 → 1 fade over the next 4 s.
 */
export async function renderReplayDrive(
  drive: ReplayDrive,
  seed: number = QA_SEED,
): Promise<QaRenderResult> {
  const calmFor = (t: number): number => {
    let value = drive.calm;
    let prevT = 0;
    let prevCalm = drive.calm;
    for (const [atS, target] of drive.calmTrack) {
      if (t < atS) {
        const span = atS - prevT;
        return span <= 0 ? target : prevCalm + ((target - prevCalm) * (t - prevT)) / span;
      }
      prevT = atS;
      prevCalm = target;
      value = target;
    }
    return value;
  };
  const stepAt = (t: number): readonly LaneRender[] => {
    let lanes: readonly LaneRender[] = drive.steps[0]?.lanes ?? [];
    for (const step of drive.steps) {
      if (step.atS <= t) lanes = step.lanes;
      else break;
    }
    return lanes;
  };
  const turnCompleteAt = new Map<number, number>();
  for (const step of drive.steps) {
    for (const lane of step.lanes) {
      if (lane.lifecycle === "turn_complete" && !turnCompleteAt.has(lane.laneId)) {
        turnCompleteAt.set(lane.laneId, step.atS);
      }
    }
  }
  const random = seededRandom(seed);
  const originalRandom = Math.random;
  Math.random = random;
  try {
    const buffer = await Tone.Offline(async (context) => {
      const laneCount = Math.max(
        1,
        ...drive.steps.flatMap((step) => step.lanes.map((lane) => lane.laneId + 1)),
      );
      const graph = createScene(Tone, {
        laneCount,
        natureAssetUrl: natureWavUrl,
        pianoAssetUrls: PIANO_ASSET_URLS,
        natureOffsets: natureOffsets(seed),
      });
      await graph.reverb.ready;
      await graph.nature.ready;
      await graph.piano?.ready;
      const stepper = createSeededDriftStepper(seed);
      let descriptor: GraphDescriptor | undefined;
      // Gesture plans are resolved BEFORE the transport starts (pure data
      // from the drive's LaneRender gesture history): the player reads the
      // stepped frames at 0.5 s resolution — the same frames the transport
      // applies — and every due trigger's plan is scheduled once from the
      // main Offline callback (same-context nodes), never from a nested
      // transport callback. The transport repeat below only moves scene
      // params; gestures are already placed on the timeline.
      const player = new GesturePlayer();
      {
        let previous: readonly LaneRender[] = [];
        const sounded = new Set<string>();
        for (let t = 0; t <= drive.durationS; t += 0.5) {
          const lanes = stepAt(t);
          const renders = [...lanes];
          for (const trigger of evaluateGestureTriggers(previous, renders, t)) {
            const key = `${trigger.laneIndex}:${trigger.gesture}@${trigger.at}`;
            if (sounded.has(key)) continue;
            sounded.add(key);
            const harmony = renderWithMacro(renders, calmFor(trigger.at), {
              nowSeconds: trigger.at,
              seed,
              presence: macroPresence(renders),
              calm: calmFor(trigger.at),
              applyWorld: true,
            }).macro;
            const events = player.play(
              trigger,
              calmFor(trigger.at),
              harmony.world,
              harmony.tonic,
              harmony,
            );
            if (events.length > 0) scheduleGesturePlan(graph, events, trigger.at);
          }
          previous = renders;
        }
      }
      context.transport.scheduleRepeat(
        (t: number) => {
          const stepLanes = stepAt(t);
          const renders = [...stepLanes];
          const fade = renders.map((lane) => {
            if (lane.lifecycle !== "turn_complete") return 0;
            const entered = turnCompleteAt.get(lane.laneId) ?? t;
            return Math.min(1, Math.max(0, (t - entered) / 4));
          });
          const meanPresence =
            renders.length === 0
              ? 0
              : renders.reduce((sum, lane) => sum + lane.activity, 0) / renders.length;
          const params = renderWithMacro(
            renders,
            calmFor(t),
            {
              nowSeconds: t,
              seed,
              presence: meanPresence,
              calm: calmFor(t),
              applyWorld: true,
            },
            fade,
          );
          descriptor = applyToGraph(graph, stepper.step(params, 0.5), descriptor, t, {
            seed,
            nowSeconds: t * SPATIAL_MINUTE_SPAN + 1,
          });
        },
        0.5,
        0,
      );
      context.transport.start(0);
    }, drive.durationS);
    const left = Float32Array.from(buffer.getChannelData(0));
    const right = Float32Array.from(buffer.getChannelData(1));
    return { sampleRate: buffer.sampleRate, left, right };
  } finally {
    Math.random = originalRandom;
  }
}

/** Five recorded event cues in the real graph, plus a waiting cue pre-empting arrival. */
export async function renderPianoCueAudition(mix = true): Promise<QaRenderResult> {
  let graph: ReturnType<typeof createScene> | undefined;
  try {
    const buffer = await Tone.Offline(async (context) => {
      graph = createScene(Tone, {
        laneCount: 4,
        natureAssetUrl: natureWavUrl,
        pianoAssetUrls: PIANO_ASSET_URLS,
      });
      const built = graph;
      await Promise.all([built.reverb.ready, built.nature.ready, built.piano?.ready]);
      const lanes = scenarioDrive("routine-3-lanes-calm06", QA_SEED).steps[0]?.lanes ?? [];
      const player = new GesturePlayer();
      const cues = [
        [4, "arrive", 0],
        [12, "question", 1],
        [20, "resolve", 2],
        [28, "attention", 3],
        [44, "arrive", 0],
        [44.2, "question", 0],
      ] as const;
      for (const [at, gesture, laneIndex] of cues) {
        const params = renderWithMacro(lanes, 0.6, {
          nowSeconds: at,
          seed: QA_SEED,
          presence: macroPresence(lanes),
          calm: 0.6,
          applyWorld: true,
        });
        scheduleGesturePlan(
          built,
          player.play(
            { laneIndex, gesture, at },
            0.6,
            params.macro.world,
            params.macro.tonic,
            params.macro,
          ),
          at,
        );
      }
      const harmony = renderWithMacro(lanes, 0.6, {
        nowSeconds: 36,
        seed: QA_SEED,
        presence: macroPresence(lanes),
        calm: 0.6,
        applyWorld: true,
      }).macro;
      scheduleOverflowCue(built, overflowCuePlan(harmony), 36);
      let descriptor: GraphDescriptor | undefined;
      context.transport.scheduleRepeat(
        (at) => {
          const params = renderWithMacro(lanes, 0.6, {
            nowSeconds: at,
            seed: QA_SEED,
            presence: macroPresence(lanes),
            calm: 0.6,
            applyWorld: true,
          });
          descriptor = applyToGraph(built, params, descriptor, at);
          if (!mix) {
            // Isolate the sampled cues while retaining their real pan, Calm trim and reverb path.
            for (const lane of built.lanes)
              for (const gain of [lane.airGain, lane.grainGain, lane.pulseGain, lane.tensionGain])
                gain.gain.linearRampTo(0, 0.005, at);
            for (const gain of [
              built.bed.gain,
              built.nature.gain,
              built.air.gain,
              built.macro.fieldGain,
              built.macro.swellGain,
            ])
              gain.gain.linearRampTo(0, 0.005, at);
          }
        },
        0.5,
        0,
      );
      context.transport.start(0);
    }, 53);
    return {
      sampleRate: buffer.sampleRate,
      left: Float32Array.from(buffer.getChannelData(0)),
      right: Float32Array.from(buffer.getChannelData(1)),
    };
  } finally {
    graph?.dispose();
  }
}
