// packages/audio/src/ensemble/playback.ts — full-mix playback of the A/B slice.
// What this is for: rendering either slice version through the SAME
// browser QA entry the named `ensemble-ab-*` scenarios use
// (renderQaScenario: full Clearing graph — drone bed, macro world, lane
// textures, nature bed, reverb/wander — plus the version's routine-note
// schedule and the shared question/resolve cues), then playing the
// resulting buffer. The audition slice and the QA scenarios share this
// one path, so what the owner hears IS what the numbers measure. What it
// must not do: touch the production default, invent a second engine, or
// import Tone at module scope — Tone loads inside renderQaScenario.

import type { EnsembleQaSchedule } from "../qa/scenarios.js";
import { RAMP_TIMES } from "../ramps.js";
import {
  AB_CALM,
  AB_SEED,
  AB_SLICE_S,
  abTimeline,
  type EnsembleMove,
  type EnsembleVersion,
  lanesAt,
} from "./index.js";

/** Which QA scenario renders a slice version (full Clearing mix). */
export function qaScenarioForVersion(
  version: EnsembleVersion,
): "ensemble-ab-independent" | "ensemble-ab-hybrid" {
  return version === "hybrid" ? "ensemble-ab-hybrid" : "ensemble-ab-independent";
}

/**
 * The full-mix playback plan for one version: the QA scenario name, the
 * routine-note schedule the QA entry applies to each lane's sustained
 * voice banks, and the shared render constants (seed, calm, duration).
 * The entry sounds the scenario timeline (same 150 s trajectory), both
 * cues (question at 60 s, resolve at 110 s) and these moves — so the
 * played mix and the QA numbers agree by construction.
 */
export type EnsemblePlaybackPlan = {
  readonly scenario: "ensemble-ab-independent" | "ensemble-ab-hybrid";
  readonly schedule: EnsembleQaSchedule;
  readonly seed: number;
  readonly calm: number;
  readonly durationS: number;
};

/** Builds the playback plan for one version from its scheduled moves. */
export function ensemblePlaybackPlan(
  version: EnsembleVersion,
  moves: readonly EnsembleMove[],
): EnsemblePlaybackPlan {
  return {
    scenario: qaScenarioForVersion(version),
    schedule: {
      version,
      moves: moves.map((move) => ({
        laneIndex: move.laneIndex,
        atS: move.atS,
        pitch: move.pitch,
        fromPitch: move.fromPitch,
      })),
    },
    seed: AB_SEED,
    calm: AB_CALM,
    durationS: AB_SLICE_S,
  };
}

/**
 * Renders the playback plan to a stereo buffer through the browser QA
 * entry and plays it. Must be called from a user gesture: the Oceans of
 * dynamic imports keep Tone out of the initial bundle, and playback
 * starts on the created context (no fresh-AudioContext raw buffer —
 * the mix carries the full scene graph). Returns a stop handle; the
 * caller stops on unmount or version switch.
 */
export async function playEnsemblePlan(
  plan: EnsemblePlaybackPlan,
  options: { signal?: AbortSignal; volume?: () => number } = {},
): Promise<{ stop(): void; setVolume(volume: number): void }> {
  const { signal, volume } = options;
  signal?.throwIfAborted();
  const [{ renderQaScenario }] = await Promise.all([import("../qa/render.js")]);
  const rendered = await renderQaScenario(plan.scenario, plan.seed, "mix", 0, plan.schedule);
  signal?.throwIfAborted();
  const context = new AudioContext();
  try {
    await context.resume();
    signal?.throwIfAborted();
    const buffer = context.createBuffer(2, rendered.left.length, rendered.sampleRate);
    buffer.copyToChannel(new Float32Array(rendered.left), 0);
    buffer.copyToChannel(new Float32Array(rendered.right), 1);
    const source = context.createBufferSource();
    const output = context.createGain();
    output.gain.value = Math.max(0, Math.min(1, volume?.() ?? 1));
    source.buffer = buffer;
    source.connect(output);
    output.connect(context.destination);
    source.start();
    let stopped = false;
    function rampVolume(value: number): void {
      const now = context.currentTime;
      output.gain.cancelAndHoldAtTime(now);
      output.gain.linearRampToValueAtTime(
        Math.max(0, Math.min(1, value)),
        now + RAMP_TIMES.master.seconds,
      );
    }
    return {
      setVolume(value) {
        if (!stopped) rampVolume(value);
      },
      stop() {
        if (stopped) return;
        stopped = true;
        rampVolume(0);
        source.stop(context.currentTime + RAMP_TIMES.master.seconds);
        setTimeout(
          () => void context.close().catch(() => undefined),
          RAMP_TIMES.master.seconds * 1_000,
        );
      },
    };
  } catch (error) {
    void context.close().catch(() => undefined);
    throw error;
  }
}

/** Re-export for the slice comment: the timeline both versions share. */
export { abTimeline, lanesAt };
