# Golden attention trajectories

These files are byte-stable attention trajectories for the fixture families
this task covers: per-second prominence, foreground and gesture samples at
calm 0.6, folded from each fixture's engine replay through the pure
attention transition (`computeAttention`). They contain lifecycle,
lifecycle confidence, struggle, prominence, foreground and cumulative
gesture lists per lane, plus a summary (gesture counts, foreground holders,
struggle/prominence peaks).

To regenerate after a deliberate attention change, run:

```bash
REGENERATE_GOLDENS=1 pnpm --filter @hearable/core test -- test/attention/trajectories.test.ts
```

Review the resulting diff for every fixture. The review must record what
improved or regressed and must not alter fixture files. Delete the affected
golden before regeneration if a clean replacement is required; never
hand-edit a golden to make a test pass.

## Initial review (p4-t01)

New trajectories, no predecessor to diff against. Behaviour notes:

| Fixture | Attention behaviour |
| --- | --- |
| claude-code/stuck-single-session | struggle peaks 0.200, never crosses 0.6: no `attention` gesture. Prominence peaks 0.681 on the active/transition bump; lane 1 holds foreground throughout. |
| claude-code/stuck-fix-loop (deprecated) | struggle peaks 1.000: one `attention` gesture at the 0.6 crossing (81 s, struggle 0.883), then disarmed. Lane 1 holds foreground throughout. |
| claude-code/permission-heavy | one `question` gesture on entering `waiting`; prominence 1.0; lane 1 holds foreground throughout. |
| claude-code/asks-question | one `question` gesture on the prompt-reason turn end; prominence 1.0; lane 1 holds foreground throughout. |
| codex/stuck-single-session | struggle peaks 0.100 (edit evidence denied on Codex): no `attention`. Prominence peaks 0.425, below the 0.5 candidacy threshold: no foreground holder. |
| codex/permission-heavy | one `question` gesture on entering `waiting`; prominence 1.0; lane 1 holds foreground throughout. |
| concurrent claude-code + codex | three lanes in a 30 s window (claude stuck lane 0, codex stuck lane 1, claude permission-heavy lane 2): lane 2 takes foreground on entering `waiting` and holds it through the window. `question` fires once with the identical shape on the waiting lane. |
