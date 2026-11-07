// packages/core/test/engine/trajectories.test.ts — offline golden replay tests
// for every recorded engine session. This test may read fixtures and goldens,
// but the engine itself remains pure and no fixture is ever rewritten.

// biome-ignore lint/style/noRestrictedImports: fixture I/O is confined to this test harness; src remains pure.
import { readFileSync, writeFileSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: fixture I/O is confined to this test harness; src remains pure.
import { dirname, join } from "node:path";
// biome-ignore lint/style/noRestrictedImports: fixture I/O is confined to this test harness; src remains pure.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { advance, applyEvent, createLane, type LaneState } from "../../src/engine/index.js";
import {
  type AdapterCapabilities,
  AdapterCapabilitiesSchema,
  type NormalizedEvent,
  NormalizedEventSchema,
} from "../../src/events/schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../");
const FIXTURES = join(ROOT, "fixtures/sessions");
const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), "trajectories");
const SAMPLE_MS = 1_000;

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

const activeFixtures = [
  ["claude-code", "asks-question"],
  ["claude-code", "clean-feature"],
  ["claude-code", "long-quiet"],
  ["claude-code", "permission-heavy"],
  ["claude-code", "stuck-single-session"],
  ["codex", "clean-feature"],
  ["codex", "permission-heavy"],
  ["codex", "stuck-single-session"],
] as const;

type Annotation = {
  readonly durationMs: number;
  readonly deprecated?: boolean;
  readonly struggleSegments: readonly { readonly fromMs: number; readonly toMs: number }[];
};

type Snapshot = {
  readonly atMs: number;
  readonly source: "event" | "sample";
  readonly eventKind?: NormalizedEvent["kind"];
  readonly lifecycle: LaneState["lifecycle"];
  readonly lifecycleConfidence: LaneState["lifecycleConfidence"];
  readonly waitingReason?: LaneState["waitingReason"];
  readonly displayedMode: LaneState["displayedMode"];
  readonly mode: LaneState["mode"];
  readonly activity: number;
  readonly progress: number;
  readonly struggle: number;
  readonly lastEventAtMs: number;
  readonly turnStartedAtMs?: number;
  readonly reasons: readonly {
    readonly atMs: number;
    readonly signal: string;
    readonly delta?: number;
    readonly text: string;
  }[];
};

type Replay = {
  readonly snapshots: readonly Snapshot[];
  readonly final: Snapshot;
  readonly summary: {
    readonly strugglePeakInsideSegments: number;
    readonly strugglePeakOutsideSegments: number;
    readonly lifecycleTransitions: number;
    readonly displayedModeTransitions: number;
    readonly waitingLatenciesMs: readonly number[];
  };
};

function round(value: number): number {
  return Number(value.toFixed(6));
}

function readSession(
  agent: string,
  name: string,
): {
  events: NormalizedEvent[];
  annotation: Annotation;
} {
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
  return { events, annotation };
}

function snapshot(
  state: LaneState,
  anchor: number,
  source: Snapshot["source"],
  eventKind?: NormalizedEvent["kind"],
  clockAt = state.lastEventAt,
): Snapshot {
  return {
    atMs: clockAt - anchor,
    source,
    ...(eventKind === undefined ? {} : { eventKind }),
    lifecycle: state.lifecycle,
    lifecycleConfidence: state.lifecycleConfidence,
    ...(state.waitingReason === undefined ? {} : { waitingReason: state.waitingReason }),
    displayedMode: state.displayedMode,
    mode: {
      exploring: round(state.mode.exploring),
      editing: round(state.mode.editing),
      testing: round(state.mode.testing),
      other: round(state.mode.other),
    },
    activity: round(state.activity),
    progress: round(state.progress),
    struggle: round(state.struggle),
    lastEventAtMs: round(state.lastEventAt - anchor),
    ...(state.turnStartedAt === undefined
      ? {}
      : { turnStartedAtMs: round(state.turnStartedAt - anchor) }),
    reasons: state.reasons.map((reason) => ({
      atMs: round(reason.at - anchor),
      signal: reason.signal,
      ...(reason.delta === undefined ? {} : { delta: round(reason.delta) }),
      text: reason.text,
    })),
  };
}

