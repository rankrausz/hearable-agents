// packages/audio/src/qa/replay.ts — replay-driven QA drives: fixture event
// streams folded through the live path (engine → attention → LaneRender) in
// the browser. What this is for: building the p4-t06 replay matrix drives —
// claude-code stuck, codex stuck, and both concurrently as the three-lane mix
// — plus the calm-sweep and waiting-onset drives, so the browser renders the
// integrated mapping (engine signals plus attention prominence/foreground/
// gestures), not the sandbox sliders. What it must not do: read fixtures or
// touch the network — the caller (the e2e spec) reads the JSONL files and
// passes parsed events in; render.ts sounds the drive through the same graph
// calls the live page makes.

import {
  type AdapterCapabilities,
  type AttentionInput,
  type AttentionState,
  advance,
  applyEvent,
  computeAttention,
  createLane,
  initialAttentionState,
  type LaneRender,
  type LaneState,
  type NormalizedEvent,
} from "@hearable/core";

/**
 * Lane capabilities for the replay drives, mirroring the adapters'
 * declared values (claude-code: every capability observed/true;
 * codex: editEvents false, questionEvents false). Copied as data — the
 * audio package must not import adapter packages — with the sources cited:
 * packages/adapters/claude-code/src/capabilities.ts and
 * packages/adapters/codex/src/capabilities.ts. If `doctor` re-grades either
 * adapter, this copy follows in the same task with before/after numbers.
 */
export const REPLAY_CAPABILITIES: Record<"claude-code" | "codex", AdapterCapabilities> = {
  "claude-code": {
    sessionEvents: true,
    turnStart: "observed",
    turnEnd: "observed",
    toolEvents: true,
    toolFailures: true,
    editEvents: true,
    execEvents: true,
    permissionEvents: true,
    questionEvents: true,
    subagents: true,
    compaction: true,
    toolKinds: "byName",
    durations: true,
  },
  codex: {
    sessionEvents: true,
    turnStart: "observed",
    turnEnd: "observed",
    toolEvents: true,
    toolFailures: true,
    editEvents: false,
    execEvents: true,
    permissionEvents: true,
    questionEvents: false,
    subagents: true,
    compaction: true,
    toolKinds: "byName",
    durations: true,
  },
};

/** One replayed session: whose fixture events, on which lane. */
export type ReplayLaneInput = {
  /** Lane id the daemon would allocate (0, 1, 2 for the three-lane mix). */
  readonly laneId: number;
  /** Session identity for lane creation (the fixture's sessionId). */
  readonly sessionId: string;
  /** Which adapter's capabilities gate the engine (never branched on). */
  readonly agent: keyof typeof REPLAY_CAPABILITIES;
  /** Parsed fixture events (kind-bearing JSONL lines, time-ordered or not). */
  readonly events: readonly NormalizedEvent[];
};

/**
 * One replay setup: the fixture family(s) behind a matrix row. The ACP
 * third does not exist (no Phase 1b adapter, no fixtures) and is never
 * faked with a relabelled fixture — the mix sounds two real families and
 * the gap is recorded in the QA log and docs/SOUND_DESIGN.md.
 */
export type ReplaySetupName = "claude-stuck" | "codex-stuck" | "three-lane-mix";

/**
 * Render window per setup in fixture seconds from the common anchor (the
 * earliest event across the setup's lanes). Windows are 90 s so every
 * fatigue rule's 60 s window fits, anchored where the trajectory is most
 * dynamic — not at session start, so joins do not dominate the read:
 * - claude-stuck: 60–150 s of claude-code/stuck-single-session (active
 *   looping with turn_complete resolve/fade cycles at ~136 s; the settled
 *   5–15 s window then holds live looping levels instead of silence).
 * - codex-stuck: 45–135 s of codex/stuck-single-session (active looping
 *   at full activity; struggle has decayed to 0 throughout, so the
 *   loudness comparison reads like-for-like activity without the
 *   settled-window struggle-term lift: the struggle arc's own evidence
 *   (0.1 peak at ~39 s) sits in the folded history, not the window).
 * - three-lane-mix: 0–90 s of the concurrent replay (arrive gestures, the
 *   permission-heavy lane waiting from ~0 s with its tension hold, both
 *   stuck lanes active early).
 */
