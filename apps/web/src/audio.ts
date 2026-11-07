// Plays daemon frames through Clearing; must not infer state or bypass output ramps.
// apps/web/src/audio.ts — the browser-only boundary between daemon renders and
// the Clearing graph. What this is for: mapping complete live LaneRender frames,
// applying bounded drift, applying local mixer controls, and scheduling each
// gesture once. What it must not do: parse wire data, infer state, or write
// Tone parameters outside the audio API.

import {
  createHandle,
  createLiveDriftStepper,
  createOutputGate,
  createScene,
  crossfadeLaneVoices,
  ENSEMBLE_OPT_IN_DEFAULT,
  ensembleNeedsRestart,
  ensemblePruneDeparted,
  ensembleShouldTick,
  evaluateGestureTriggers,
  GesturePlayer,
  harmonicMoveIsVoiceable,
  INITIAL_OVERFLOW_WATCH,
  isInKey,
  isInRegister,
  OVERFLOW_CUE_ENABLED,
  type OverflowWatch,
  overflowCuePlan,
  PIANO_ASSET_URLS,
  routeEnsembleFrame,
  type SceneHandle,
  scheduleGesturePlan,
  scheduleOverflowCue,
  type ToneModule,
  watchOverflow,
} from "@hearable/audio";
import {
  createEnsembleDriver,
  type EnsembleDriver,
  ensembleRestart,
  harmonicIsInKey,
  LANE_CAP,
  type LaneRender,
  macroPresence,
  renderWithMacro,
  type SceneParams,
} from "@hearable/core";
// Bundler-resolved nature-bed asset (revp3t15): the web build emits the
// WAV beside the JS and the graph fetches + decodes it in its own
// context — the identical fetch + decode path QA takes through the same
// `?url` import, awaited on the same `ready` lifecycle as `reverb.ready`.
import natureAssetUrl from "../../../packages/audio/src/scenes/clearing/assets/nature-bed-soft-rain-12s.wav?url";
import {
  type Isolation,
  isAudible,
  isolateParams,
  laneLayerKey,
  NO_ISOLATION,
  worldLayerKey,
} from "./audio-isolation.js";
import type { LaneSignal } from "./protocol.js";

type GestureName = LaneSignal["gestures"][number]["gesture"];

/**
 * What one apply sent to the graph, for the sound lab: the scene targets
 * before isolation, the gestures and ensemble move it scheduled, and
 * whether each was heard under the isolation in force.
 */
export type SoundReport =
  | {
      readonly kind: "frame";
      readonly serverTime: number;
      readonly signals: readonly LaneSignal[];
      readonly params: SceneParams;
      readonly isolation: Isolation;
      readonly gestures: readonly {
        readonly laneId: number;
        readonly gesture: GestureName;
        readonly heard: boolean;
      }[];
      readonly move: { readonly laneId: number; readonly midi: number } | null;
    }
  | { readonly kind: "overflow"; readonly serverTime: number; readonly heard: boolean };

export type LiveAudio = {
  apply(
    signals: readonly LaneSignal[],
    calm: number,
    serverTime: number,
    mixer?: MixerSettings,
    isolation?: Isolation,
  ): void;
  /**
   * Announced overflow (p7b-t03): the daemon's queued session ids for this
   * frame. A newly queued session sounds the one soft overflow cue, spaced
   * and never on the first frame; the UI statement is shown regardless.
   */
  announceQueued(
    queuedSessionIds: readonly string[],
    serverTime: number,
    isolation?: Isolation,
  ): void;
  setAudible(audible: boolean): void;
  dispose(): void;
};

/**
 * Switch for the p5-t04 ensemble path (adopted hybrid default, p5-t06):
 * when enabled, live/sandbox/replay tick the shared core driver
 * and voice its routine moves through the existing crossfade handover;
 * when disabled, the render/hearing path is byte-identical to before
 * (bank 0 only, hard cues through the existing gesture path).
 */
export const ENSEMBLE_LIVE_OPT_IN = ENSEMBLE_OPT_IN_DEFAULT;

export type EnsembleLiveState = {
  driver: EnsembleDriver;
  moveCount: number;
};

export function createEnsembleLiveState(seed: number): EnsembleLiveState {
  return { driver: createEnsembleDriver(seed), moveCount: 0 };
}

/**
 * One live tick through the shared core driver: the same
 * planner path sandbox/replay use. `previous` is the full previous
 * frame (hard cues read the whole history, never the routine subset);
 * `renders` is the full current frame whose routine lanes (active/quiet)
 * feed the driver. Waiting/completion/attention lanes never feed the
 * driver and their triggers bypass routine arbitration; routine moves
 * emit no gestures. Prunes departed lanes (only their own state) and
 * restarts on resync gaps instead of folding them. Returns the new
 * driver, the voiced move (already gated on the voicing contract) and
 * the immediate triggers.
 */