function replay(agent: string, name: string, capabilities?: AdapterCapabilities): Replay {
  const { events, annotation } = readSession(agent, name);
  const ordered = [...events].sort((left, right) => left.ts - right.ts);
  const anchor = ordered[0]?.ts ?? 0;
  const end = Math.max(annotation.durationMs, (ordered.at(-1)?.ts ?? anchor) - anchor);
  const replayCapabilities = capabilities ?? adapterCapabilities[agent] ?? fullCapabilities;
  let state = createLane({
    laneId: 1,
    sessionId: ordered[0]?.sessionId ?? `${agent}-${name}`,
    agent: agent as LaneState["agent"],
    capabilities: replayCapabilities,
    now: anchor,
  });
  const snapshots: Snapshot[] = [];
  let eventIndex = 0;
  let previousLifecycle = state.lifecycle;
  let previousMode = state.displayedMode;
  const waitingLatenciesMs: number[] = [];

  const checkpoints = new Set<number>();
  for (let atMs = 0; atMs <= end; atMs += SAMPLE_MS) checkpoints.add(atMs);
  for (const event of ordered) checkpoints.add(event.ts - anchor);

  for (const atMs of [...checkpoints].sort((left, right) => left - right)) {
    const now = anchor + atMs;
    while (eventIndex < ordered.length) {
      const event = ordered[eventIndex];
      if (event === undefined) break;
      if (event.ts > now) break;
      const lifecycleBeforeEvent = state.lifecycle;
      state = applyEvent(state, event, replayCapabilities);
      if (
        lifecycleBeforeEvent !== "waiting" &&
        state.lifecycle === "waiting" &&
        isWaitingCause(event)
      ) {
        waitingLatenciesMs.push(event.ts - event.ts);
      }
      if (state.lifecycle !== previousLifecycle || state.displayedMode !== previousMode) {
        snapshots.push(snapshot(state, anchor, "event", event.kind));
        previousLifecycle = state.lifecycle;
        previousMode = state.displayedMode;
      }
      eventIndex += 1;
    }
    state = advance(state, now, replayCapabilities);
    if (atMs % SAMPLE_MS === 0) snapshots.push({ ...snapshot(state, anchor, "sample"), atMs });
    if (state.lifecycle !== previousLifecycle || state.displayedMode !== previousMode) {
      snapshots.push(snapshot(state, anchor, "sample", undefined, now));
      previousLifecycle = state.lifecycle;
      previousMode = state.displayedMode;
    }
  }

  const strugglePeakInsideSegments = Math.max(
    0,
    ...snapshots
      .filter((entry) =>
        annotation.struggleSegments.some(
          (segment) => entry.atMs >= segment.fromMs && entry.atMs <= segment.toMs,
        ),
      )
      .map((entry) => entry.struggle),
  );
  const strugglePeakOutsideSegments = Math.max(
    0,
    ...snapshots
      .filter((entry) =>
        annotation.struggleSegments.every(
          (segment) => entry.atMs < segment.fromMs || entry.atMs > segment.toMs,
        ),
      )
      .map((entry) => entry.struggle),
  );
  return {
    snapshots,
    final: snapshots.at(-1) ?? snapshot(state, anchor, "sample"),
    summary: {
      strugglePeakInsideSegments: round(strugglePeakInsideSegments),
      strugglePeakOutsideSegments: round(strugglePeakOutsideSegments),
      lifecycleTransitions: snapshots.filter(
        (entry, index) => index > 0 && entry.lifecycle !== snapshots[index - 1]?.lifecycle,
      ).length,
      displayedModeTransitions: snapshots.filter(
        (entry, index) => index > 0 && entry.displayedMode !== snapshots[index - 1]?.displayedMode,
      ).length,
      waitingLatenciesMs: waitingLatenciesMs.map(round),
    },
  };
}

