# Normalized events

All agent activity enters the system as `NormalizedEvent`s. Adapters produce them; the
engine, recorder and UI consume them. The schema is versioned and defined in
`packages/core/src/events/schema.ts` with zod. This document is the human-readable contract.

Schema version: **1**. Breaking changes bump the version; the recorder writes the version in
the file header; the replayer refuses files it can't read rather than guessing.

## Shape

```ts
type NormalizedEvent = {
  v: 1;
  id: string;                 // ulid, assigned by adapter
  ts: number;                 // event time, ms since epoch (see ARCHITECTURE.md §Time)
  receivedAt: number;         // daemon receipt time
  agent: AgentId;             // "claude-code" | "codex" | "opencode" | "cursor" | "acp" | "emit" | "replay" | "sandbox"
  via?: string;               // for acp: the wrapped agent's name from ACP initialize (e.g. "gemini-cli"); for cursor: "app" | "cli"
  sessionId: string;          // stable per agent session
  parentSessionId?: string;   // set for subagents; engine folds into parent lane
  kind: EventKind;
  tool?: ToolInfo;            // for tool.* kinds
  lifecycle?: LifecycleHint;  // for turn.end, permission.request, question.asked
  meta?: Record<string, string | number | boolean>;  // small, redacted, schema-checked
};

type EventKind =
  | "session.start" | "session.end"
  | "turn.start"    | "turn.end"
  | "tool.start"    | "tool.end" | "tool.fail"
  | "permission.request"
  | "question.asked"
  | "notification"
  | "subagent.start" | "subagent.end"
  | "compaction"
  | "agent.report";  // reserved for self-report; not produced in MVP

type ToolInfo = {
  name: string;               // agent's tool name as-is (Edit, Bash, Read, mcp__x__y)
  category: "read" | "search" | "edit" | "exec" | "web" | "other";
  execKind?: "test" | "build" | "lint" | "git" | "install" | "run" | "other";
  fingerprint: string;        // stable hash for repetition detection (see below)
  target?: string;            // redacted path or command head; optional
  durationMs?: number;        // tool.end / tool.fail only
  outcome?: ToolOutcome;      // tool.end / tool.fail only
};

type ToolOutcome = {
  ok: boolean;
  exitCode?: number;
  errorClass?: string;        // coarse closed vocabulary: "test_failure" | "compile_error" | "not_found" | "timeout" | "other". Claude populates it from error text; Codex from the exit signal only (127 → "not_found", any other failure → "other"). No per-subfield capability: the exit evidence credibly populates it.
  testSummary?: { passed?: number; failed?: number; skipped?: number };  // Tier 2, optional
  outputChars?: number;
};

type LifecycleHint = {
  reason: "completed" | "question" | "permission" | "idle_prompt" | "error" | "cancelled" | "unknown";
  confidence: "observed" | "inferred";   // observed = the agent told us; inferred = adapter heuristics
  message?: string;           // first ~200 chars of the assistant's final message, redacted, optional
};
```

`meta` is deliberately flat and small. If you need structure, propose a schema change.

## Capabilities

Every adapter declares what its source can tell us. Core reads these to decide which
heuristics to run and how to label confidence. Unknown keys are rejected; every key is
required so nobody forgets to think about it.

```ts
type AdapterCapabilities = {
  sessionEvents: boolean;      // session.start / session.end observed
  turnStart: "observed" | "inferred" | "none";
  turnEnd: "observed" | "inferred" | "none";
  toolEvents: boolean;         // tool.start/end/fail observed at all
  toolFailures: boolean;       // failures distinguishable from successes
  editEvents: boolean;         // file edits visible as tool events
  execEvents: boolean;         // shell/command executions visible
  permissionEvents: boolean;   // permission prompts observed
  questionEvents: boolean;     // explicit questions to the user observed
  subagents: boolean;
  compaction: boolean;
  toolKinds: "typed" | "byName" | "none";  // typed = the source gives a category (ACP kind); byName = we classify tool names
  durations: boolean;          // tool.end carries a real duration
};
```

Expected values at time of writing (adapters verify with `doctor` and may downgrade at runtime). This table is design intent for all six adapters; only Claude Code and Codex are implemented in this build — see `docs/ARCHITECTURE.md` §Adapter coverage and release matrix for what is observed versus missing.

