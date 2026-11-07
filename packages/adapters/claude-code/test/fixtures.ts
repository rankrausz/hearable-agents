// packages/adapters/claude-code/test/fixtures.ts — the conformance fixture
// wiring for the reference adapter. What this is for: reading the redacted
// raw payloads in fixtures/hooks/claude-code/ and pairing each with its
// expected normalized events, with one explicit MapContext per case so the
// expectations stay deterministic. What it must not do: edit a fixture to
// make a test pass — a wrong expectation means the mapping is wrong, and a
// wrong payload means a new fixture file, never an edit.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FixtureCase,
  MapContext,
  RedactionCase,
  RelayTimingPayload,
  UnknownEventCase,
} from "@hearable/adapter-kit";
import type { NormalizedEvent } from "@hearable/core";
import { classify, SCHEMA_VERSION } from "@hearable/core";
import { errorClassFor } from "../src/error-class.js";
import { eventId } from "../src/ids.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "hooks",
  "claude-code",
);

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as unknown;
}

/**
 * The raw fixture file text, exactly as the agent produced it (a redacted
 * fixture). The relay-timing suite pipes this text to the relay's stdin, so
 * it reads the file as text rather than parsing it.
 */
export function rawPayloadText(name: string): string {
  return readFileSync(join(fixturesDir, `${name}.json`), "utf8");
}

const RECEIVED_AT = 1_700_000_000_000;
const SESSION = "sess-001";
const SUBAGENT = "agent-abc123";

/** One deterministic context per fixture file; cwd always /repo. */
export function ctxFor(overrides?: Partial<MapContext>): MapContext {
  return {
    receivedAt: RECEIVED_AT,
    cwd: "/repo",
    pendingToolStarts: [],
    ...overrides,
  };
}

function toolInfo(toolName: string, toolInput: unknown, cwd: string) {
  const classification = classify({ agent: "claude-code", toolName, toolInput, cwd });
  return {
    name: toolName,
    category: classification.category,
    ...(classification.execKind !== undefined ? { execKind: classification.execKind } : {}),
    fingerprint: classification.fingerprint,
    ...(classification.target !== undefined ? { target: classification.target } : {}),
  };
}

function event(partial: Record<string, unknown>): NormalizedEvent {
  return partial as unknown as NormalizedEvent;
}

function baseEvent(hookEventName: string, sequence: number, extra: Record<string, unknown>) {
  return {
    v: SCHEMA_VERSION,
    id: eventId(SESSION, hookEventName, sequence),
    ts: RECEIVED_AT,
    receivedAt: RECEIVED_AT,
    agent: "claude-code",
    sessionId: SESSION,
    ...extra,
  };
}

