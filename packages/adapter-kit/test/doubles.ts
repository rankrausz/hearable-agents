// packages/adapter-kit/test/doubles.ts — the kit's own test doubles: minimal
// adapters and event builders used by the kit's unit tests and by the
// conformance self-check (conformance/selfcheck.ts). What this is for: giving
// the runner something honest to run against without any real agent. What it
// must not do: resemble any real adapter's behaviour — these doubles are the
// smallest things that exercise the contract, and every event they build is
// validated through the core schema so test data cannot quietly rot.

import type { AdapterCapabilities, EventKind, NormalizedEvent, ToolInfo } from "@hearable/core";
import { NormalizedEventSchema, SCHEMA_VERSION } from "@hearable/core";
import type { Adapter, InstallOptions, MapContext } from "../src/adapter.js";
import { parseClaudeShapedHook } from "../src/claude-shaped-hooks.js";
import type {
  InstallerSuite,
  RedactionSuite,
  RelayTimingSuite,
} from "../src/conformance/suites.js";

/** Capabilities of a hypothetical source that can observe everything. */
export const ALL_OBSERVED: AdapterCapabilities = {
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

/** Capabilities of a hypothetical source that can observe nothing. */
export const NOTHING_OBSERVED: AdapterCapabilities = {
  sessionEvents: false,
  turnStart: "none",
  turnEnd: "none",
  toolEvents: false,
  toolFailures: false,
  editEvents: false,
  execEvents: false,
  permissionEvents: false,
  questionEvents: false,
  subagents: false,
  compaction: false,
  toolKinds: "none",
  durations: false,
};

/** A deterministic map context for tests: fixed time, fixed cwd, no pending starts. */
export function testContext(): MapContext {
  return { receivedAt: 1000, cwd: "/repo", pendingToolStarts: [] };
}

/** Install options for tests; the in-memory doubles ignore them. */
export function testInstallOptions(): InstallOptions {
  return { configDir: "/throwaway/agent-config", daemonUrl: "http://127.0.0.1:9" };
}

/**
 * Builds one normalized event from a partial raw object, filling the required
 * base fields, and validates the result through the core schema so a
 * malformed test event fails loudly instead of poisoning a test.
 */
export function testEvent(raw: Record<string, unknown>): NormalizedEvent {
  return NormalizedEventSchema.parse({
    v: SCHEMA_VERSION,
    id: "e1",
    ts: 0,
    receivedAt: 0,
    agent: "emit",
    sessionId: "s1",
    ...raw,
  });
}

const TOOL_KINDS: ReadonlySet<EventKind> = new Set(["tool.start", "tool.end", "tool.fail"]);

/**
 * The smallest schema-valid event of each kind, for tests that need one
 * event of many kinds. Tool categories default to "read"; pass a category
 * when a test is about edit or exec gating.
 */
export function minimalEventFor(
  kind: EventKind,
  tool?: Pick<ToolInfo, "name" | "category">,
): NormalizedEvent {
  const base = {
    v: SCHEMA_VERSION,
    id: `e-${kind}`,
    ts: 0,
    receivedAt: 0,
    agent: "emit",
    sessionId: "s1",
    kind,
  } as Record<string, unknown>;

  if (TOOL_KINDS.has(kind)) {
    const toolInfo = {
      name: tool?.name ?? "Read",
      category: tool?.category ?? "read",
      fingerprint: "fingerprint",
    };
    if (kind === "tool.end") {
      return testEvent({ ...base, tool: { ...toolInfo, outcome: { ok: true } } });
    }
    if (kind === "tool.fail") {
      return testEvent({ ...base, tool: { ...toolInfo, outcome: { ok: false } } });
    }
    return testEvent({ ...base, tool: toolInfo });
  }

  switch (kind) {
    case "turn.end":
      return testEvent({ ...base, lifecycle: { reason: "completed", confidence: "observed" } });
    case "permission.request":
      return testEvent({ ...base, lifecycle: { reason: "permission", confidence: "observed" } });
    case "question.asked":
      return testEvent({ ...base, lifecycle: { reason: "question", confidence: "observed" } });
    case "subagent.start":
    case "subagent.end":
      return testEvent({ ...base, parentSessionId: "parent" });
    case "notification":
      return testEvent({ ...base, meta: { kind: "note" } });
    default:
      return testEvent(base);
  }
}

/** A minimal adapter with the given capabilities; maps everything to nothing. */
export function stubAdapter(overrides: {
  id?: Adapter["id"];
  capabilities: AdapterCapabilities;
  map?: Adapter["map"];
}): Adapter {
  return {
    id: overrides.id ?? "emit",
    capabilities: overrides.capabilities,
    map: overrides.map ?? (() => []),
    install: async () => ({ changed: false, summary: "test double: nothing to install" }),
    uninstall: async () => {},
    doctor: async () => [],
  };
}

/**
 * A lean double that can observe nothing and emits nothing: the kit's stand-in
 * for the sparsest agent. Its own conformance run is the honest "no suites
 * registered" demonstration.
 */
export const leanTestAdapter: Adapter = stubAdapter({ capabilities: NOTHING_OBSERVED });

/**
 * A capable double with everything observed, for suites that check covered
 * paths; its map emits nothing, so emissions are supplied by the suite.
 */
export const capableTestAdapter: Adapter = stubAdapter({
  id: "claude-code",
  capabilities: ALL_OBSERVED,
});

/** Events that only contain kinds ALL_OBSERVED permits. */
export const permittedEvents: readonly NormalizedEvent[] = [
  minimalEventFor("session.start"),
  minimalEventFor("turn.start"),
  minimalEventFor("tool.start"),
  minimalEventFor("tool.end"),
  minimalEventFor("permission.request"),
  minimalEventFor("subagent.start"),
  minimalEventFor("compaction"),
  minimalEventFor("notification"),
];

// A double that speaks the claude-shaped family well enough to exercise the
// fixture and unknown-event paths: SessionStart becomes a session.start, any
// other known-shape event becomes a preserved notification.
const claudeShapedMap: Adapter["map"] = (raw, ctx) => {
  const hook = parseClaudeShapedHook(raw);
  if (hook.sessionId === null || hook.hookEventName === null) {
    return [];
  }
  if (hook.hookEventName === "SessionStart") {
    return [
      testEvent({
        id: `stub-${hook.sessionId}-session-start`,
        ts: ctx.receivedAt,
        receivedAt: ctx.receivedAt,
        agent: "claude-code",
        sessionId: hook.sessionId,
        kind: "session.start",
      }),
    ];
  }
  return [
    testEvent({
      id: `stub-${hook.sessionId}-${hook.hookEventName}`,
      ts: ctx.receivedAt,
      receivedAt: ctx.receivedAt,
      agent: "claude-code",
      sessionId: hook.sessionId,
      kind: "notification",
      meta: { kind: "unknown", hookEvent: hook.hookEventName },
    }),
  ];
};

/** A double for the fixture-mapping and unknown-event covered paths. */
export const claudeShapedTestAdapter: Adapter = stubAdapter({
  id: "claude-code",
  capabilities: ALL_OBSERVED,
  map: claudeShapedMap,
});

/**
 * A relay-timing suite for the kit's own registrations: one representative
 * hook payload through the real hearable-hook binary, the adapter id the
 * capable double registers under, and the default 50 ms budget. The payload
 * carries no secrets — it exists to prove the timing path is measured, not
 * to prove redaction.
 */
export const selfcheckRelayTiming: RelayTimingSuite = {
  payloads: [
    {
      name: "representative pre-tool-use",
      payload: JSON.stringify({
        session_id: "timing-check",
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        tool_name: "Read",
        tool_input: { file_path: "/repo/src/index.ts" },
      }),
      agentId: "claude-code",
    },
  ],
};

/**
 * A redaction suite for the kit's own registrations: the permitted events
 * with the secrets they must not leak named explicitly. Because the doubles
 * are machine-generated test data rather than real agent payloads, the
 * recorded lines carry no prompts, paths or tool I/O by construction — the
 * forbidden strings prove the assertion shape, and the failing paths are
 * unit-tested below with crafted cases.
 */
export const selfcheckRedaction: RedactionSuite = [
  {
    name: "permitted emissions carry no raw hook secrets",
    events: permittedEvents,
    forbidden: [
      "the user prompt was: delete everything",
      "/home/user/secret-project/deploy.sh",
      "assistant words nobody recorded",
      "sk-live-secret",
      "craft-session-that-never-existed",
    ],
  },
];

/**
 * An in-memory installer double around one shared, mutable config string: by
 * default a correct installer (idempotent install, byte-exact uninstall, a
 * resetConfig that restores the pristine baseline), with options to break
 * exactly one behaviour. One call gives one adapter/suite pair sharing one
 * config — sharing is the point: the registered installer conformance cases
 * run back-to-back against this shared state, which is how case isolation is
 * proven rather than assumed.
 */
export function installerDouble(options?: {
  secondInstallChanges?: boolean;
  uninstallRestores?: boolean;
}): { adapter: Adapter; suite: InstallerSuite } {
  const original = '{\n  "model": "sonnet"\n}\n';
  const config = { text: original };
  const marker = "\n# hearable\n";
  const adapter: Adapter = {
    id: "claude-code",
    capabilities: NOTHING_OBSERVED,
    map: () => [],
    install: async () => {
      if (!options?.secondInstallChanges && config.text.includes(marker)) {
        return { changed: false, summary: "already installed" };
      }
      config.text = `${config.text}${marker}`;
      return { changed: true, summary: "added the hearable marker" };
    },
    uninstall: async () => {
      if (options?.uninstallRestores !== false) {
        config.text = original;
      }
    },
    doctor: async () => [],
  };
  return {
    adapter,
    suite: {
      opts: testInstallOptions(),
      resetConfig: async () => {
        config.text = original;
      },
      readConfig: async () => config.text,
    },
  };
}