| | claude-code | codex | opencode | cursor | acp | emit |
|---|---|---|---|---|---|---|
| sessionEvents | ✓ | ✓ (start only; `SessionEnd` is advisory and dropped) | ✓ | ✓ | ✓ | caller |
| turnStart | observed | observed | inferred | observed | observed | caller |
| turnEnd | observed | observed (Stop reasons always `inferred`) | observed (idle) | observed | observed | caller |
| toolEvents | ✓ | ✓ (documented shape; live tool traffic unverified — see `packages/adapters/codex/README.md`) | ✓ | ✓ | ✓ | caller |
| toolFailures | ✓ | ✓ (documented shape; live traffic unverified) | ✓ (session.error / output) | ✓ | ✓ (status: failed) | caller |
| editEvents | ✓ | ✗ (unverified; `apply_patch` traffic never observed live) | ✓ | ✓ | ✓ | caller |
| execEvents | ✓ | ✓ | ✓ | ✓ | ✓ | caller |
| permissionEvents | ✓ | ✓ | ✓ | ✗ | ✓ | caller |
| questionEvents | ✓ | ✗ | ✗ | ✗ | ✗ | caller |
| subagents | ✓ | ✓ | ✗ | ✓ | ✗ | caller |
| compaction | ✓ | ✓ | ✓ | ✓ | ✗ | caller |
| toolKinds | byName | byName | byName | byName | typed | caller |
| durations | ✓ | ✓ | ✓ | ✓ | ✓ | caller |

Rules:

- If a capability is `false`/`none`, the adapter never emits that kind. Emitting an event
  your capabilities deny is a conformance failure.
- Where the adapter infers (e.g. OpenCode `turn.start` from the first tool event after idle),
  the emitted event carries `lifecycle.confidence = "inferred"`.
- `doctor` may downgrade capabilities for the installed version (e.g. Codex without edit
  events) and the daemon attaches the downgraded set to the session.
- Keep fields grounded in observable events. Declare systematic gaps as capabilities and
  use `meta` for source-specific values such as Codex's `turn_id`.

## Kinds and when they occur

| Kind | Meaning | Required fields |
|---|---|---|
| `session.start` | An agent session began or resumed | — |
| `session.end` | The session ended; the lane is released | — |
| `turn.start` | The user submitted a prompt; the agent is now active | — |
| `turn.end` | The agent stopped producing output for this turn | `lifecycle.reason` |
| `tool.start` | A tool call is about to run | `tool` |
| `tool.end` | A tool call finished successfully | `tool` with `outcome.ok = true` |
| `tool.fail` | A tool call failed | `tool` with `outcome.ok = false` |
| `permission.request` | The agent is blocked on a permission prompt | `lifecycle.reason = "permission"` |
| `question.asked` | The agent explicitly asked the user something | `lifecycle.reason = "question"` |
| `notification` | Anything else the agent surfaced; includes unknown hook events | `meta.kind` |
| `subagent.start` / `subagent.end` | A subagent started or finished | `parentSessionId` |
| `compaction` | Context compaction happened; expect a lull | — |

## Classification

`packages/core/classify/` maps tool names and inputs to categories. The table is
fixture-backed (`fixtures/classify/*.json`) so new observed tools can be added by adding a
row, not by editing logic.

Category rules. Tool names differ per agent (Claude Code `Edit`, Cursor `Write`, OpenCode
`edit`, Codex shell-only); the table is keyed by `(agent, toolName)` with a fallback on
lowercased name. ACP provides a typed `kind` and bypasses name classification entirely:
`read→read`, `search→search`, `edit|delete|move→edit`, `execute→exec` (execKind from the
command if present), `fetch→web`, `think|other→other`.

Claude Code names, extend as observed:

- `read`: Read, NotebookRead, `cat`/`head`/`less` via shell
- `search`: Grep, Glob, `rg`, `find`, `ls`
- `edit`: Edit, MultiEdit, Write, NotebookEdit, `sed -i`, redirects that write files
- `exec`: Bash and any shell tool. `execKind` from the command head:
  - `test`: `pytest`, `jest`, `vitest`, `go test`, `cargo test`, `npm test`, `pnpm test`,
    `mvn test`, `rspec`, `phpunit`, `dotnet test`, `make test`
  - `build`: `tsc`, `go build`, `cargo build`, `npm run build`, `make`, `gradle build`, `docker build`
  - `lint`: `eslint`, `biome`, `ruff`, `clippy`, `golangci-lint`, `prettier --check`
  - `git`: `git *`, `gh *`
  - `install`: `npm i`, `pnpm add`, `pip install`, `cargo add`, `brew`, `apt`
  - `run`: `node`, `python`, `go run`, `cargo run`, `npm run <not build/test>`
  - `other`: everything else
- `web`: WebFetch, WebSearch, `curl`, `wget`
- `other`: TodoWrite, Task, MCP tools (`mcp__*`) unless a fixture row says otherwise

