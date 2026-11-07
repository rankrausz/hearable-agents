// packages/adapter-kit/src/conformance/suites.ts — the suite configuration an
// adapter hands to the conformance runner, and the seven categories
// docs/ARCHITECTURE.md makes non-negotiable for every adapter. What this is for: naming
// the bar once so five adapters are measured by the same ruler, with every
// suite input data-shaped (payloads, options, assertions) so adapter packages
// supply fixtures, never code, and the kit keeps no per-agent knowledge. What
// it must not do: accept behaviour or callbacks from adapters — a suite the
// kit cannot run from data alone does not belong here.

import type { NormalizedEvent } from "@hearable/core";
import type { InstallOptions, MapContext } from "../adapter.js";

/**
 * The conformance categories every adapter must eventually cover, in the
 * order docs/ARCHITECTURE.md lists them.
 */
export const CONFORMANCE_CATEGORIES = [
  "fixture-mapping",
  "installer-idempotence",
  "byte-exact-uninstall",
  "relay-timing",
  "unknown-event-preservation",
  "redaction",
  "capability-honesty",
] as const;

export type ConformanceCategory = (typeof CONFORMANCE_CATEGORIES)[number];

/** The human-readable statement of each category, used in case titles. */
export const CATEGORY_TITLES: Readonly<Record<ConformanceCategory, string>> = {
  "fixture-mapping": "fixture payloads map to the expected events",
  "installer-idempotence": "installing twice changes nothing the second time",
  "byte-exact-uninstall": "uninstall leaves the agent config byte-identical",
  "relay-timing": "the relay stays inside its timing budget",
  "unknown-event-preservation": "unknown events are preserved, never dropped",
  redaction: "recorded events carry only redacted data",
  "capability-honesty": "never emits an event kind its capabilities deny",
};

/** One captured raw payload and the events the adapter must produce for it. */
export type FixtureCase = {
  /** Human name for the payload, shown in the case title. */
  readonly name: string;

  /** The raw payload exactly as the agent produced it (a redacted fixture). */
  readonly raw: unknown;

  /**
   * The context map runs under: receivedAt, cwd and pending tool starts.
   * Explicit, never defaulted, so the expected events stay deterministic.
   */
  readonly ctx: MapContext;

  /** The events the adapter must produce for this payload. */
  readonly expected: readonly NormalizedEvent[];
};

/** The fixture suite: every captured payload with its expected events. */
export type FixtureSuite = readonly FixtureCase[];

/**
 * What the installer cases need to check install and uninstall against. The
 * suite must point at a throwaway copy of the agent config so conformance
 * never touches a real one.
 */
export type InstallerSuite = {
  /** Install options the cases pass to install and uninstall. */
  readonly opts: InstallOptions;

  /**
   * Restores the throwaway config to its pristine, never-installed state.
   * Every installer case starts by calling this, so each case is checked
   * against an explicit clean baseline no matter what an earlier case left
   * behind — without it, the case that runs second would measure the first
   * case's leftovers.
   */
  readonly resetConfig: () => Promise<void>;

  /**
   * Reads the agent configuration the adapter installs into, exactly as
   * bytes; the byte-exact case compares the config before install with the
   * config after uninstall.
   */
  readonly readConfig: () => Promise<string>;
};

/** One raw payload the agent can send that no adapter table knows. */
export type UnknownEventCase = {
  /** Human name for the payload, shown in the case title. */
  readonly name: string;

  /** The raw payload exactly as the agent produced it (a redacted fixture). */
  readonly raw: unknown;

  /** The context map runs under; explicit, never defaulted. */
  readonly ctx: MapContext;
};

/** The unknown-event suite: payloads that must be preserved as notifications. */
export type UnknownEventSuite = readonly UnknownEventCase[];

/**
 * The wall time budget every relay spawn is measured against. The same
 * 50 ms per-event budget docs/ARCHITECTURE.md demands of the delivery path: the
 * default when an adapter does not name its own.
 */
export const RELAY_TIMING_BUDGET_MS = 50 as const;

/**
 * How the timing suite delivers one payload to the relay: the raw hook
 * payload as text (exactly what the agent writes to stdin), the adapter id
 * passed as `--agent`, and the daemon URL passed as `--url`.
 */
