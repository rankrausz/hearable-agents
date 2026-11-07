// packages/daemon/test/engine-replay-drill.test.ts — deterministic Phase 2
// integration drills. What this is for: proving real session JSONL fixtures
// pass through ingest, the daemon-owned engine and broadcast without wall time.
// What it must not do: change fixture data or duplicate core engine heuristics.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Adapter } from "@hearable/adapter-kit";
import type { AdapterCapabilities } from "@hearable/core";
import { describe, expect, it } from "vitest";
import { type AdapterRegistry, createAdapterRegistry } from "../src/adapters.js";
import type { Scheduler, ServerMessage } from "../src/broadcast.js";
import { Broadcaster } from "../src/broadcast.js";
import type { Clock } from "../src/clock.js";
import { createEngineOwner } from "../src/engine.js";
import { createIngest } from "../src/ingest.js";
import { LaneManager } from "../src/lanes.js";
import { createQuarantine } from "../src/quarantine.js";
import { createReplayClock, type ReplayerDeps, replayRecordings } from "../src/replayer.js";
import { Sessions } from "../src/sessions.js";
import { DRILL_CAPABILITIES, drillClaudeShapedAdapter, drillEvent } from "./doubles.js";

// The same 8 active fixtures the golden trajectories replay
// (packages/core/test/engine/trajectories.test.ts §activeFixtures).
const ACTIVE_FIXTURES = [
  ["claude-code", "asks-question"],
  ["claude-code", "clean-feature"],
  ["claude-code", "long-quiet"],
  ["claude-code", "permission-heavy"],
  ["claude-code", "stuck-single-session"],
  ["codex", "clean-feature"],
  ["codex", "permission-heavy"],
  ["codex", "stuck-single-session"],
] as const;

// The goldens replay codex with edit and question evidence denied
// (trajectories.test.ts §adapterCapabilities); the drill must use the same
// capabilities so the live path and the offline goldens agree.
const DRILL_CODEX_CAPABILITIES: AdapterCapabilities = {
  ...DRILL_CAPABILITIES,
  editEvents: false,
  questionEvents: false,
};

/**
 * The codex-shaped drill double: claims the honest codex capabilities so the
 * engine sees the same fidelity the goldens do. Its `map` is never exercised —
 * the replay drill feeds normalized events straight through ingest — so it
 * maps nothing, which is the documented contract for a payload the adapter
 * does not understand.
 */
const drillCodexShapedAdapter: Adapter = {
  id: "codex",
  capabilities: DRILL_CODEX_CAPABILITIES,
  map: () => [],
  install: async () => ({ changed: false, summary: "drill double: nothing to install" }),
  uninstall: async () => {},
  doctor: async () => [],
};

function fixturePath(agent: string, name: string): string {
  return fileURLToPath(
    new URL(`../../../fixtures/sessions/${agent}/${name}.jsonl`, import.meta.url),
  );
}

const PERMISSION_FIXTURE = fixturePath("claude-code", "permission-heavy");
const QUESTION_FIXTURE = fixturePath("claude-code", "asks-question");

type Timeline = {
  readonly clock: Clock;
  readonly scheduler: ManualTimeline;
  set(now: number): void;
};

class ManualTimeline implements Scheduler {
  private current = 0;
  private clockNow = 0;
  private sequence = 0;
  private readonly jobs: {
    dueAt: number;
    sequence: number;
    fn: () => void;
    cancelled: boolean;
  }[] = [];

  now(): number {
    return this.current;
  }

  schedule(fn: () => void, ms: number): () => void {
    const job = { dueAt: this.clockNow + ms, sequence: this.sequence++, fn, cancelled: false };
    this.jobs.push(job);
    return () => {
      job.cancelled = true;
    };
  }

  setClockNow(now: number): void {
    this.clockNow = now;
  }

  advanceTo(target: number): void {
    for (;;) {
      this.jobs.sort((left, right) => left.dueAt - right.dueAt || left.sequence - right.sequence);
      const job = this.jobs[0];
      if (job === undefined || job.dueAt > target) {
        break;
      }
      this.jobs.shift();
      if (job.cancelled) {
        continue;
      }
      this.current = job.dueAt;
      job.fn();
    }
    this.current = target;
    this.jobs.splice(0, this.jobs.length, ...this.jobs.filter((job) => !job.cancelled));
  }
}

function timeline(initialNow: number): Timeline {
  const scheduler = new ManualTimeline();
  let clockNow = initialNow;
  scheduler.setClockNow(initialNow);
  scheduler.advanceTo(initialNow);
  return {
    clock: () => clockNow,
    scheduler,
    set(now) {
      clockNow = now;
      scheduler.setClockNow(now);
    },
  };
}

function fixtureText(path: string): string {
  return readFileSync(path, "utf8");
}