/** Every mapped fixture with its expected events. */
export function fixtureCases(): FixtureCase[] {
  const cases: FixtureCase[] = [];

  cases.push({
    name: "session-start",
    raw: load("session-start.json"),
    ctx: ctxFor(),
    expected: [
      event(baseEvent("SessionStart", 0, { kind: "session.start", meta: { source: "startup" } })),
    ],
  });

  cases.push({
    name: "session-end",
    raw: load("session-end.json"),
    ctx: ctxFor(),
    expected: [event(baseEvent("SessionEnd", 0, { kind: "session.end" }))],
  });

  cases.push({
    name: "user-prompt-submit",
    raw: load("user-prompt-submit.json"),
    ctx: ctxFor(),
    expected: [event(baseEvent("UserPromptSubmit", 0, { kind: "turn.start" }))],
  });

  cases.push({
    name: "pre-tool-use-read",
    raw: load("pre-tool-use-read.json"),
    ctx: ctxFor(),
    expected: [
      event(
        baseEvent("PreToolUse", 0, {
          kind: "tool.start",
          tool: toolInfo("Read", { file_path: "/repo/src/index.ts" }, "/repo"),
        }),
      ),
    ],
  });

  cases.push({
    name: "post-tool-use-read",
    raw: load("post-tool-use-read.json"),
    ctx: ctxFor({
      pendingToolStarts: [
        {
          sessionId: SESSION,
          toolName: "Read",
          toolUseId: "toolu-read-1",
          startedAt: RECEIVED_AT - 12,
        },
      ],
    }),
    expected: [
      event(
        baseEvent("PostToolUse", 0, {
          kind: "tool.end",
          tool: {
            ...toolInfo("Read", { file_path: "/repo/src/index.ts" }, "/repo"),
            durationMs: 12,
            outcome: {
              ok: true,
              outputChars: JSON.stringify({ filePath: "/repo/src/index.ts", success: true }).length,
            },
          },
        }),
      ),
    ],
  });

  cases.push({
    name: "post-tool-use-bash",
    raw: load("post-tool-use-bash.json"),
    ctx: ctxFor({
      pendingToolStarts: [
        { sessionId: SESSION, toolName: "Bash", toolUseId: "toolu-bash-2", startedAt: RECEIVED_AT },
      ],
    }),
    expected: [
      event(
        baseEvent("PostToolUse", 0, {
          kind: "tool.end",
          tool: {
            ...toolInfo("Bash", { command: "npm test" }, "/repo"),
            outcome: {
              ok: true,
              outputChars: JSON.stringify({
                interrupted: false,
                isImage: false,
                stderr: "",
                stdout: "ok",
              }).length,
            },
          },
        }),
      ),
    ],
  });

  cases.push({
    name: "post-tool-use-failure",
    raw: load("post-tool-use-failure.json"),
    ctx: ctxFor({
      pendingToolStarts: [
        { sessionId: SESSION, toolName: "Bash", toolUseId: "toolu-bash-1", startedAt: RECEIVED_AT },
      ],
    }),
    expected: [
      event(
        baseEvent("PostToolUseFailure", 0, {
          kind: "tool.fail",
          tool: {
            ...toolInfo("Bash", { command: "npm test", description: "Run test suite" }, "/repo"),
            durationMs: 4187,
            outcome: {
              ok: false,
              errorClass: errorClassFor("Exit code 1\nError: Cannot find module 'express'"),
            },
          },
        }),
      ),
    ],
  });

  cases.push({
    name: "permission-request",
    raw: load("permission-request.json"),
    ctx: ctxFor(),
    expected: [
      event(
        baseEvent("PermissionRequest", 0, {
          kind: "permission.request",
          lifecycle: { reason: "permission", confidence: "observed" },
          meta: { toolName: "Bash" },
        }),
      ),
    ],
  });

  cases.push({
    name: "notification-permission-prompt-fresh",
    raw: load("notification-permission-prompt.json"),
    ctx: ctxFor(),
    expected: [
      event(
        baseEvent("Notification", 0, {
          kind: "permission.request",
          lifecycle: { reason: "permission", confidence: "observed" },
        }),
      ),
    ],
  });

  cases.push({
    name: "notification-permission-prompt-duplicate",
    raw: load("notification-permission-prompt.json"),
    ctx: ctxFor({
      pendingToolStarts: [{ sessionId: SESSION, toolName: "Bash", startedAt: RECEIVED_AT - 500 }],
    }),
    expected: [],
  });

  cases.push({
    name: "notification-permission-prompt-stale",
    raw: load("notification-permission-prompt.json"),
    ctx: ctxFor({
      pendingToolStarts: [{ sessionId: SESSION, toolName: "Bash", startedAt: RECEIVED_AT - 5000 }],
    }),
    expected: [
      event(
        baseEvent("Notification", 0, {
          kind: "permission.request",
          lifecycle: { reason: "permission", confidence: "observed" },
        }),
      ),
    ],
  });

  cases.push({
    name: "notification-permission-prompt-other-session",
    raw: load("notification-permission-prompt.json"),
    ctx: ctxFor({
      pendingToolStarts: [{ sessionId: "other-session", toolName: "Bash", startedAt: RECEIVED_AT }],
    }),
    expected: [
      event(
        baseEvent("Notification", 0, {
          kind: "permission.request",
          lifecycle: { reason: "permission", confidence: "observed" },
        }),
      ),
    ],
  });

  cases.push({
    name: "notification-idle-prompt",
    raw: load("notification-idle-prompt.json"),
    ctx: ctxFor(),
    expected: [
      event(
        baseEvent("Notification", 0, {
          kind: "notification",
          meta: { kind: "idle_prompt", hookEvent: "Notification" },
        }),
      ),
    ],
  });

  cases.push({
    name: "notification-other",
    raw: load("notification-other.json"),
    ctx: ctxFor(),
    expected: [
      event(
        baseEvent("Notification", 0, {
          kind: "notification",
          meta: { kind: "agent_completed", hookEvent: "Notification" },
        }),
      ),
    ],
  });

  cases.push({
    name: "pre-tool-use-question",
    raw: load("pre-tool-use-question.json"),
    ctx: ctxFor(),
    expected: [
      event(
        baseEvent("PreToolUse", 0, {
          kind: "question.asked",
          lifecycle: { reason: "question", confidence: "observed" },
        }),
      ),
      event(
        baseEvent("PreToolUse", 1, {
          kind: "tool.start",
          tool: toolInfo(
            "AskUserQuestion",
            {
              questions: [
                {
                  header: "Framework",
                  multiSelect: false,
                  options: [{ label: "React" }],
                  question: "Which framework?",
                },
              ],
            },
            "/repo",
          ),
        }),
      ),
    ],
  });

  cases.push({
    name: "stop-completed",
    raw: load("stop-completed.json"),
    ctx: ctxFor(),
    expected: [
      event(
        baseEvent("Stop", 0, {
          kind: "turn.end",
          lifecycle: { reason: "completed", confidence: "observed" },
        }),
      ),
    ],
  });

  cases.push({
    name: "stop-question",
    raw: load("stop-question.json"),
    ctx: ctxFor(),
    expected: [
      event(
        baseEvent("Stop", 0, {
          kind: "turn.end",
          lifecycle: { reason: "question", confidence: "inferred" },
        }),
      ),
    ],
  });

  cases.push({
    name: "stop-failure",
    raw: load("stop-failure.json"),
    ctx: ctxFor(),
    expected: [
      event(
        baseEvent("StopFailure", 0, {
          kind: "turn.end",
          lifecycle: { reason: "error", confidence: "observed" },
        }),
      ),
    ],
  });

  cases.push({
    name: "subagent-start",
    raw: load("subagent-start.json"),
    ctx: ctxFor(),
    expected: [
      event({
        v: SCHEMA_VERSION,
        id: eventId(SUBAGENT, "SubagentStart", 0),
        ts: RECEIVED_AT,
        receivedAt: RECEIVED_AT,
        agent: "claude-code",
        sessionId: SUBAGENT,
        parentSessionId: SESSION,
        kind: "subagent.start",
      }),
    ],
  });

  cases.push({
    name: "subagent-stop",
    raw: load("subagent-stop.json"),
    ctx: ctxFor(),
    expected: [
      event({
        v: SCHEMA_VERSION,
        id: eventId(SUBAGENT, "SubagentStop", 0),
        ts: RECEIVED_AT,
        receivedAt: RECEIVED_AT,
        agent: "claude-code",
        sessionId: SUBAGENT,
        parentSessionId: SESSION,
        kind: "subagent.end",
      }),
    ],
  });

  cases.push({
    name: "pre-compact",
    raw: load("pre-compact.json"),
    ctx: ctxFor(),
    expected: [
      event(baseEvent("PreCompact", 0, { kind: "compaction", meta: { trigger: "manual" } })),
    ],
  });

  cases.push({
    name: "post-compact",
    raw: load("post-compact.json"),
    ctx: ctxFor(),
    expected: [
      event(baseEvent("PostCompact", 0, { kind: "compaction", meta: { trigger: "manual" } })),
    ],
  });

  cases.push({
    name: "pre-tool-use-subagent",
    raw: load("pre-tool-use-subagent.json"),
    ctx: ctxFor(),
    expected: [
      event({
        v: SCHEMA_VERSION,
        id: eventId(SUBAGENT, "PreToolUse", 0),
        ts: RECEIVED_AT,
        receivedAt: RECEIVED_AT,
        agent: "claude-code",
        sessionId: SUBAGENT,
        parentSessionId: SESSION,
        kind: "tool.start",
        tool: toolInfo("Read", { file_path: "/repo/src/index.ts" }, "/repo"),
      }),
    ],
  });

  return cases;
}