## Fingerprints

Repetition detection needs to know "same thing again" without storing the thing.

- Edit-class tools: `sha256(category + ":" + normalizedPath)`, path relative to `cwd`
- Exec-class tools: `sha256(execKind + ":" + normalizedCommand)` where normalization
  strips whitespace runs, absolute path prefixes equal to `cwd`, and common volatile
  flags (`--no-color`, timestamps)
- Read/search: `sha256(category + ":" + normalizedPath or pattern)`

Fingerprints are 16 hex chars (truncated) — enough to avoid collisions in a session.

## Redaction

Recordings are meant to be committed as fixtures and shared. Default recording keeps:

- All kinds, timestamps, session ids (re-keyed to `s1`, `s2`, …), categories, fingerprints
- `tool.target` as a **relative path** for edit/read/search, and the **command head only**
  (first token plus execKind) for exec
- `outcome` numbers and coarse `errorClass`
- `lifecycle.reason`; `lifecycle.message` **dropped**

Default recording drops: tool inputs, tool outputs, prompts, assistant messages, absolute
paths, environment, anything in `meta` not in the allowlist.

`hearable record --redact=paths` additionally hashes relative paths.
`hearable record --raw` writes the original hook payloads to `<name>.raw.jsonl`, which is
gitignored and never leaves the machine.

Before committing a fixture, a human reads it. Fixtures include an `annotations.json`
(see `fixtures/README.md`).

## Claude Code mapping

Verify field names against the current hooks reference before implementing:
https://code.claude.com/docs/en/hooks (verified 2026-09-06, Claude Code
2.1.261 — see `packages/adapters/claude-code/README.md`). Common fields on
every payload include `session_id`, `transcript_path`, `cwd` and
`hook_event_name` (`permission_mode` on most but not all events); tool
events add `tool_name` and `tool_input` (`tool_use_id` on `PreToolUse` and
`PostToolUse`, not on `PermissionRequest`); `PostToolUse` adds `tool_response`
and optional `duration_ms`, `PostToolUseFailure` adds `error` (plus optional
`is_interrupt` and `duration_ms`); `Notification` carries `message`, optional
`title` and `notification_type`; `Stop` includes `stop_hook_active` and the
final assistant message as `last_assistant_message`; events inside a
subagent carry `agent_id` / `agent_type`.