export function ensembleLiveTick(
  state: EnsembleLiveState,
  previous: readonly LaneRender[],
  renders: readonly LaneRender[],
  nowS: number,
  presentLaneIds?: ReadonlySet<number>,
  palette?: readonly number[],
): {
  state: EnsembleLiveState;
  move: { readonly laneIndex: number; readonly pitch: number } | null;
  moveBankIndex: number | null;
  triggers: ReturnType<typeof evaluateGestureTriggers>;
} {
  // Prune reads the DAEMON lane ids (the signals before graph padding),
  // never the padded graph frame: the graph pads departed lanes with idle
  // renders, and pruning on those would keep released lanes forever. The
  // live apply passes the daemon ids; tests that drive padded renders
  // pass them explicitly — and when omitted, the routine lanes present in
  // the frame are the conservative fallback.
  const present =
    presentLaneIds ??
    new Set(renders.filter((lane) => lane.lifecycle !== "idle").map((lane) => lane.laneId));
  let driver = ensemblePruneDeparted(state.driver, present);
  const lastAtS = driver.lastAtS;
  if (lastAtS !== null && lastAtS !== undefined && ensembleNeedsRestart(lastAtS, nowS)) {
    driver = ensembleRestart(driver);
  }
  if (!ensembleShouldTick(driver.lastAtS, nowS)) {
    const triggers = evaluateGestureTriggers(previous, renders, nowS);
    return {
      state: { driver, moveCount: state.moveCount },
      move: null,
      moveBankIndex: null,
      triggers,
    };
  }
  const routed = routeEnsembleFrame(driver, previous, renders, nowS, palette);
  driver = routed.driver;
  if (routed.move === null || routed.moveIndex === null) {
    return {
      state: { driver, moveCount: state.moveCount },
      move: null,
      moveBankIndex: null,
      triggers: routed.triggers,
    };
  }
  // The voicing contract reads the same chord the planner sang from
  // (ADR 0025 amendment); without a palette the pentatonic guard applies.
  const voiced = harmonicMoveIsVoiceable(routed.move, Number.POSITIVE_INFINITY, {
    isInKey: palette === undefined ? isInKey : (midi) => harmonicIsInKey(midi, palette),
    isInRegister,
  });
  if (!voiced) {
    return {
      state: { driver, moveCount: state.moveCount },
      move: null,
      moveBankIndex: null,
      triggers: routed.triggers,
    };
  }
  return {
    state: { driver, moveCount: state.moveCount + 1 },
    move: { laneIndex: routed.move.laneIndex, pitch: routed.move.pitch },
    moveBankIndex: routed.moveIndex,
    triggers: routed.triggers,
  };
}

export type MixerSettings = Readonly<
  Record<number, { readonly gain: number; readonly muted: boolean }>
>;

export function laneRenderForAudio(signal: LaneSignal): LaneRender {
  return {
    laneId: signal.laneId,
    lifecycle: signal.lifecycle,
    ...(signal.waitingReason === undefined ? {} : { waitingReason: signal.waitingReason }),
    mode: signal.mode,
    displayedMode: signal.displayedMode,
    activity: signal.activity,
    progress: signal.progress,
    struggle: signal.struggle,
    prominence: signal.prominence,
    foreground: signal.foreground,
    // The daemon clock is milliseconds; the audio player clock is seconds.
    gestures: signal.gestures.map((gesture) => ({ ...gesture, at: gesture.at / 1000 })),
  };
}

const IDLE_MODE = { exploring: 0, editing: 0, testing: 0, other: 0 } as const;

function idleLane(laneId: number): LaneRender {
  return {
    laneId,
    lifecycle: "idle",
    mode: IDLE_MODE,
    displayedMode: "other",
    activity: 0,
    progress: 0,
    struggle: 0,
    prominence: 0,
    foreground: false,
    gestures: [],
  };
}

export function applyMixer(signals: readonly LaneSignal[], mixer: MixerSettings): LaneSignal[] {
  return signals.map((signal) => {
    const setting = mixer[signal.laneId];
    if (setting === undefined) return signal;
    const gain = Math.min(1, Math.max(0, setting.gain));
    const muted = setting.muted || gain === 0;
    return {
      ...signal,
      lifecycle: muted ? "idle" : signal.lifecycle,
      activity: muted ? 0 : signal.activity * gain,
      progress: muted ? 0 : signal.progress * gain,
      struggle: muted ? 0 : signal.struggle * gain,
      prominence: muted ? 0 : signal.prominence * gain,
      foreground: muted ? false : signal.foreground,
      gestures: muted ? [] : signal.gestures,
    };
  });
}