/** Payloads the mapping table does not know; each must be preserved. */
export function unknownEventCases(): UnknownEventCase[] {
  return [{ name: "teammate-idle", raw: load("unknown-teammate-idle.json"), ctx: ctxFor() }];
}

/**
 * The relay-timing inputs: two real hook payloads the agent sends —
 * a submission and a tool call — through the real hearable-hook binary.
 * The text is the fixture file bytes, exactly what the relay would read.
 */
export function relayTimingCases(): RelayTimingPayload[] {
  return [
    {
      name: "user-prompt-submit",
      payload: rawPayloadText("user-prompt-submit"),
      agentId: "claude-code",
    },
    {
      name: "pre-tool-use-read",
      payload: rawPayloadText("pre-tool-use-read"),
      agentId: "claude-code",
    },
  ];
}

/**
 * The redaction inputs: every mapped fixture event with the raw-payload
 * secrets they must not leak named explicitly — the prompt text, absolute
 * transcript paths, tool I/O, the final assistant message, and
 * non-allowlisted meta values. Each forbidden string is read from the
 * fixture payload it came from (or a fixture-derived assembly of it) so
 * the assertion names the exact secret family EVENTS.md §Redaction
 * forbids. Two documented values stay out of the forbidden list, and the
 * exclusion is itself the contract: the fixture session id ("sess-001")
 * is re-keyed by the recorder and would trivially collide with real
 * recorded content, and `meta.toolName` ("Bash") is the coarse token
 * EVENTS.md allows on permission.request — so the check proves secrecy
 * of payload text, not of re-keyed identity or the allowlisted token.
 */