| Hook event | Normalized | Notes |
|---|---|---|
| `SessionStart` | `session.start` | matcher source (`startup`, `resume`, `clear`, `compact`, `fork`) → `meta.source` (the recorder keeps all five) |
| `SessionEnd` | `session.end` | matcher reason (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`) is not recorded |
| `UserPromptSubmit` | `turn.start` | prompt text never recorded |
| `PreToolUse` | `tool.start` | classify from `tool_name` + `tool_input` |
| `PostToolUse` | `tool.end` | `duration_ms` when the payload carries it, else now − matching `tool.start`: exact tool-use id when the payload carries one (an id that matches nothing yields no duration, never a wrong one), else FIFO per tool name; a computed zero duration is dropped, an explicit `duration_ms` is kept |
| `PostToolUseFailure` | `tool.fail` | duration as for `PostToolUse`; `errorClass` from coarse patterns on the error text (the `Exit code N` first line, timeout / not-found / test / compile phrases, else `other`); text itself dropped |
| `PermissionRequest` | `permission.request` | lifecycle `permission` |
| `Notification` (`permission_prompt`) | `permission.request` | de-duplicate: maps to nothing when the session has a pending tool start that began within 2 s before the notification (the ~6 s-delayed echo of an already-mapped `PermissionRequest`); the payload carries no tool name so the window is keyed by session, and stale or other-session starts never suppress |
| `Notification` (`idle_prompt`) | `notification` with `meta.kind = "idle_prompt"` | confirms `waiting` / idle |
| `Notification` (other) | `notification` with `meta.kind = <notification_type>`, `meta.hookEvent = "Notification"` | |
| `PreToolUse` with a question tool (e.g. `AskUserQuestion`; verify name) | `question.asked` plus a `tool.start` for the same call | lifecycle `question`, confidence `observed`; the `tool.start` threads the pending question-tool fact so a later `Stop` observes it |
| `Stop` | `turn.end` | `reason = "question"` (confidence `inferred`) if the final message ends in `?` or the last tool was a question tool; otherwise `"completed"` (confidence `observed`). Caller contract: the daemon threads one MapContext per session carrying `pendingToolStarts` plus a bounded `lastToolRecords` list (most-recent tool name per session from `tool.start`/`tool.end`/`tool.fail` in order, cap 32, maintained by the kit's pure `nextLastToolRecords` fold in `packages/adapter-kit/src/last-tool.ts`). Stop reads the record first (survives the tool's own end), then live pending starts (tool still running); without either, `?` alone decides. |
| `StopFailure` | `turn.end` | `reason = "error"`, confidence `observed` |
| `SubagentStart` / `SubagentStop` | `subagent.start` / `subagent.end` | `parentSessionId = session_id`, `sessionId = agent_id`; a subagent event without `agent_id` is preserved as `notification` with `meta.kind = "unknown"` |
| `PreCompact` / `PostCompact` | `compaction` | `trigger` (`manual`, `auto`) → `meta.trigger` |
| anything else | `notification` with `meta.kind = "unknown"`, `meta.hookEvent = <name>` | never dropped |

Subagent tool events (payloads carrying `agent_id`) are emitted with `sessionId` set to
the subagent id and `parentSessionId` set to the parent. The engine attributes their
activity to the parent's lane.


## Codex CLI mapping

Codex hooks reuse Claude Code's event names and payload shape (`session_id`,
`hook_event_name`, `cwd`, `tool_name`, `tool_input`, plus Codex-specific `turn_id` and
`permission_mode`). Configured in `~/.codex/hooks.json` (events at the root). At time of
writing: behind a feature flag, requires a trust step in `/hooks`, disabled on Windows, and
file-edit tools may not fire hook events — only shell and MCP. Verify against
https://developers.openai.com/codex/hooks.

| Hook event | Normalized | Notes |
|---|---|---|
| `SessionStart` | `session.start` | `source` → `meta.source`; opening/resuming a chat is presence evidence, not a work signal |
| `UserPromptSubmit` | `turn.start` | `turn_id` → `meta.turnId`; lifecycle event ids include a stable truncated hash of `turn_id` so later turns remain visible without exposing the source id |
| `PreToolUse` / `PostToolUse` | `tool.start` / `tool.end` or `tool.fail` | failure detected from tool result exit code where present; `tool.fail` carries `errorClass`: exit 127 → `not_found`, any other failure → `other` (output text never read) |
| `PermissionRequest` | `permission.request` | carries the classified `tool` from `tool_name`/`tool_input`; there is no approval-reply hook, so core ends the wait when that tool's fingerprint runs |
| `Stop` | `turn.end` | `reason` from `last_assistant_message` heuristics; `confidence: inferred` for question vs completed; a trailing question enters inferred waiting even though Codex has no explicit question event |
| `Interrupt` | `turn.end` with `reason: cancelled` | v0.150+ |
| `SubagentStart` / `SubagentStop` | `subagent.start` / `subagent.end` | |
| `PreCompact` / `PostCompact` | `compaction` | |
| anything else | `notification` (`meta.kind = unknown`) | |

`session.end`: Codex has no `SessionEnd` at time of writing; the lane is released by idle
timeout (`sessionEvents` stays `true` for start; adapter documents the asymmetry).

## OpenCode mapping

In-process plugin (`~/.config/opencode/plugins/hearable.js`) subscribing to bus events and
posting to the daemon. Handlers are fire-and-forget; the plugin must never throw. Verify
against https://opencode.ai/docs/plugins/.

| Plugin event | Normalized | Notes |
|---|---|---|
| `session.created` | `session.start` | |
| `session.deleted` | `session.end` | |
| first `tool.execute.before` or `message.updated` (user role) after idle | `turn.start` | `confidence: inferred` |
| `tool.execute.before` | `tool.start` | `tool`, `sessionID`, `callID` |
| `tool.execute.after` | `tool.end` / `tool.fail` | failure from `output`/`metadata` where the tool reports it |
| `file.edited` | reinforces `edit` classification for the pending tool; no separate event | |
| `permission.asked` | `permission.request` | |
| `permission.replied` | `notification` (`meta.kind = permission_replied`) | engine returns to active |
| `session.idle` | `turn.end` (`completed`, `observed`) | |
| `session.error` | `turn.end` (`error`) | |
| `session.compacted` | `compaction` | |

## Cursor mapping

`~/.cursor/hooks.json`, flat shape with `"version": 1`; the app and the CLI read the same
file. Payloads carry `conversation_id`, `generation_id`, `hook_event_name`,
`workspace_roots`. Cursor can also load Claude Code hooks; we do not rely on that. Verify
against https://cursor.com/docs/hooks.

| Hook event | Normalized | Notes |
|---|---|---|
| `sessionStart` / `sessionEnd` | `session.start` / `session.end` | `sessionId = conversation_id` |
| `beforeSubmitPrompt` | `turn.start` | prompt text never recorded |
| `preToolUse` / `postToolUse` | `tool.start` / `tool.end` | tool name classification |
| `postToolUseFailure` | `tool.fail` | |
| `beforeShellExecution` / `afterShellExecution` | `tool.start` / `tool.end` (exec) | `command` → execKind + fingerprint; de-duplicate against `preToolUse` if both fire for the same `generation_id` |
| `afterFileEdit` | `tool.end` (edit) with a synthetic `tool.start` | `file_path` → fingerprint; old/new strings dropped |
| `beforeMCPExecution` / `afterMCPExecution` | `tool.start` / `tool.end` (other) | |
| `subagentStart` / `subagentStop` | `subagent.start` / `subagent.end` | |
| `preCompact` | `compaction` | |
| `stop` | `turn.end` | `reason: completed`, `confidence: inferred`; Cursor exposes no permission or question event, so `waiting` on Cursor comes from idle inference only |
| Tab events (`beforeTabFileRead`, `afterTabFileEdit`) | ignored | not agent activity |

## ACP mapping

The proxy observes JSON-RPC 2.0 both directions. Verify against
https://agentclientprotocol.com. `sessionId` from `session/new` response; `via` from the
agent's `initialize` response (`agentInfo.name`).

| ACP message | Normalized | Notes |
|---|---|---|
| `initialize` response | — | records `via` |
| `session/new` response, `session/load` | `session.start` | |
| `session/prompt` request (client→agent) | `turn.start` | |
| `session/prompt` response | `turn.end` | `stopReason`: `end_turn` → completed; `cancelled` → cancelled; `refusal`/`max_tokens` → error |
| `session/update` `tool_call` | `tool.start` | `kind` → category (typed); `title` → redacted target head |
| `session/update` `tool_call_update` status `completed` / `failed` | `tool.end` / `tool.fail` | |
| `session/request_permission` request (agent→client) | `permission.request` | response → `notification` (`permission_replied`) |
| `session/cancel` | `notification` (`meta.kind = cancel`) | |
| `session/update` `agent_message_chunk`, `plan`, thoughts | activity heartbeat only (`meta.kind = streaming`), rate-limited to one per 5 s | keeps `quiet` from triggering while the model is visibly streaming |
| agent process exit | `session.end` | |

## emit

`hearable emit <kind> --session <id> [--tool <name>] [--category ...] [--reason ...]`
constructs a `NormalizedEvent` directly. Documented for scripts and CI. Capabilities are
whatever the caller sends; the engine treats all lifecycle as `observed`.

## Wire format

`POST /events` accepts either a raw agent payload (header `x-hearable-agent: <adapter id>`,
mapped server-side by that adapter) or a `NormalizedEvent[]` (from the OpenCode plugin,
the ACP proxy, `emit`, the replayer and the sandbox, header `x-hearable-normalized: 1`). Response is always `204`. The daemon never returns an
error body to a hook; problems go to the quarantine file and `/health`. The `hearable-hook`
relay (docs/ARCHITECTURE.md §The hook relay) is the reference client for the raw-payload
form: it takes the adapter id from its `--agent` flag and sends it as the header.

Recording file format: first line `{"hearable":"session","v":1,"recordedAt":...,"agent":"claude-code","annotations":"<file>.annotations.json"}`, then one event per line.

## Local window focus transport

The optional `x-hearable-focus` HTTP header is base64url JSON, separate from both raw
payloads and normalized events. The relay sends `pid` (its parent), optional bounded
`termProgram`, `termSessionId`, `itermSessionId` strings and a `remote` SSH flag. Unknown
fields, invalid PIDs and malformed headers are ignored without rejecting the event.
This is local shell bookkeeping, not an observed agent event or a core capability.
Raw and normalized producers may attach it; replay supplies none.

On macOS, the daemon asynchronously snapshots process ancestry using PID, parent PID,
tty, start time and executable name/path. It never reads argv or process environments.
Focus information is held only in the session's private memory record, disappears when
the session ends, and is excluded from health/WS session views, normalized recordings
and the raw recording payload. The hook still forwards the original bytes with the
same deadline, exit-zero and stdout contracts and no additional import or subprocess.

`GET /session-focus?agent=…&sessionId=…` is a no-store native-shell lookup: loopback
peers only, no browser Origin accepted, identity must match a tracked session. It
returns 404 without an origin, 409 if the session changes during lookup, or the
validated hint plus captured process ancestry. It never performs focus itself.
The Mac shell revalidates OS identity and uses fixed native actions (ADR 0029).