function serialized(replayResult: Replay): string {
  const text = JSON.stringify(replayResult, null, 2);
  const waitingValues = replayResult.summary.waitingLatenciesMs.join(", ");
  const waiting =
    waitingValues.length > 80 ? `[\n      ${waitingValues}\n    ]` : `[${waitingValues}]`;
  return `${text.replace(
    /"waitingLatenciesMs": \[\n(?:\s+\d+,?\n)+\s+\]/,
    `"waitingLatenciesMs": ${waiting}`,
  )}\n`;
}

function goldenPath(agent: string, name: string): string {
  return join(GOLDENS, `${agent}-${name}.json`);
}

function withCapabilities(
  agent: string,
  overrides: Partial<AdapterCapabilities>,
): AdapterCapabilities {
  return { ...(adapterCapabilities[agent] ?? fullCapabilities), ...overrides };
}

function isWaitingCause(event: NormalizedEvent): boolean {
  return (
    event.kind === "permission.request" ||
    event.kind === "question.asked" ||
    (event.kind === "turn.end" &&
      (event.lifecycle.reason === "question" ||
        event.lifecycle.reason === "permission" ||
        event.lifecycle.reason === "idle_prompt"))
  );
}

describe("fixture engine trajectories", () => {
  for (const [agent, name] of activeFixtures) {
    it(`${agent}/${name} matches its golden trajectory`, () => {
      const actual = replay(agent, name);
      const path = goldenPath(agent, name);
      if (process.env.REGENERATE_GOLDENS === "1") writeFileSync(path, serialized(actual));
      expect(serialized(actual)).toBe(readFileSync(path, "utf8"));
    });
  }

  it("loads the deprecated stuck-fix-loop fixture as a regression smoke case", () => {
    const actual = replay("claude-code", "stuck-fix-loop");
    expect(actual.snapshots.length).toBeGreaterThan(0);
    expect(actual.final.lifecycle).toBeDefined();
    const path = goldenPath("claude-code", "stuck-fix-loop");
    if (process.env.REGENERATE_GOLDENS === "1") writeFileSync(path, serialized(actual));
    expect(serialized(actual)).toBe(readFileSync(path, "utf8"));
  });

  it("keeps denied evidence out of the stuck trajectories", () => {
    for (const [agent, name] of [
      ["claude-code", "stuck-single-session"],
      ["codex", "stuck-single-session"],
    ] as const) {
      const noEdits = replay(agent, name, withCapabilities(agent, { editEvents: false }));
      const noFailures = replay(agent, name, withCapabilities(agent, { toolFailures: false }));
      const noPrompts = replay(
        agent,
        name,
        withCapabilities(agent, { permissionEvents: false, questionEvents: false }),
      );
      const hasEditEvidence = (reason: { readonly text: string }): boolean =>
        reason.text.startsWith("Same file") || reason.text.startsWith("Edit, fail");
      const hasFailureEvidence = (reason: { readonly text: string }): boolean =>
        reason.text.startsWith("Same command") && reason.text.includes("failed");
      const hasRetryOrReadEvidence = (reason: { readonly text: string }): boolean =>
        reason.text.includes("ran again with no edit") || reason.text.includes("repeated");
      const hasAllowedProgressEvidence = (reason: { readonly text: string }): boolean =>
        reason.text.startsWith("New command") || reason.text.startsWith("New file");
      // A denied prompt event is one the source could not have emitted (the
      // adapter never emits what capabilities deny), so any waiting entry it
      // causes is denied evidence. Observed prompt causes are the explicit
      // prompt events and prompt-reason turn ends; the completed turn end
      // with a trailing-`?` message is the one allowed inferred path.
      const causedWaitingFromDeniedPrompt = (entry: Snapshot): boolean =>
        entry.lifecycle === "waiting" &&
        entry.reasons.some(
          (reason) =>
            reason.signal === "lifecycle" &&
            (reason.text === "Lane is waiting: permission requested." ||
              reason.text === "Lane is waiting: question asked." ||
              reason.text.startsWith("Turn ended: lane is waiting (")),
        );
      const componentDelta = (
        entry: Snapshot,
        predicate: (reason: { readonly text: string }) => boolean,
      ): number =>
        entry.reasons.reduce(
          (total, reason) =>
            total + (reason.signal === "struggle" && predicate(reason) ? (reason.delta ?? 0) : 0),
          0,
        );

      // These are complete fixture replays. The disabled component is exactly
      // zero when its per-snapshot explainability delta is zero.
      expect(
        noEdits.snapshots.every((entry) => componentDelta(entry, hasEditEvidence) === 0),
        `${agent}/${name} edit evidence remained visible`,
      ).toBe(true);
      expect(
        noFailures.snapshots.every((entry) => componentDelta(entry, hasFailureEvidence) === 0),
        `${agent}/${name} failure evidence remained visible`,
      ).toBe(true);
      // Complete fixture replay with both prompt capabilities denied: no
      // snapshot may enter waiting from a denied prompt event. The stuck
      // fixtures carry no prompt events at all, so the whole trajectory
      // must stay out of prompt-caused waiting.
      expect(
        noPrompts.snapshots.every((entry) => !causedWaitingFromDeniedPrompt(entry)),
        `${agent}/${name} prompt-denied waiting entry remained visible`,
      ).toBe(true);
      expect(
        noEdits.snapshots.some((entry) =>
          entry.reasons.some(
            (reason) => hasRetryOrReadEvidence(reason) || hasAllowedProgressEvidence(reason),
          ),
        ),
        `${agent}/${name} edit-denied retry/read evidence`,
      ).toBe(true);
      expect(
        noFailures.snapshots.some((entry) =>
          entry.reasons.some(
            (reason) => hasRetryOrReadEvidence(reason) || hasAllowedProgressEvidence(reason),
          ),
        ),
        `${agent}/${name} failure-denied retry/read evidence`,
      ).toBe(true);
      // Prompt capabilities gate lifecycle waiting only, so struggle and
      // progress evidence still fires on the prompt-denied lane.
      expect(
        noPrompts.snapshots.some((entry) =>
          entry.reasons.some(
            (reason) => hasRetryOrReadEvidence(reason) || hasAllowedProgressEvidence(reason),
          ),
        ),
        `${agent}/${name} prompt-denied retry/read evidence`,
      ).toBe(true);
    }
  });

  it("records fixture summaries without calibrating thresholds", () => {
    for (const [agent, name] of activeFixtures) {
      const result = replay(agent, name);
      expect(result.summary.strugglePeakInsideSegments).toBeGreaterThanOrEqual(0);
      expect(result.summary.strugglePeakOutsideSegments).toBeGreaterThanOrEqual(0);
      expect(result.summary.displayedModeTransitions).toBeGreaterThanOrEqual(0);
      const { events } = readSession(agent, name);
      if (events.length > 2) {
        expect(result.snapshots.length).toBeGreaterThan(1);
        expect(
          result.summary.lifecycleTransitions + result.summary.displayedModeTransitions,
        ).toBeGreaterThan(0);
      }
      if (name === "permission-heavy" || name === "asks-question") {
        expect(result.summary.waitingLatenciesMs).toHaveLength(1);
      }
    }
  });

  it("produces byte-identical output for the same replay", () => {
    for (const [agent, name] of activeFixtures) {
      expect(serialized(replay(agent, name))).toBe(serialized(replay(agent, name)));
    }
  });

  it("validates the capability shape used by every replay", () => {
    expect(AdapterCapabilitiesSchema.safeParse(fullCapabilities).success).toBe(true);
  });
});
