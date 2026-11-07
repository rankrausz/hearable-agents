// packages/core/test/attention/trajectories.test.ts — golden attention
// trajectories per fixture family. This test may read fixtures and goldens,
// but the engine and attention model stay pure and no fixture is ever
// rewritten. Each replay folds one fixture's events through the engine
// (LaneState per tick) and then through the pure attention transition
// (prominence, foreground, gestures as plain-data LaneRender fields) at calm
// 0.6; the goldens pin those trajectories. A concurrent two-lane case replays
// a Claude Code and a Codex fixture together for the three-lane foreground
// review.

// biome-ignore lint/style/noRestrictedImports: fixture I/O is confined to this test harness; src remains pure.
import { readFileSync, writeFileSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: fixture I/O is confined to this test harness; src remains pure.
import { dirname, join } from "node:path";
// biome-ignore lint/style/noRestrictedImports: fixture I/O is confined to this test harness; src remains pure.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AdapterCapabilities,
  type AttentionInput,
  advance,
  applyEvent,
  computeAttention,
  createLane,
  initialAttentionState,
  type LaneState,
  type NormalizedEvent,
  NormalizedEventSchema,
} from "../../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../");
const FIXTURES = join(ROOT, "fixtures/sessions");
const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), "trajectories");
const SAMPLE_MS = 1_000;
const CALM = 0.6;

const fullCapabilities: AdapterCapabilities = {
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
};

const adapterCapabilities: Record<string, AdapterCapabilities> = {
  "claude-code": fullCapabilities,
  codex: { ...fullCapabilities, editEvents: false, questionEvents: false },
};

const attentionFixtures = [
  ["claude-code", "stuck-single-session"],
  ["claude-code", "stuck-fix-loop"],
  ["claude-code", "permission-heavy"],
  ["claude-code", "asks-question"],
  ["codex", "stuck-single-session"],
  ["codex", "permission-heavy"],
] as const;

type Annotation = {
  readonly durationMs: number;
  readonly struggleSegments: readonly { readonly fromMs: number; readonly toMs: number }[];
};

type AttentionSample = {
  readonly atMs: number;
  readonly lanes: readonly {
    readonly laneId: number;
    readonly lifecycle: LaneState["lifecycle"];
    readonly lifecycleConfidence: LaneState["lifecycleConfidence"];
    readonly struggle: number;
    readonly prominence: number;
    readonly foreground: boolean;
    readonly gestures: readonly { readonly gesture: string; readonly at: number }[];
  }[];
};

type AttentionReplay = {
  readonly calm: number;
  readonly samples: readonly AttentionSample[];
  readonly summary: {
    readonly attentionGestures: number;
    readonly questionGestures: number;
    readonly foregroundHolders: readonly number[];
    readonly foregroundTransitions: number;
    readonly strugglePeak: number;
    readonly prominencePeak: number;
  };
};

function round(value: number): number {
  return Number(value.toFixed(6));
}

