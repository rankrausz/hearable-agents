# Codex adapter

Codex CLI sessions as normalized events (`docs/EVENTS.md` §Codex CLI
mapping). Findings here are never copied into `docs/EVENTS.md` — that
file's consolidation belongs to `p1-t10`.

## Verified against

- Reference: https://developers.openai.com/codex/hooks.md, read on
  2026-09-06.
- Live probe: `codex-cli 0.152.1` on macOS (darwin/arm64) on 2026-09-06,
  with a throwaway `CODEX_HOME`, `--dangerously-bypass-hook-trust`, and a
  logging command hook on every documented event. The probe captured real
  payloads for `SessionStart` (`source: startup`), `UserPromptSubmit`
  (with `turn_id` and a verbatim `prompt`), and `SessionEnd` (`reason:
  other`). No tool, permission, subagent, compaction, stop or interrupt
  payloads were captured: the probe run hit the account usage limit
  before the model could act, so every other mapping is built from the
  documented shapes above.
- Binary strings in the installed `codex` binary confirm the hook
  identity set (`pre_tool_use`, `permission_request`, `post_tool_use`,
  `pre_compact`, `post_compact`, `session_start`, `session_end`,
  `user_prompt_submit`, `subagent_start`, `subagent_stop`, `stop`,
  `interrupt`) and the `tool_response` input field on `PostToolUse`.

## Field names (as verified)

Common fields on every payload: `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `model`, `permission_mode`. Turn-scoped hooks add
`turn_id`. Tool hooks add `tool_name`, `tool_input` (`command` for `Bash`
and `apply_patch`) and `tool_use_id`; `PostToolUse` adds `tool_response`.
`SessionStart` adds `source` (`startup`, `resume`, `clear`, `compact`).
`PreCompact`/`PostCompact` add `trigger` (`manual`, `auto`).
`SubagentStart`/`SubagentStop` use the parent `session_id` with
`agent_id`/`agent_type`. `Stop`/`SubagentStop` add
`last_assistant_message` and `stop_hook_active`. `SessionEnd` adds
`reason` (always `other` at time of writing).

## Mapping

| Hook event | Normalized | Notes |
|---|---|---|
| `SessionStart` | `session.start` | `source` → `meta.source` |
| `UserPromptSubmit` | `turn.start` | `turn_id` → `meta.turnId`; prompt text never recorded |
| `PreToolUse` | `tool.start` | `Bash` classifies via the `shell` row; `apply_patch` via its own row |
| `PostToolUse` | `tool.end` / `tool.fail` | failure from `tool_response.exit_code`/`exitCode`/`status`/`isError` where present; otherwise success |
| `PermissionRequest` | `permission.request` | `inferred` confidence because Codex may resolve approval before showing a prompt |
| `Stop` | `turn.end` | reason heuristic on `last_assistant_message` (`?` → question, else completed), always `inferred` |
| `Interrupt` | `turn.end cancelled` | `observed`; needs Codex v0.150+ (`doctor` warns below that) |
| `SubagentStart` / `SubagentStop` | `subagent.start` / `subagent.end` | `sessionId = agent_id`, `parentSessionId = session_id` |
| `PreCompact` / `PostCompact` | `compaction` | `trigger` → `meta.trigger` |
| `SessionEnd` | ignored | advisory only; the lane is released by idle timeout (see below) |
| anything else | `notification` (`meta.kind = unknown`) | raw name preserved in `meta.hookEvent` |

## The session.end asymmetry

Codex has no `SessionEnd` worth the name: the hook exists, but the
documentation calls it advisory — it fires when a conversation is
archived, deleted, closed normally, or idle for 30 minutes, and its
output cannot steer the session. Mapping it to `session.end` would
release the lane on evidence that is not a session end, so the adapter
drops `SessionEnd` payloads and declares `sessionEvents: true` for start
only. `doctor` reports this asymmetry; the daemon releases Codex lanes
by idle timeout.

## Capabilities

`sessionEvents: true`, `turnStart/turnEnd: observed`,
`toolEvents/toolFailures/execEvents/permissionEvents/subagents/compaction/durations: true`,
`toolKinds: byName`. Three capabilities default to the honest value:

- `editEvents: false` — unverified. Docs say `apply_patch` hook events
  exist, but no live session on the build machine has produced them, so
  the adapter cannot claim edits are visible. If `apply_patch`
  PreToolUse/PostToolUse traffic is observed, the row can be verified
  and this flag revisited. Because core has no verified `codex` row for
  edit-class tools, unrecorded names classify as `other`, so the
  adapter cannot emit `edit` tool events today.
- `questionEvents: false` — Codex exposes no question event; questions
  are only inferred from `Stop` message heuristics.
- `Interrupt` below v0.150 never fires; `doctor` warns on old versions.

## Installer

Writes `hooks.json` at user scope (`configDir/hooks.json`, events at the
root). One matcher entry per mapped event, each pointing at
`hearable-hook --agent codex --url <daemonUrl>`. The first install saves
the exact pre-install bytes to a sidecar backup
(`hooks.json.hearable-backup`), or records that no file existed, so
uninstall restores the pristine config verbatim: compact formatting, key
order, indentation and trailing whitespace all survive the round trip.
Entries carry a `hearable` marker so an uninstall without a backup (a
foreign install) can still remove only what Hearable added. Install is
idempotent (`changed: false` on second install with the same URL).

## doctor

Checks, each with a plain-language fix: platform (Windows fails, hooks
are disabled there), Codex version (unparsable or unrunnable version is
a `warn`; below v0.150 warns that `Interrupt` never fires), the
`[features] hooks` flag in `config.toml` (off is a `fail`), whether the
Hearable hooks are installed in `hooks.json` (`warn` when absent), the
`/hooks` trust step (always a `warn`: untrusted hooks are skipped
silently), the `session.end` asymmetry (reported, not a failure), and
edit-event visibility (always a `warn` until `apply_patch` traffic is
observed).

## Second-agent evidence for p1-t10

- Codex `tool_response` should stay opaque to the mapping: only the
  exit-code/status/isError signal is read, never output text. If the
  schema review wants structured tool evidence, this is the field to
  scope.
- `stop_hook_active` describes hook plumbing (was this turn already
  continued by `Stop`), not turn outcome; it is deliberately not mapped
  to any lifecycle field.
- `permission_mode` rides every turn-scoped payload but has no
  normalized home; `meta` carries `turnId` only. Flag for the review
  whether permission mode deserves a declared field.
- Codex tool names (`Bash`, `apply_patch`) differ from the classify
  table keys (`shell`); the adapter re-keys them at the boundary. If
  more Codex tool names are observed live, they become fixture rows,
  not adapter branches.
