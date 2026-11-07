# @hearable/claude-code — reference adapter

Turns Claude Code hook events into normalized events, installs the hook
configuration at user scope, and reports installed reality. Every later
adapter is measured against the choices made here.

## Delivery mechanism

Command hooks through the `hearable-hook` relay. The installer merges one
match-all entry per observed hook event into the `hooks` object of
`~/.claude/settings.json` (user scope); each entry runs
`<relay> --agent claude-code --url <daemon-url>` and carries an
`_hearable: hearable:claude-code` marker flag. Uninstall removes exactly
those entries.

**docs/ARCHITECTURE.md answer — does the installed Claude Code support HTTP hooks?**
Yes — documented, but not installed. The live hooks reference documents
`type: "http"` handlers (URL plus optional headers) on every hook event,
and the installed CLI (2.1.261) matches the reference. An HTTP install is
still not honest on the installed version, for two verified reasons:

1. **Allowlist gate.** The reference states that when `allowedHttpHookUrls`
   is defined at any settings level, an HTTP hook runs only if its URL
   matches the merged allowlist. The installer cannot know which managed or
   higher-precedence settings define that list, so an installed HTTP URL
   may silently never fire — a hook that looks installed but drops every
   event, with no diagnostic the adapter can read back.
2. **Measured path.** The Phase 1 exit criteria measure relay timing
   through the command-hook path. An HTTP install would bypass the relay
   the criteria measure, so the reference adapter keeps the measured path.

Decision (accepted for this adapter): install command hooks through the
relay; `doctor` checks the installed command-hook delivery (relay
executable, daemon URL reachable). Revisit only if a later task can verify
the allowlist for the installed version at install time.

## Verification record

Field names verified against https://code.claude.com/docs/en/hooks on
2026-09-06 with the installed Claude Code 2.1.261:

- Common fields on every payload: `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`. `permission_mode` on most events (not all — checked
  per example, never assumed).
- `SessionStart` carries `source` (`startup`, `resume`, `clear`, `compact`,
  `fork`), optional `model`, `agent_type`, `session_title`.
- `PreToolUse` carries `tool_name`, `tool_input`, `tool_use_id`.
  `PermissionRequest` carries `tool_name` and `tool_input` but no
  `tool_use_id`. `PostToolUse` adds `tool_response` and optional
  `duration_ms`. `PostToolUseFailure` adds `error`, optional
  `is_interrupt`, optional `duration_ms`.
- `Notification` carries `message`, optional `title`, and
  `notification_type` (not `type`, not `kind`): `permission_prompt`,
  `idle_prompt`, `auth_success`, `elicitation_dialog`,
  `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`,
  `agent_needs_input`, `agent_completed`, `quota_auto_resume_fired`,
  `quota_auto_resume_stale`, `quota_auto_resume_disabled`.
- `Stop` carries `stop_hook_active`, `last_assistant_message`,
  `background_tasks`, `session_crons`. `SubagentStop` adds `agent_id`,
  `agent_type`, `agent_transcript_path`. `SubagentStart` carries
  `agent_id` and `agent_type`.
- `StopFailure` carries `error` (the matcher values: `rate_limit`,
  `overloaded`, …), optional `error_details`, optional
  `last_assistant_message`.
- `PreCompact`/`PostCompact` carry `trigger` (`manual`, `auto`).
- `SessionEnd` carries `reason` (`clear`, `resume`, `logout`,
  `prompt_input_exit`, `other`).
- Subagent tool payloads carry `agent_id`/`agent_type` on the same
  `PreToolUse`/`PostToolUse` shapes as the main thread.

## Judgement calls (the pattern later adapters copy)

- **Durations.** `duration_ms` wins when present; otherwise now minus the
  matching `tool.start`: exact tool-use id when the payload carries one
  (an id that matches nothing yields no duration, never a wrong one),
  else FIFO per tool name via the kit helper. A computed zero is dropped
  (no signal); an explicit `duration_ms: 0` is kept.
- **De-dup window.** A `permission_prompt` Notification maps to
  `permission.request` unless the session has a pending tool start that
  began within the 2 s window before the notification, in which case it is
  the ~6 s-delayed echo of an already-mapped `PermissionRequest` and maps
  to nothing. The documented shape carries no tool name, so the window is
  keyed by session, not by tool; stale or other-session starts never
  suppress.
- **Question detection.** `PreToolUse` with `tool_name: AskUserQuestion`
  maps to `question.asked` (observed) plus a `tool.start` for the same
  call. Stop applies the last-tool rule from caller-threaded state, in
  order: the bounded `lastToolRecords` list (survives the tool's own
  `tool.end`/`tool.fail`), then live pending starts (the tool is still
  running). `Stop` maps to `turn.end` with reason `question` (inferred)
  when the final message ends in `?` or the last tool was a question tool;
  otherwise `completed` (observed). Callers must thread both: the pending
  starts list plus `lastToolRecords` via the kit's `nextLastToolRecords()`
  (same threading the daemon does for pending starts).
- **Error classes.** `PostToolUseFailure` error text maps coarsely
  (`test_failure`, `compile_error`, `not_found`, `timeout`, else `other`)
  from the `Exit code N` first line and stable phrases; the text itself is
  dropped, never recorded.
- **Meta kept.** `session.start` keeps `meta.source`; `compaction` keeps
  `meta.trigger`; `permission.request` from `PermissionRequest` keeps
  `meta.toolName`; unknown/notify payloads keep `meta.kind` plus
  `meta.hookEvent`. Nothing else from the payload survives — prompts,
  outputs, paths beyond the classifier target, and the final message are
  never recorded.
- **Subagents.** `SubagentStart`/`SubagentStop` set `sessionId` to
  `agent_id` and `parentSessionId` to `session_id`. Tool events carrying
  `agent_id` do the same. A subagent event without `agent_id` is preserved
  as `notification` with `meta.kind = "unknown"`.
- **Unknown events.** Anything the table does not know (including newer
  lifecycle events like `TeammateIdle`) maps to `notification` with
  `meta.kind = "unknown"` and `meta.hookEvent`. Never dropped.

## What the adapter does not do

- No classification logic: tool names and inputs go to `classify()` in
  `@hearable/core` unchanged.
- No HTTP-hook installation (see the accepted decision above): the
  command-hook path works either way.
- `doctor` observes only: version, install state, delivery mechanism. It
  downgrades nothing; capabilities are declared, not probed.