export const REPLAY_WINDOWS: Record<
  ReplaySetupName,
  { readonly startS: number; readonly endS: number }
> = {
  "claude-stuck": { startS: 60, endS: 150 },
  "codex-stuck": { startS: 45, endS: 135 },
  "three-lane-mix": { startS: 0, endS: 90 },
};

/** Calm levels the matrix renders each setup at (docs/ARCHITECTURE.md Phase 4). */
export const REPLAY_CALMS: readonly number[] = [0.3, 0.6, 0.9];

/** Step resolution of the replay drive in seconds (matches the golden trajectories). */
export const REPLAY_STEP_S = 1;

/**
 * One replayed lane timeline: per-step LaneRender inputs for the scene
 * mapping plus the per-lane gesture history the attention model emitted.
 * Gesture `at` is render seconds from the window start — the same engine-ms
 * to audio-s conversion apps/web/src/audio.ts (laneRenderForAudio) applies
 * to the daemon's LaneRender stream.
 */
export type ReplayDrive = {
  readonly setup: ReplaySetupName;
  readonly calm: number;
  /** Calm waypoints (render seconds, value) after t=0; empty means constant. */
  readonly calmTrack: readonly (readonly [number, number])[];
  /** Render length in seconds (window end minus start). */
  readonly durationS: number;
  /** Fixture seconds of the window start (for log lines, not audio). */
  readonly windowStartS: number;
  /** Per-step lane renders in ascending time order (gestures in seconds). */
  readonly steps: readonly {
    readonly atS: number;
    readonly lanes: readonly LaneRender[];
  }[];
  /** First render second any lane is waiting (for the onset gate), if any. */
  readonly waitingAtS: number | null;
};

function attentionInputFor(state: LaneState): AttentionInput {
  return {
    laneId: state.laneId,
    lifecycle: state.lifecycle,
    ...(state.waitingReason === undefined ? {} : { waitingReason: state.waitingReason }),
    mode: { ...state.mode },
    displayedMode: state.displayedMode,
    activity: state.activity,
    progress: state.progress,
    struggle: state.struggle,
    lastEventAt: state.lastEventAt,
    ...(state.turnStartedAt === undefined ? {} : { turnStartedAt: state.turnStartedAt }),
  };
}

function calmAtTime(
  calm: number,
  calmTrack: readonly (readonly [number, number])[],
  t: number,
): number {
  let value = calm;
  let prevT = 0;
  let prevCalm = calm;
  for (const [atS, target] of calmTrack) {
    if (t < atS) {
      const span = atS - prevT;
      return span <= 0 ? target : prevCalm + ((target - prevCalm) * (t - prevT)) / span;
    }
    prevT = atS;
    prevCalm = target;
    value = target;
  }
  return value;
}

/**
 * Folds fixture events through the engine and the attention model exactly
 * the way the daemon owns them (packages/daemon/src/engine.ts: per-event
 * applyEvent, per-tick advance, then computeAttention with the previous
 * state threaded through), and projects the window as per-step LaneRender
 * inputs. History before the window still folds — engine and attention
 * state at the window start depend on it — but only window steps sound.
 * Pure and deterministic: the same events, window and Calm always yield
 * deep-equal drives. Core stays agent-blind throughout: capabilities gate
 * heuristics, never branch the model.
 */