export function redactionCases(): RedactionCase[] {
  const rawOf = (name: string): Record<string, unknown> =>
    load(`${name}.json`) as Record<string, unknown>;
  const toolInputText = (name: string): string => JSON.stringify(rawOf(name).tool_input ?? {});
  const stringOf = (name: string, key: string): string => {
    const value = rawOf(name)[key];
    return typeof value === "string" ? value : "";
  };
  const allEvents = fixtureCases().flatMap((fixture) => [...fixture.expected]);
  const prompt = stringOf("user-prompt-submit", "prompt");
  const transcriptPath = stringOf("user-prompt-submit", "transcript_path");
  const permissionInput = toolInputText("permission-request");
  const failureError = stringOf("post-tool-use-failure", "error");
  const failureInput = toolInputText("post-tool-use-failure");
  const questionInput = toolInputText("pre-tool-use-question");
  const completedMessage = stringOf("stop-completed", "last_assistant_message");
  const questionMessage = stringOf("stop-question", "last_assistant_message");
  const failureDetails = stringOf("stop-failure", "error_details");
  // `meta.toolName` ("Bash") is the deliberate exception EVENTS.md allows
  // on permission.request — a coarse tool token shared with the allowlisted
  // vocabulary, not tool I/O — so it is not a forbidden secret here.
  // Forbidden non-allowlisted meta values, by contrast, are concrete
  // secrets: the recorded lines must drop these keys entirely (the
  // projection's closed meta allowlist keeps only kind/hookEvent/source
  // plus hashed turnId), so they are asserted absent verbatim.
  const hostileMetaValues = ["agent_completed_probe_secret", "ElicitationDialogProbe"];
  const hostileMetaKeys = ["notification_type", "agent_type_probe"];
  // A crafted turn.end carrying a secret lifecycle.message, mirroring the
  // Codex probe: the mapping never emits `message` (the final assistant
  // text is dropped at the boundary), so this event proves the recorded
  // representation removes it even when a normalized event carries one.
  const lifecycleMessage = "claude assistant message that must never be recorded";
  return [
    {
      name: "prompts, paths and permission tool input",
      events: allEvents,
      forbidden: [prompt, transcriptPath, permissionInput].filter((text) => text !== ""),
    },
    {
      name: "tool I/O, errors and final messages",
      events: allEvents,
      forbidden: [
        failureError,
        failureInput,
        questionInput,
        completedMessage,
        questionMessage,
        failureDetails,
      ].filter((text) => text !== ""),
    },
    {
      name: "non-allowlisted meta values and keys",
      events: [
        ...allEvents,
        event(
          baseEvent("Notification", 7, {
            kind: "notification",
            meta: {
              kind: hostileMetaValues[0],
              hookEvent: hostileMetaValues[1],
              notification_type: hostileMetaValues[0],
              agent_type_probe: hostileMetaValues[1],
            },
          }),
        ),
      ],
      forbidden: [...hostileMetaValues, ...hostileMetaKeys],
    },
    {
      name: "lifecycle.message never reaches the recorded lines",
      events: [
        ...allEvents,
        event(
          baseEvent("Stop", 7, {
            kind: "turn.end",
            lifecycle: {
              reason: "completed",
              confidence: "observed",
              message: lifecycleMessage,
            },
          }),
        ),
      ],
      forbidden: [lifecycleMessage],
    },
  ];
}