export type RelayTimingPayload = {
  /** Human name for the payload, shown in the case title. */
  readonly name: string;

  /** The raw hook payload text piped to the relay's stdin. */
  readonly payload: string;

  /** The adapter id for the relay's `--agent` flag. */
  readonly agentId: string;
};

/**
 * The relay-timing suite: payloads to push through the real
 * `hearable-hook` binary path. Adapter packages supply only these
 * data-shaped inputs — the payloads their agent really sends — and the kit
 * runs the identical measurement for every adapter (docs/ARCHITECTURE.md
 * §The hook relay, "the relay-timing conformance suite (p1-t07) reuses this
 * method unchanged"): wall time per event through real relay spawns against
 * a local stub daemon, checked against the fixed 50 ms budget
 * (`RELAY_TIMING_BUDGET_MS`), with retry-and-median semantics that keep
 * cold-start noise from failing a healthy relay. The budget is fixed on
 * purpose: retries and medians are the noise mechanism, never threshold
 * changes — loosening the budget is a `docs/ARCHITECTURE.md` scope decision for the
 * human (see the task notes). `samples` and `retries` name repeat counts
 * only, never the budget.
 */
export type RelayTimingSuite = {
  /** Payloads to deliver through the real relay, one measurement each. */
  readonly payloads: readonly RelayTimingPayload[];

  /**
   * How many timed spawns each measurement takes per attempt. Defaults to
   * 5 — enough for a median, cheap enough for a conformance run.
   */
  readonly samples?: number;

  /**
   * How many attempts each measurement may take: the suite records the
   * median of every attempt and reports the best one, so one cold-start
   * spike cannot fail a healthy relay. Defaults to 3.
   */
  readonly retries?: number;
};

/**
 * One redaction case: the events that went in and the forbidden strings
 * that must not survive recording. The adapter proves its session ids,
 * paths, prompts, tool I/O and non-allowlisted meta never reach the
 * recorded lines (docs/EVENTS.md §Redaction, ADR 0006); the kit serialises
 * the events the way the recorder persists them (one JSON line per event)
 * and asserts every forbidden string is absent.
 */
export type RedactionCase = {
  /** Human name for the case, shown in the case title. */
  readonly name: string;

  /** The events to record, typically the adapter's own mapped events. */
  readonly events: readonly NormalizedEvent[];

  /**
   * Strings that must not appear anywhere in the recorded JSONL lines:
   * prompts, absolute paths, tool I/O, `lifecycle.message` text and
   * non-allowlisted `meta` values. Each is named explicitly so a failure
   * says which secret survived.
   */
  readonly forbidden: readonly string[];
};

/** The redaction suite: events in, forbidden-field assertions on the recorded lines. */
export type RedactionSuite = readonly RedactionCase[];

/**
 * The suites an adapter registers with the conformance runner. Every key is
 * optional because the runner must stay green and honest with nothing
 * supplied: an absent suite is reported as a visible not-covered category,
 * never silently skipped. Each suite is data the adapter's fixtures already
 * describe (payloads, options, assertions) — never behaviour — so the kit
 * keeps no per-agent knowledge and both adapters reuse the identical
 * measurement. Phase 1b authors adopt a suite by filling its shape;
 * nothing else is required.
 */
export type ConformanceSuites = {
  /** Fixture payloads with the events each must map to. */
  readonly fixtures?: FixtureSuite;

  /** A throwaway agent config to check install and uninstall against. */
  readonly installer?: InstallerSuite;

  /**
   * Payloads to push through the real `hearable-hook` binary plus the
   * noise controls (`samples`, `retries`). The budget is fixed at
   * `RELAY_TIMING_BUDGET_MS`; absent until an adapter registers its
   * agent's payloads.
   */
  readonly relayTiming?: RelayTimingSuite;

  /** Payloads the adapter does not know; each must be preserved, not dropped. */
  readonly unknownEvents?: UnknownEventSuite;

  /**
   * Events in with forbidden strings that must not survive the recorded
   * lines. Absent until an adapter registers its mapped events with the
   * secrets they must not leak.
   */
  readonly redaction?: RedactionSuite;

  /**
   * The events the adapter produces, however they were obtained — typically
   * by mapping the fixture payloads. The capability-honesty case checks them
   * against the adapter's capabilities, which needs no fixtures: any events
   * will do.
   */
  readonly emissions?: readonly NormalizedEvent[];
};