export function buildReplayDrive(
  setup: ReplaySetupName,
  lanes: readonly ReplayLaneInput[],
  options: {
    readonly windowStartS: number;
    readonly windowEndS: number;
    readonly calm: number;
    readonly calmTrack?: readonly (readonly [number, number])[];
  },
): ReplayDrive {
  const calmTrack = options.calmTrack ?? [];
  const ordered = lanes.map((lane) => ({
    ...lane,
    sorted: [...lane.events].sort((left, right) => left.ts - right.ts),
  }));
  const anchor = Math.min(...ordered.map((lane) => lane.sorted[0]?.ts ?? 0));
  const toRenderS = (ts: number): number => (ts - anchor) / 1000 - options.windowStartS;

  const engineStates = new Map<number, LaneState>();
  for (const lane of ordered) {
    engineStates.set(
      lane.laneId,
      createLane({
        laneId: lane.laneId,
        sessionId: lane.sessionId,
        agent: lane.agent,
        capabilities: REPLAY_CAPABILITIES[lane.agent],
        now: lane.sorted[0]?.ts ?? anchor,
      }),
    );
  }
  let attention: AttentionState = initialAttentionState();
  const eventIndex = new Map<number, number>();
  for (const lane of ordered) eventIndex.set(lane.laneId, 0);

  const steps: { readonly atS: number; readonly lanes: readonly LaneRender[] }[] = [];
  let waitingAtS: number | null = null;
  const windowEndAbs = anchor + options.windowEndS * 1000;
  const windowStartAbs = anchor + options.windowStartS * 1000;
  // Fold history at 1 s ticks from the anchor so engine decay (activity,
  // struggle half-life, quiet/stale timers) and attention memory
  // (transition bumps, gesture history, struggle arm) reach the window
  // start exactly as a live daemon left running would hold them.
  for (let now = anchor; now <= windowEndAbs + REPLAY_STEP_S * 1000; now += REPLAY_STEP_S * 1000) {
    for (const lane of ordered) {
      let state = engineStates.get(lane.laneId);
      if (state === undefined) continue;
      let index = eventIndex.get(lane.laneId) ?? 0;
      while (index < lane.sorted.length) {
        const event = lane.sorted[index];
        if (event === undefined || event.ts > now) break;
        state = applyEvent(state, event, REPLAY_CAPABILITIES[lane.agent]);
        index += 1;
      }
      eventIndex.set(lane.laneId, index);
      state = advance(state, now, REPLAY_CAPABILITIES[lane.agent]);
      engineStates.set(lane.laneId, state);
    }
    const inputs: AttentionInput[] = [...engineStates.values()]
      .sort((left, right) => left.laneId - right.laneId)
      .map(attentionInputFor);
    const renderS = (now - anchor) / 1000 - options.windowStartS;
    const result = computeAttention(
      inputs,
      calmAtTime(options.calm, calmTrack, Math.max(0, renderS)),
      attention,
      now,
    );
    attention = result.state;
    if (now < windowStartAbs || now > windowEndAbs) continue;
    const atS = Math.max(0, renderS);
    const byId = new Map(result.renders.map((render) => [render.laneId, render]));
    const stepLanes: LaneRender[] = [...engineStates.values()]
      .sort((left, right) => left.laneId - right.laneId)
      .map((state) => {
        const render = byId.get(state.laneId);
        return {
          laneId: state.laneId,
          lifecycle: state.lifecycle,
          ...(state.waitingReason === undefined ? {} : { waitingReason: state.waitingReason }),
          mode: { ...state.mode },
          displayedMode: state.displayedMode,
          activity: state.activity,
          progress: state.progress,
          struggle: state.struggle,
          prominence: render?.prominence ?? 0,
          foreground: render?.foreground ?? false,
          gestures: [...(render?.gestures ?? [])].map((gesture) => ({
            gesture: gesture.gesture,
            // Engine-clock ms to render seconds: the daemon→browser clock
            // conversion (laneRenderForAudio divides by 1000); gestures
            // emitted before the window keep their negative time so the
            // trigger evaluator reads them as history, never as due.
            at: toRenderS(gesture.at),
          })),
        };
      });
    if (waitingAtS === null && stepLanes.some((lane) => lane.lifecycle === "waiting")) {
      waitingAtS = atS;
    }
    steps.push({ atS, lanes: stepLanes });
  }

  return {
    setup,
    calm: options.calm,
    calmTrack,
    durationS: options.windowEndS - options.windowStartS,
    windowStartS: options.windowStartS,
    steps,
    waitingAtS,
  };
}
