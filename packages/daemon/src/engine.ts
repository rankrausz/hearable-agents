// packages/daemon/src/engine.ts — owns one pure core engine state per allocated
// lane. What this is for: applying accepted events, advancing the engine clock,
// and projecting the daemon-owned LaneRender stream. What it must not do:
// allocate lanes or expose core working memory.

import {
  type AdapterCapabilities,
  type AttentionLaneRender,
  type AttentionState,
  advance,
  applyEvent,
  computeAttention,
  createLane,
  initialAttentionState,
  type LaneState,
  type NormalizedEvent,
} from "@hearable/core";
import type { AdapterRegistry } from "./adapters.js";
import { DEFAULT_CALM } from "./calm.js";
import type { LaneManager } from "./lanes.js";
import { laneKeyOf } from "./lanes.js";
import type { Sessions } from "./sessions.js";

export type LaneSignal = Omit<LaneState, "internal" | "capabilities">;
export type LaneRender = LaneSignal & AttentionLaneRender;

export type EngineOwner = {
  apply(events: readonly NormalizedEvent[], now: number): readonly LaneRender[];
  advance(now: number): readonly LaneRender[];
  snapshot(): readonly LaneRender[];
  setCalm(calm: number, now: number): readonly LaneRender[];
  calm(): number;
};

const FALLBACK_CAPABILITIES: AdapterCapabilities = {
  sessionEvents: true,
  turnStart: "inferred",
  turnEnd: "inferred",
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
};

export function createEngineOwner(
  lanes: LaneManager,
  sessions: Sessions,
  adapters: AdapterRegistry,
): EngineOwner {
  const states = new Map<string, LaneState>();
  let attentionState: AttentionState = initialAttentionState();
  let latestRenders: readonly LaneRender[] = [];
  let calm = DEFAULT_CALM;

  const project = (now: number): readonly LaneRender[] => {
    const signals = signalsFor(states);
    const attention = computeAttention(signals, calm, attentionState, now);
    attentionState = attention.state;
    latestRenders = signals.map((signal) => ({
      ...signal,
      ...(attention.renders.find((render) => render.laneId === signal.laneId) ?? {
        laneId: signal.laneId,
        prominence: 0,
        foreground: false,
        gestures: [],
      }),
    }));
    return latestRenders;
  };

  return {
    apply(events, now) {
      for (const event of events) {
        const key = laneKeyOf(event.sessionId, event.parentSessionId);
        const laneId = lanes.laneIdForKey(key);
        if (laneId === undefined) {
          continue;
        }
        let state = states.get(key);
        if (state === undefined) {
          const session = sessions.get(key) ?? sessions.get(event.sessionId);
          const capabilities =
            session?.capabilities ??
            adapters.get(event.agent)?.capabilities ??
            FALLBACK_CAPABILITIES;
          state = createLane({
            laneId,
            sessionId: key,
            agent:
              session?.agent === undefined ? event.agent : (session.agent as typeof event.agent),
            ...(session?.via === undefined ? {} : { via: session.via }),
            capabilities,
            now,
          });
        }
        state = applyEvent(state, event);
        states.set(key, state);
      }
      // Ingest can arrive after a quiet period. Apply the whole batch first so
      // the current clock advances the resulting state exactly once before it
      // is projected for the browser.
      for (const [key, state] of states) {
        if (lanes.laneIdForKey(key) !== undefined) {
          states.set(key, advance(state, now));
        }
      }
      dropReleasedStates(states, lanes);
      return project(now);
    },

    advance(now) {
      for (const [key, state] of states) {
        const laneId = lanes.laneIdForKey(key);
        if (laneId === undefined) {
          states.delete(key);
          continue;
        }
        states.set(key, advance(state, now));
      }
      return project(now);
    },

    snapshot() {
      return latestRenders;
    },

    setCalm(nextCalm, now) {
      calm = nextCalm;
      return project(now);
    },

    calm() {
      return calm;
    },
  };
}

function dropReleasedStates(states: Map<string, LaneState>, lanes: LaneManager): void {
  for (const key of states.keys()) {
    if (lanes.laneIdForKey(key) === undefined) {
      states.delete(key);
    }
  }
}

function signalsFor(states: Map<string, LaneState>): LaneSignal[] {
  return [...states.values()]
    .sort((left, right) => left.laneId - right.laneId)
    .map(({ internal: _internal, capabilities: _capabilities, reasons, ...signal }) => ({
      ...signal,
      reasons: reasons.slice(0, 3),
    }));
}