/**
 * Keeps graph lane identity stable when the daemon omits or reorders lanes:
 * one render per seat up to the lane cap, idle where no agent sits.
 */
export function sceneRendersForAudio(
  signals: readonly LaneSignal[],
  laneCount = LANE_CAP,
): LaneRender[] {
  const byLane = new Map(signals.map((signal) => [signal.laneId, signal]));
  return Array.from({ length: laneCount }, (_, laneId) => {
    const signal = byLane.get(laneId);
    return signal === undefined ? idleLane(laneId) : laneRenderForAudio(signal);
  });
}

/**
 * Fade to exact silence when playback stops wanting sound (owner direction
 * 2026-10-29): long enough to hear the room settle after the last agent,
 * short enough to be silence within a few breaths.
 */
export const AUTO_SILENCE_FADE_S = 6;

/** Creates a live graph only after the caller's Start audio gesture. */
export async function createLiveAudio(
  seed = Math.floor(Math.random() * 0x1_0000_0000),
  options: {
    readonly ensemble?: boolean;
    readonly onSound?: (report: SoundReport) => void;
  } = {},
): Promise<LiveAudio> {
  const tone: ToneModule = await import("tone");
  await tone.start();
  const graph = createScene(tone, {
    laneCount: LANE_CAP,
    natureAssetUrl,
    pianoAssetUrls: PIANO_ASSET_URLS,
  });
  const gate = createOutputGate(tone, graph);
  try {
    await Promise.all([graph.reverb.ready, graph.nature.ready, graph.piano?.ready]);
  } catch (error) {
    await Promise.allSettled([graph.reverb.ready, graph.nature.ready, graph.piano?.ready]);
    graph.dispose();
    gate.dispose();
    throw error;
  }
  const scene: SceneHandle = createHandle(graph);
  let disposed = false;
  const drift = createLiveDriftStepper();
  const player = new GesturePlayer();
  let previous: readonly LaneRender[] = [];
  let previousTime: number | undefined;
  const sounded = new Set<string>();
  // Adopted ensemble planner state (p5-t06): owned here, never global —
  // the seed belongs to this live session, the state survives `apply`
  // calls, and restart on resync gaps keeps reconnects burst-free.
  const ensembleEnabled = options.ensemble ?? ENSEMBLE_OPT_IN_DEFAULT;
  let ensemble: EnsembleLiveState = createEnsembleLiveState(seed);
  let overflow: OverflowWatch = INITIAL_OVERFLOW_WATCH;
  let cueHarmony: import("@hearable/audio").CueHarmony | undefined;

  return {
    apply(signals, calm, serverTime, mixer = {}, isolation = NO_ISOLATION) {
      if (disposed) return;
      const gestures: { laneId: number; gesture: GestureName; heard: boolean }[] = [];
      let moved: { laneId: number; midi: number } | null = null;
      const renders = sceneRendersForAudio(applyMixer(signals, mixer));
      // Summed over the three tuned seats, never the padded frame length:
      // the empty fourth seat must not dilute the world (p7b-t03).
      const presence = macroPresence(renders);
      const params = renderWithMacro(renders, calm, {
        nowSeconds: serverTime / 1000,
        seed,
        presence,
        calm,
        applyWorld: true,
      });
      cueHarmony = params.macro;
      const elapsed =
        previousTime === undefined ? 0 : Math.max(0, serverTime - previousTime) / 1000;
      // Slow spatial movement (p3-t16, ADR 0017): the live seed + engine
      // clock select the seeded macro wander (minute epochs, lane-blind —
      // never lane state, never agent events) on the declared
      // pan/width/reverbSend ramps.
      // Isolation follows drift so the lab's silenced targets are never
      // clamped back into a drift range; they still ride scene.apply's ramps.
      scene.apply(isolateParams(drift.step(params, elapsed), isolation), {
        seed,
        nowSeconds: serverTime / 1000,
      });
      const browserWindow = window as unknown as { __hearableSceneParamsCount?: number };
      browserWindow.__hearableSceneParamsCount =
        (browserWindow.__hearableSceneParamsCount ?? 0) + 1;
      window.dispatchEvent(new CustomEvent("hearable:scene-params", { detail: params }));
      const now = serverTime / 1000;
      if (ensembleEnabled) {
        // Adopted ensemble tick (p5-t06): one planner path for
        // live/sandbox/replay. Routine lanes feed the driver; hard cues
        // bypass it; the voiced move crossfades that lane's own banks
        // (departures release without moving others). Prune reads the daemon
        // frame (pre-padding ids), never the padded graph frame.
        const mixed = applyMixer(signals, mixer);
        const ticked = ensembleLiveTick(
          ensemble,
          previous,
          renders,
          now,
          new Set(mixed.map((item) => item.laneId)),
          params.macro.palette,
        );
        ensemble = ticked.state;
        if (ticked.move !== null && ticked.moveBankIndex !== null) {
          crossfadeLaneVoices(
            graph,
            ticked.move.laneIndex,
            ticked.move.pitch,
            tone.now(),
            ticked.moveBankIndex,
          );
          moved = { laneId: ticked.move.laneIndex, midi: ticked.move.pitch };
        }
        for (const trigger of ticked.triggers) {
          const key = `${trigger.laneIndex}:${trigger.gesture}@${trigger.at}`;
          if (sounded.has(key)) continue;
          sounded.add(key);
          const heard = isAudible(isolation, laneLayerKey(trigger.laneIndex, "gestures"));
          gestures.push({ laneId: trigger.laneIndex, gesture: trigger.gesture, heard });
          if (!heard) continue;
          const events = player.play(
            trigger,
            calm,
            params.macro.world,
            params.macro.tonic,
            params.macro,
          );
          if (events.length > 0) scheduleGesturePlan(graph, events, tone.now());
        }
        previous = renders;
        previousTime = serverTime;
        options.onSound?.({
          kind: "frame",
          serverTime,
          signals,
          params,
          isolation,
          gestures,
          move: moved,
        });
        return;
      }
      const triggers = evaluateGestureTriggers(previous, renders, now);
      for (const trigger of triggers) {
        const key = `${trigger.laneIndex}:${trigger.gesture}@${trigger.at}`;
        if (sounded.has(key)) continue;
        sounded.add(key);
        const heard = isAudible(isolation, laneLayerKey(trigger.laneIndex, "gestures"));
        gestures.push({ laneId: trigger.laneIndex, gesture: trigger.gesture, heard });
        if (!heard) continue;
        const events = player.play(
          trigger,
          calm,
          params.macro.world,
          params.macro.tonic,
          params.macro,
        );
        if (events.length > 0) scheduleGesturePlan(graph, events, tone.now());
      }
      previous = renders;
      previousTime = serverTime;
      options.onSound?.({
        kind: "frame",
        serverTime,
        signals,
        params,
        isolation,
        gestures,
        move: moved,
      });
    },
    announceQueued(queuedSessionIds, serverTime, isolation = NO_ISOLATION) {
      if (disposed) return;
      const next = watchOverflow(overflow, queuedSessionIds, serverTime / 1000);
      overflow = next.watch;
      if (next.cue && OVERFLOW_CUE_ENABLED) {
        const heard = isAudible(isolation, worldLayerKey("cues"));
        if (heard) scheduleOverflowCue(graph, overflowCuePlan(cueHarmony), tone.now());
        options.onSound?.({ kind: "overflow", serverTime, heard });
      }
    },
    setAudible(audible) {
      // Opening stays quick so an agent is heard at once; going silent
      // fades over AUTO_SILENCE_FADE_S so the room settles, not cuts.
      if (!disposed) gate.setOpen(audible, tone.now(), audible ? undefined : AUTO_SILENCE_FADE_S);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gate.setOpen(false);
      // Include Tone's lookahead before releasing sources behind the closed gate.
      window.setTimeout(() => {
        scene.dispose();
        gate.dispose();
      }, 1_300);
    },
  };
}

/** The sandbox retains its existing direct scene mapping behind the same stop ramp. */
export async function createSandboxAudio(): Promise<SceneHandle> {
  const tone: ToneModule = await import("tone");
  await tone.start();
  const graph = createScene(tone, {
    laneCount: LANE_CAP,
    natureAssetUrl,
    pianoAssetUrls: PIANO_ASSET_URLS,
  });
  const gate = createOutputGate(tone, graph);
  try {
    await Promise.all([graph.reverb.ready, graph.nature.ready, graph.piano?.ready]);
  } catch (error) {
    await Promise.allSettled([graph.reverb.ready, graph.nature.ready, graph.piano?.ready]);
    graph.dispose();
    gate.dispose();
    throw error;
  }
  const scene = createHandle(graph);
  let disposed = false;
  return {
    apply(params) {
      if (!disposed) {
        scene.apply(params);
        gate.setOpen(true);
      }
    },
    get descriptor() {
      return scene.descriptor;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gate.setOpen(false);
      window.setTimeout(() => {
        scene.dispose();
        gate.dispose();
      }, 1_300);
    },
  };
}
