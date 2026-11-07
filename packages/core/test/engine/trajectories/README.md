# Golden trajectories

These files are byte-stable public engine trajectories for the active fixture sessions.
They contain lifecycle, mode, activity, progress, struggle and explainability reasons at
one-second recording-time samples, plus lifecycle or displayed-mode transitions.

To regenerate after a deliberate heuristic change, run:

```bash
REGENERATE_GOLDENS=1 pnpm --filter @hearable/core test -- test/engine/trajectories.test.ts
```

Review the resulting diff for every fixture. The review must record which annotated
struggle segments improved or regressed and must not alter fixture files. Delete the
affected golden before regeneration if a clean replacement is required; never hand-edit a
golden to make a test pass.

## Round 3 Review

The waiting-latency correction changes summary bookkeeping only: repeated prompt events
while already waiting are no longer counted as new waits. No lifecycle, mode, activity,
progress, struggle, or reason trajectory improved or regressed.

| Fixture | Improved | Regressed |
| --- | --- | --- |
| claude-code/asks-question | none | none |
| claude-code/clean-feature | none | none |
| claude-code/long-quiet | none | none |
| claude-code/permission-heavy | none | none |
| claude-code/stuck-single-session | none | none |
| claude-code/stuck-fix-loop (deprecated) | none | none |
| codex/clean-feature | none | none |
| codex/permission-heavy | none | none |
| codex/stuck-single-session | none | none |

## Round 4 Review

The waiting summaries now measure the synchronous causal-event transition and are `0 ms`
for each prompt that enters `waiting`. The full-trajectory capability assertions add no
trajectory behaviour; no fixture improved or regressed.

| Fixture | Improved | Regressed |
| --- | --- | --- |
| claude-code/asks-question | none | none |
| claude-code/clean-feature | none | none |
| claude-code/long-quiet | none | none |
| claude-code/permission-heavy | none | none |
| claude-code/stuck-single-session | none | none |
| claude-code/stuck-fix-loop (deprecated) | none | none |
| codex/clean-feature | none | none |
| codex/permission-heavy | none | none |
| codex/stuck-single-session | none | none |

## Permission completion correction — 2026-10-29

Owner-reported false permission waiting after a normal turn prompted one deliberate
lifecycle change: `turn.end(completed)` resolves permission waiting. Question waiting,
silence, tool activity and other end reasons retain their prior rules. Regenerated
with the existing script; no fixture recording or threshold changed.

| Fixture | Improved | Regressed |
| --- | --- | --- |
| claude-code/asks-question | unchanged; genuine question waiting preserved | none |
| claude-code/clean-feature | unchanged | none |
| claude-code/long-quiet | unchanged | none |
| claude-code/permission-heavy | completion at 195118 ms now appears before session.end at 195119 ms; lifecycle transitions 3→4, final remains idle | none; one completion reason added to final history |
| claude-code/stuck-single-session | unchanged | none |
| claude-code/stuck-fix-loop (deprecated) | unchanged | none |
| codex/clean-feature | unchanged | none |
| codex/permission-heavy | normal completion at 195030 ms replaces stale permission waiting; transitions 2→3, confidence inferred | none; final fields now include the completion event instead of the previous one-second sample |
| codex/stuck-single-session | unchanged | none |

Struggle peaks inside/outside annotated segments, waiting onset latencies and displayed
mode transition counts are unchanged on every fixture. The Codex final activity/mode/
progress fields differ because the newly recorded lifecycle transition includes the
actual final event rather than the preceding sample; their heuristics were not changed.
