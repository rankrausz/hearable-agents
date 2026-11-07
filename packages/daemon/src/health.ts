// packages/daemon/src/health.ts — the /health report. What this is for:
// one JSON document that says the daemon is alive, what version it is, how
// many payloads were quarantined, which lanes are occupied and how many
// sessions each adapter currently has — everything a human or `doctor` needs
// at a glance (docs/ARCHITECTURE.md §Failure behaviour, task p1-t05). What it
// must not do: include secrets, raw payloads or computed audio/attention state
// — none of that exists until Phase 2, and health is a liveness report, not a
// dump.

import type { LaneSnapshot, LaneView } from "./lanes.js";
import type { Sessions } from "./sessions.js";

export type HealthReport = {
  status: "ok";
  version: string;
  uptimeMs: number;
  quarantineCount: number;
  lanesTotal: number;
  lanesOccupied: number;
  lanes: LaneView[];
  queued: LaneSnapshot["queued"];
  sessionsByAgent: Record<string, number>;
  calmWarning: string | null;
};

/** Builds the health report from current daemon state. */
export function buildHealth(options: {
  daemonVersion: string;
  startedAt: number;
  now: number;
  quarantineCount: number;
  laneSnapshot: LaneSnapshot;
  lanesTotal: number;
  sessions: Sessions;
  calmWarning: string | null;
}): HealthReport {
  const byAgent: Record<string, number> = {};
  for (const record of options.sessions.all()) {
    byAgent[record.agent] = (byAgent[record.agent] ?? 0) + 1;
  }
  return {
    status: "ok",
    version: options.daemonVersion,
    uptimeMs: options.now - options.startedAt,
    quarantineCount: options.quarantineCount,
    lanesTotal: options.lanesTotal,
    lanesOccupied: options.laneSnapshot.lanes.filter((lane) => lane.state === "active").length,
    lanes: options.laneSnapshot.lanes,
    queued: options.laneSnapshot.queued,
    sessionsByAgent: byAgent,
    calmWarning: options.calmWarning,
  };
}
