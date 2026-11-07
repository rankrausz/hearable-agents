// packages/adapter-kit/src/adapter.ts — the contract every agent integration
// implements, plus the supporting types that contract is typed in terms of.
// This module is types only: it must not grow a field or method that only one
// agent could fill honestly (docs/ARCHITECTURE.md warns about exactly that overfit);
// anything agent-specific belongs in capabilities or in the adapter package,
// never here. Every field is documented so five parallel adapter authors fill
// the same contract the same way.

import type { AdapterCapabilities, AgentId, NormalizedEvent } from "@hearable/core";

/**
 * One agent integration: turns that agent's native signals into normalized
 * events and installs whatever delivery mechanism the agent supports.
 */
export interface Adapter {
  /**
   * Which agent this adapter observes; also the value the daemon expects in
   * the `x-hearable-agent` header when a raw payload is posted.
   */
  readonly id: AgentId;

  /**
   * What this source can and cannot tell us (docs/EVENTS.md §Capabilities).
   * The adapter never emits an event kind these deny; conformance checks that.
   */
  readonly capabilities: AdapterCapabilities;

  /**
   * Pure payload-to-events mapping. Reads no clock and performs no I/O: event
   * time comes from the payload where it carries one and from
   * `ctx.receivedAt` otherwise. Must not throw on input it cannot make sense
   * of; it returns an empty array when the payload means nothing to this
   * adapter. The daemon, not the adapter, owns validation and quarantine.
   */
  map(raw: unknown, ctx: MapContext): readonly NormalizedEvent[];

  /**
   * Installs the delivery mechanism into the agent's user-scope config.
   * Idempotent and reversible: a second install changes nothing, and
   * uninstall restores the config byte-for-byte. Must never corrupt config
   * the agent or user already wrote.
   */
  install(opts: InstallOptions): Promise<InstallResult>;

  /**
   * Removes what install added so the agent's config is byte-identical to
   * how it was before installation.
   */
  uninstall(opts: InstallOptions): Promise<void>;

  /**
   * Checks the installed reality of this agent: version, feature flags,
   * trust prompts, reachability. One diagnostic per check, including the
   * checks that pass, so a healthy adapter is visibly healthy.
   */
  doctor(): Promise<readonly Diagnostic[]>;
}

/**
 * The context `map` runs under, owned and threaded by the caller between map
 * calls so `map` itself stays pure. The daemon creates one per session.
 */
export type MapContext = {
  /**
   * When the caller received this raw payload, in ms since the epoch. `map`
   * stamps it on every event as `receivedAt` and uses it as the event time
   * when the payload carries no time of its own.
   */
  readonly receivedAt: number;

  /**
   * Working directory of the agent session, as the payload reports it.
   * Adapters relativise paths against it (docs/EVENTS.md §Fingerprints).
   */
  readonly cwd: string;

  /**
   * Tool calls this session has started but not finished, so a `tool.end`
   * payload can find its `tool.start` and compute a duration without `map`
   * keeping state. The caller owns this list; the kit provides the pure
   * helpers that maintain it (see src/tool-starts.ts).
   */
  readonly pendingToolStarts: PendingToolStarts;
};

/**
 * One tool call that has started but not finished, recorded when its
 * `tool.start` event was mapped and consumed when the matching end or fail
 * arrives.
 */
export type PendingToolStart = {
  /** The session the tool call belongs to (a subagent id for subagent calls). */
  readonly sessionId: string;

  /** The agent's own tool name, exactly as the payload carried it. */
  readonly toolName: string;

  /**
   * The agent's own id for this call when the payload carries one (Claude
   * Code's `tool_use_id`); lets an end match its start exactly instead of by
   * position when a session runs tools in parallel.
   */
  readonly toolUseId?: string;

  /** Event time of the `tool.start`, in ms since the epoch. */
  readonly startedAt: number;
};

/** The pending tool starts of one session's mapping context. */
export type PendingToolStarts = readonly PendingToolStart[];

/**
 * Where and how to install. Deliberately mechanism-agnostic: config-dir plus
 * daemon URL covers every delivery mechanism (command hook, HTTP hook,
 * in-process plugin, editor config snippet) without naming any of them.
 */
export type InstallOptions = {
  /**
   * Directory that holds the agent's user-scope configuration (Claude Code's
   * `~/.claude`, Codex's `~/.codex`, Cursor's `~/.cursor`, OpenCode's
   * `~/.config/opencode`). Conformance always points this at a throwaway
   * copy so a real user config is never touched.
   */
  readonly configDir: string;

  /**
   * URL the installed mechanism uses to reach the daemon; embedded into hook
   * commands, HTTP hook configs or plugin code.
   */
  readonly daemonUrl: string;
};

/** What `install` reports back to the caller. */
export type InstallResult = {
  /**
   * False when the agent was already installed exactly as requested, which is
   * how install is idempotent; the idempotence conformance case asserts a
   * second install reports false.
   */
  readonly changed: boolean;

  /** What the install did, in plain language; the CLI prints this to the user. */
  readonly summary: string;
};

/** One `doctor` finding about the adapter's installed reality. */
export type Diagnostic = {
  /**
   * ok = the check passed; warn = degraded but usable; fail = broken until the
   * fix is applied.
   */
  readonly severity: "ok" | "warn" | "fail";

  /**
   * What was checked and what it found, in plain language; for warn and fail
   * this states what is wrong (for example exactly which feature flag is off
   * and which trust step is missing).
   */
  readonly message: string;

  /**
   * What to do about it, in plain language; omitted when severity is ok.
   */
  readonly fix?: string;
};