function readSession(
  agent: string,
  name: string,
): { events: NormalizedEvent[]; annotation: Annotation; anchor: number } {
  const lines = readFileSync(join(FIXTURES, agent, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const events = lines
    .filter((line) => typeof line.kind === "string")
    .map((line) => NormalizedEventSchema.parse(line));
  const annotation = JSON.parse(
    readFileSync(join(FIXTURES, agent, `${name}.annotations.json`), "utf8"),
  ) as Annotation;
  const ordered = [...events].sort((left, right) => left.ts - right.ts);
  return { events: ordered, annotation, anchor: ordered[0]?.ts ?? 0 };
}

export function replayAttention(
  sessions: readonly { agent: string; name: string; laneId: number }[],
  calm = CALM,
  windowMs?: number,
): AttentionReplay {
  const loaded = sessions.map((session) => ({
    ...session,
    ...readSession(session.agent, session.name),
    capabilities: adapterCapabilities[session.agent] ?? fullCapabilities,
  }));
  const anchor = Math.min(...loaded.map((entry) => entry.anchor));
  const fullEnd = Math.max(
    ...loaded.map((entry) =>
      Math.max(
        entry.annotation.durationMs + (entry.anchor - anchor),
        (entry.events.at(-1)?.ts ?? entry.anchor) - anchor,
      ),
    ),
  );
  const end = windowMs === undefined ? fullEnd : Math.min(fullEnd, windowMs);
  const engineStates = new Map<number, LaneState>();
  for (const entry of loaded) {
    engineStates.set(
      entry.laneId,
      createLane({
        laneId: entry.laneId,
        sessionId: entry.events[0]?.sessionId ?? `${entry.agent}-${entry.name}`,
        agent: entry.agent as LaneState["agent"],
        capabilities: entry.capabilities,
        now: entry.anchor,
      }),
    );
  }
  let attention = initialAttentionState();
  const samples: AttentionSample[] = [];
  const eventIndex = new Map<number, number>();
  for (const entry of loaded) eventIndex.set(entry.laneId, 0);

  for (let atMs = 0; atMs <= end; atMs += SAMPLE_MS) {
    const now = anchor + atMs;
    for (const entry of loaded) {
      let state = engineStates.get(entry.laneId);
      if (state === undefined) continue;
      let index = eventIndex.get(entry.laneId) ?? 0;
      while (index < entry.events.length) {
        const event = entry.events[index];
        if (event === undefined || event.ts > now) break;
        state = applyEvent(state, event, entry.capabilities);
        index += 1;
      }
      eventIndex.set(entry.laneId, index);
      state = advance(state, now, entry.capabilities);
      engineStates.set(entry.laneId, state);
    }
    const inputs: AttentionInput[] = [...engineStates.values()]
      .sort((left, right) => left.laneId - right.laneId)
      .map((state) => ({
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
      }));
    const result = computeAttention(inputs, calm, attention, now);
    attention = result.state;
    const byId = new Map(result.renders.map((render) => [render.laneId, render]));
    samples.push({
      atMs,
      lanes: [...engineStates.values()]
        .sort((left, right) => left.laneId - right.laneId)
        .map((state) => {
          const render = byId.get(state.laneId);
          return {
            laneId: state.laneId,
            lifecycle: state.lifecycle,
            lifecycleConfidence: state.lifecycleConfidence,
            struggle: round(state.struggle),
            prominence: round(render?.prominence ?? 0),
            foreground: render?.foreground ?? false,
            gestures: [...(render?.gestures ?? [])].map((gesture) => ({
              gesture: gesture.gesture,
              at: round((gesture.at - anchor) / 1000),
            })),
          };
        }),
    });
  }

  const holders: number[] = [];
  for (const sample of samples) {
    const holder = sample.lanes.find((lane) => lane.foreground)?.laneId;
    if (holder !== undefined && holders.at(-1) !== holder) holders.push(holder);
  }
  let attentionGestures = 0;
  let questionGestures = 0;
  for (const sample of samples) {
    for (const lane of sample.lanes) {
      attentionGestures += lane.gestures.filter(
        (gesture) => gesture.gesture === "attention",
      ).length;
      questionGestures += lane.gestures.filter((gesture) => gesture.gesture === "question").length;
    }
  }
  // Cumulative gesture lists repeat on every sample: count the distinct
  // emissions (gesture + at) per lane instead.
  const seen = new Set<string>();
  for (const sample of samples) {
    for (const lane of sample.lanes) {
      for (const gesture of lane.gestures)
        seen.add(`${lane.laneId}:${gesture.gesture}@${gesture.at}`);
    }
  }
  attentionGestures = [...seen].filter((key) => key.includes(":attention@")).length;
  questionGestures = [...seen].filter((key) => key.includes(":question@")).length;
  return {
    calm,
    samples,
    summary: {
      attentionGestures,
      questionGestures,
      foregroundHolders: holders,
      foregroundTransitions: Math.max(0, holders.length - 1),
      strugglePeak: round(
        Math.max(0, ...samples.flatMap((sample) => sample.lanes.map((lane) => lane.struggle))),
      ),
      prominencePeak: round(
        Math.max(0, ...samples.flatMap((sample) => sample.lanes.map((lane) => lane.prominence))),
      ),
    },
  };
}

function serialized(replay: AttentionReplay): string {
  // Biome formats single-element arrays onto one line; serialize the summary
  // the same way so the golden files are format-stable.
  const text = JSON.stringify(replay, null, 2);
  return `${text.replace(/"foregroundHolders": \[\n\s+(\d+)\n\s+\]/g, '"foregroundHolders": [$1]')}\n`;
}

function goldenPath(agent: string, name: string): string {
  return join(GOLDENS, `${agent}-${name}.attention.json`);
}

describe("golden attention trajectories", () => {
  for (const [agent, name] of attentionFixtures) {
    it(`${agent}/${name} matches its golden attention trajectory`, () => {
      const actual = replayAttention([{ agent, name, laneId: 1 }]);
      const path = goldenPath(agent, name);
      if (process.env.REGENERATE_GOLDENS === "1") writeFileSync(path, serialized(actual));
      expect(serialized(actual)).toBe(readFileSync(path, "utf8"));
    });
  }

  it("replays claude-code and codex concurrently for the three-lane foreground case", () => {
    // Short-window foreground review: the permission-heavy lane enters
    // waiting in the first seconds, so a 30 s window covers join, question
    // and the waiting hold without pinning nine idle minutes per lane.
    const actual = replayAttention(
      [
        { agent: "claude-code", name: "stuck-single-session", laneId: 0 },
        { agent: "codex", name: "stuck-single-session", laneId: 1 },
        { agent: "claude-code", name: "permission-heavy", laneId: 2 },
      ],
      CALM,
      30_000,
    );
    const path = join(GOLDENS, "concurrent-claude-code-codex.attention.json");
    if (process.env.REGENERATE_GOLDENS === "1") writeFileSync(path, serialized(actual));
    expect(serialized(actual)).toBe(readFileSync(path, "utf8"));
  });

  it("fires attention once per 0.6 crossing with a 0.4 re-arm on the stuck fixtures", () => {
    for (const [agent, name] of [
      ["claude-code", "stuck-single-session"],
      ["claude-code", "stuck-fix-loop"],
      ["codex", "stuck-single-session"],
    ] as const) {
      const replay = replayAttention([{ agent, name, laneId: 1 }]);
      const attentionAt = new Map<number, number[]>();
      for (const sample of replay.samples) {
        for (const lane of sample.lanes) {
          for (const gesture of lane.gestures) {
            if (gesture.gesture !== "attention") continue;
            const list = attentionAt.get(lane.laneId) ?? [];
            if (!list.includes(gesture.at)) list.push(gesture.at);
            attentionAt.set(lane.laneId, list);
          }
        }
      }
      // Re-arm discipline: two attention emissions on one lane are either
      // more than the 3 s refractory apart, or struggle dipped below 0.4
      // between them (the golden pins the exact times; this asserts the why).
      for (const [laneId, times] of attentionAt) {
        const ordered = [...times].sort((left, right) => left - right);
        for (let index = 1; index < ordered.length; index += 1) {
          const previous = ordered[index - 1] ?? 0;
          const current = ordered[index] ?? 0;
          if (current - previous >= 3) continue;
          const between = replay.samples.filter(
            (sample) => sample.atMs / 1000 >= previous && sample.atMs / 1000 <= current,
          );
          const dipped = between.some(
            (sample) => (sample.lanes.find((lane) => lane.laneId === laneId)?.struggle ?? 1) < 0.4,
          );
          expect(dipped, `${agent}/${name} lane ${laneId} re-fired without re-arm`).toBe(true);
        }
      }
    }
  });

  it("fires attention on the fix-loop crossing and stays silent below 0.6", () => {
    const loop = replayAttention([{ agent: "claude-code", name: "stuck-fix-loop", laneId: 1 }]);
    expect(loop.summary.attentionGestures).toBeGreaterThan(0);
    // Every attention emission sits at or above the 0.6 crossing sample.
    const seen = new Set<string>();
    for (const sample of loop.samples) {
      for (const lane of sample.lanes) {
        for (const gesture of lane.gestures) {
          if (gesture.gesture !== "attention") continue;
          const key = `${lane.laneId}@${gesture.at}`;
          if (!seen.has(key)) {
            seen.add(key);
            expect(
              lane.struggle,
              `attention fired below 0.6 at ${sample.atMs}ms`,
            ).toBeGreaterThanOrEqual(0.6);
          }
        }
      }
    }
    // The single-session stuck fixtures peak below 0.6 (0.20 / 0.10), so no
    // attention gesture fires there — the golden pins the silence.
    for (const [agent, name] of [
      ["claude-code", "stuck-single-session"],
      ["codex", "stuck-single-session"],
    ] as const) {
      const replay = replayAttention([{ agent, name, laneId: 1 }]);
      expect(replay.summary.strugglePeak).toBeLessThan(0.6);
      expect(replay.summary.attentionGestures).toBe(0);
    }
  });
  it("fires question identically for observed and inferred waiting", () => {
    // asks-question ends with an observed prompt-reason turn.end (question
    // gesture from observed waiting); permission-heavy enters waiting on an
    // observed permission.request. Both carry the identical gesture shape —
    // { gesture: question, at } with no confidence branch in the emission
    // path — which the goldens pin and this asserts structurally.
    for (const [agent, name] of [
      ["claude-code", "asks-question"],
      ["claude-code", "permission-heavy"],
    ] as const) {
      const replay = replayAttention([{ agent, name, laneId: 1 }]);
      const questions = replay.samples.flatMap((sample) =>
        sample.lanes.flatMap((lane) =>
          lane.gestures
            .filter((gesture) => gesture.gesture === "question")
            .map((gesture) => ({ laneId: lane.laneId, at: gesture.at })),
        ),
      );
      expect(questions.length).toBeGreaterThan(0);
      for (const question of questions) {
        expect(Object.keys(question).sort()).toEqual(["at", "laneId"]);
      }
    }
  });

  it("produces byte-identical output for the same replay", () => {
    for (const [agent, name] of attentionFixtures) {
      expect(serialized(replayAttention([{ agent, name, laneId: 1 }]))).toBe(
        serialized(replayAttention([{ agent, name, laneId: 1 }])),
      );
    }
  });
});