function fixtureEvents(text: string): Record<string, unknown>[] {
  return text
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createHarness(initialNow: number): {
  timeline: Timeline;
  ingest: ReturnType<typeof createIngest>;
  frames: ServerMessage[];
  adapters: AdapterRegistry;
} {
  const timelineValue = timeline(initialNow);
  const sessions = new Sessions();
  const adapters = createAdapterRegistry([drillClaudeShapedAdapter]);
  const lanes = new LaneManager(3, 60_000, sessions, timelineValue.clock);
  const quarantine = createQuarantine(
    `/tmp/hearable-engine-drill-${initialNow}`,
    timelineValue.clock,
  );
  const broadcaster = new Broadcaster(timelineValue.scheduler, timelineValue.clock);
  const engine = createEngineOwner(lanes, sessions, adapters);
  const frames: ServerMessage[] = [];
  broadcaster.target = { send: (message) => frames.push(message) };
  const ingest = createIngest({
    adapters,
    sessions,
    lanes,
    quarantine,
    broadcaster,
    clock: timelineValue.clock,
    applyToEngine: (events, now) => {
      engine.apply(events, now);
    },
    engineSignals: () => engine.snapshot(),
  });
  return { timeline: timelineValue, ingest, frames, adapters };
}

function ingestOne(
  harness: ReturnType<typeof createHarness>,
  event: Record<string, unknown>,
): void {
  const eventTime = event.ts;
  if (typeof eventTime !== "number") {
    throw new Error("Fixture event has no numeric timestamp.");
  }
  harness.timeline.set(eventTime);
  const reason = harness.ingest.handlePostEvents({
    normalized: true,
    agentHeader: null,
    bodyText: JSON.stringify([event]),
  });
  expect(reason).toBeNull();
  harness.timeline.scheduler.advanceTo(eventTime + 100);
}

function signalForFrame(frame: ServerMessage): (typeof frame)["signals"][number] | undefined {
  return frame.signals[0];
}

describe("daemon engine replay drills", () => {
  it("advances after applying an ingest batch before broadcasting its signals", () => {
    const harness = createHarness(0);
    ingestOne(
      harness,
      drillEvent({ id: "start", sessionId: "advance-session", kind: "turn.start" }),
    );

    harness.timeline.set(90_000);
    const reason = harness.ingest.handlePostEvents({
      normalized: true,
      agentHeader: null,
      bodyText: JSON.stringify([
        drillEvent({
          id: "heartbeat",
          sessionId: "advance-session",
          kind: "notification",
          ts: 0,
          meta: { kind: "heartbeat" },
        }),
      ]),
    });
    expect(reason).toBeNull();
    harness.timeline.scheduler.advanceTo(90_100);

    const signal = harness.frames.at(-1)?.signals[0];
    expect(signal?.lifecycle).toBe("quiet");
  });

  it("broadcasts waiting within two seconds of every permission or question fixture event", () => {
    for (const fixture of [PERMISSION_FIXTURE, QUESTION_FIXTURE]) {
      const events = fixtureEvents(fixtureText(fixture));
      const firstTimestamp = events[0]?.ts;
      if (typeof firstTimestamp !== "number") {
        throw new Error(`Fixture ${fixture} has no first event timestamp.`);
      }
      const harness = createHarness(firstTimestamp);
      for (const event of events) {
        ingestOne(harness, event);
        const kind = event.kind;
        const lifecycle = event.lifecycle as { reason?: unknown } | undefined;
        const isWaitingEvent =
          kind === "permission.request" ||
          kind === "question.asked" ||
          (kind === "turn.end" && lifecycle?.reason === "question");
        if (!isWaitingEvent) {
          continue;
        }
        const eventTime = event.ts as number;
        const waitingFrame = [...harness.frames]
          .reverse()
          .find((frame) => signalForFrame(frame)?.lifecycle === "waiting");
        expect(
          waitingFrame,
          `no waiting signal for ${kind} at ${eventTime}: ${JSON.stringify(harness.frames)}`,
        ).toBeDefined();
        expect((waitingFrame?.serverTime ?? Infinity) - eventTime).toBeLessThanOrEqual(2_000);
      }
    }
  });

  it.each(ACTIVE_FIXTURES)(
    "%s/%s produces byte-identical signal snapshots when the fixture is replayed in fresh daemons",
    async (agent, name) => {
      const fixture = fixturePath(agent, name);
      const text = fixtureText(fixture);
      const firstEvent = fixtureEvents(text)[0];
      if (typeof firstEvent?.ts !== "number") {
        throw new Error(`${agent}/${name} fixture has no first event timestamp.`);
      }
      const run = async (): Promise<string> => {
        const timelineValue = createReplayClock(
          firstEvent.ts as number,
          () => firstEvent.ts as number,
        );
        const sessions = new Sessions();
        const lanes = new LaneManager(3, 60_000, sessions, () => timelineValue.now());
        const adapters = createAdapterRegistry([drillClaudeShapedAdapter, drillCodexShapedAdapter]);
        const quarantine = createQuarantine(
          `/tmp/hearable-replay-snapshot-${agent}-${name}-${timelineValue.now()}`,
          () => timelineValue.now(),
        );
        const broadcaster = new Broadcaster(
          {
            schedule: (fn) => {
              fn();
              return () => {};
            },
          },
          () => timelineValue.now(),
        );
        const frames: ServerMessage[] = [];
        broadcaster.target = { send: (message) => frames.push(message) };
        const engine = createEngineOwner(lanes, sessions, adapters);
        const ingest = createIngest({
          adapters,
          sessions,
          lanes,
          quarantine,
          broadcaster,
          clock: () => timelineValue.now(),
          applyToEngine: (events, now) => {
            engine.apply(events, now);
          },
          engineSignals: () => engine.snapshot(),
        });
        const deps: ReplayerDeps = { ingest, clock: timelineValue };
        let wallNow = firstEvent.ts as number;
        await replayRecordings([{ label: fixture, text, namespace: "same-replay" }], deps, {
          anchorNow: firstEvent.ts as number,
          restoreClock: false,
          wallNow: () => wallNow,
          sleep: async (ms) => {
            wallNow += ms;
          },
        });
        const finalFrame = frames.at(-1);
        if (finalFrame === undefined) {
          throw new Error(`${agent}/${name} replay produced no broadcast frame.`);
        }
        return JSON.stringify(finalFrame.signals);
      };

      expect(await run()).toBe(await run());
    },
  );
});
