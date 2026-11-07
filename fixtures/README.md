# Fixtures

Fixtures are the shared reality of this project. Heuristics are tuned against them, the
audio is auditioned with them, and the perception experiment replays them. Treat them as
data you would be embarrassed to lose and careful never to leak.

## Layout

```
fixtures/
  hooks/claude-code/       one redacted raw payload per hook event type, for adapter table tests
  classify/                tool/command → category rows used by the classifier
  sessions/
    <agent>/               one subdirectory per adapter (claude-code, codex, …)
      <name>.jsonl           recorded normalized events (schema v1)
      <name>.annotations.json  human ground truth for the session
```

## Recording a session

```
hearable record --name stuck-auth        # starts recording live sessions to fixtures-local/
# work with Claude Code as normal
hearable record --stop
```

Recordings land in a local, gitignored folder. To promote one to a fixture:

1. Read the JSONL. Confirm nothing in it identifies a private repository, a person, or a
   secret. Relative paths are allowed; if they are sensitive, re-record with
   `--redact=paths`.
2. Write the annotations file (below) **before** anyone tunes the engine on this session.
3. Copy both files into `fixtures/sessions/<agent>/` and describe the session in the PR.
   Promote the recording verbatim: never merge, rekey, retime or otherwise reshape
   events to fit expectations. If a session needs reshaping to be usable, promote the
   original recordings separately instead.

## Synthetic sessions

When live capture stalls, a session may be scripted through the real pipeline instead:
drive hand-shaped raw hook payloads with `POST /events` (header `x-hearable-agent`) into
a live `hearable record` daemon, exactly as the relay would deliver them. The recording
that daemon writes is the fixture; no other path (direct adapter-map or recorder calls)
is accepted. Every synthetic session is labelled `synthetic: true` in its annotations,
with the summary saying plainly what was invented. Stuck loops and question turns are
never scripted: those come from real use only, and the minimum stays explicitly unmet
until live capture is possible.

Never edit a fixture after it is committed. If it is wrong, add a new one and mark the old
one `deprecated: true` in its annotations.

## Annotations

```json
{
  "name": "stuck-auth",
  "recordedAt": "2026-09-10T14:02:00Z",
  "agent": "claude-code",
  "durationMs": 1812000,
  "summary": "Refactor of token refresh; agent loops on a failing integration test for ~9 minutes before asking for help.",
  "events": [
    { "atMs": 61000,  "kind": "waiting",       "reason": "permission" },
    { "atMs": 902000, "kind": "waiting",       "reason": "question" },
    { "atMs": 1790000,"kind": "turn_complete" }
  ],
  "struggleSegments": [
    { "fromMs": 340000, "toMs": 880000, "note": "npm test fails 6× on the same suite; edits alternate between two files" }
  ],
  "quietSegments": [
    { "fromMs": 120000, "toMs": 210000, "note": "long thinking, no tool calls" }
  ],
  "deprecated": false
}
```

`struggleSegments` are the human's judgement from reading the session, not the engine's.
Disagreement between the two is exactly what the golden tests are for.

## Committed session coverage

| Agent | Session | Provenance |
|---|---|---|
| Claude Code | clean-feature, asks-question, long-quiet, stuck-single-session | Recorded; see individual annotations |
| Claude Code | permission-heavy | Synthetic through the ingest/record pipeline |
| Claude Code | stuck-fix-loop | Deprecated; retained for regression history, excluded from calibration |
| Codex | clean-feature, permission-heavy | Synthetic through the ingest/record pipeline |
| Codex | stuck-single-session | Recorded; see annotations |

No OpenCode, Cursor, or ACP session coverage is currently claimed. The per-file annotations
are authoritative. A passing replay does not convert synthetic events into live evidence.
