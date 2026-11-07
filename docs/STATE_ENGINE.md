# State engine and attention model

The engine turns a stream of `NormalizedEvent`s into a small, stable, explainable
representation per lane. Everything here lives in `packages/core/src/engine` and
`packages/core/src/attention` and is pure.

Numbers in this document are **starting values**, chosen to be plausible. They are
constants in `engine/tuning.ts`, and every change to them must be justified against the
annotated fixtures (`fixtures/sessions/*.annotations.json`) with before/after numbers in the
PR. Nobody, human or agent, tunes by feel alone.

## Outputs

```ts
type LaneState = {
  laneId: number;
  sessionId: string;
  agent: AgentId;
  via?: string;                          // wrapped agent name for ACP lanes
  capabilities: AdapterCapabilities;     // attached on first event; may be downgraded by doctor
  fidelity: string | null;               // plain-words disabled-heuristic summary for the UI, null at full fidelity
  lifecycleConfidence: "observed" | "inferred";
  lifecycle: "idle" | "active" | "quiet" | "stale" | "waiting" | "turn_complete";
  waitingReason?: "question" | "permission" | "idle_prompt";
  mode: { exploring: number; editing: number; testing: number; other: number }; // sum ≈ 1
  displayedMode: "exploring" | "editing" | "testing" | "other";
  activity: number;   // 0..1
  progress: number;   // 0..1
  struggle: number;   // 0..1
  lastEventAt: number; // last work event; session.start does not reset the silence clock
  turnStartedAt?: number;
  reasons: Reason[];  // recent explanations, newest first, capped at 20
  // internal working memory (not sent to UI): windows, fingerprint counts, EMAs
};

type Reason = { at: number; signal: "struggle" | "progress" | "lifecycle" | "mode"; delta?: number; text: string };
```

`LaneRender` (what the attention model emits to the UI/audio) is `LaneState` minus working
memory plus `prominence`, `foreground` and `gestures`.

## Interface

```ts
applyEvent(state: LaneState, event: NormalizedEvent): LaneState
advance(state: LaneState, now: number): LaneState        // time-based decay, staleness
```

Both are pure and return new objects. The daemon calls `advance` every 500 ms with the
engine clock. Tests call it with a manual clock.

## Capability-aware inference

Core never checks `agent`. It checks `capabilities`. The same engine runs for every lane;
what changes is which evidence exists.

| Capability missing | Engine behaviour |
|---|---|
| `editEvents = false` | Mode has no `editing` evidence; `other` absorbs unknown activity. Struggle heuristics that need edits (same-file churn, edit→fail cycles) are **disabled**, not zeroed. Reasons say "edits not visible for this agent". |
| `turnStart = inferred` | `turn.start` events carry `inferred`; the engine accepts them but does not fire `arrive` again if the lane is already active. |
| `turnStart = none` | Lifecycle goes `idle → active` on the first tool event; no `question`/`resolve` gestures are suppressed, but `lifecycleConfidence = inferred`. |
| `turnEnd = none` | `turn_complete` is inferred after **120 s** with no events following a period of activity; carries `inferred`. `resolve` still plays; UI marks it inferred. |
| `permissionEvents = false` and `questionEvents = false` | `waiting` can only be inferred from an observable turn end: either `turn.end(completed)` with a trailing-`?` message or `turn.end(question, inferred)` from an adapter that inspected the final response. Otherwise a lane that goes `turn_complete` never drifts into `waiting`. Conservative on purpose: false "waiting" is worse than a missed one. |
| `toolFailures = false` | Struggle evidence from failures is disabled; only retry and read-loop evidence remains; UI says so. |
| `toolKinds = typed` | Mode uses the given kind directly, weight 1.0. `byName` uses the classifier, weight 1.0 for known names, 0.5 for `other`. |
| `compaction = false` | Long silences are `quiet` only; no compaction reason. |

Every disabled heuristic is listed in the lane's `fidelity` summary shown by the UI
("Codex: edits and questions not visible"). `fidelity` is `null` at full
fidelity, otherwise names every hidden evidence class in plain words
("edits and questions not visible"), derived from capabilities, never from
agent identity. Golden tests exist per adapter fixture so a
capability regression shows as a diff.

## Mode

Mode answers "what kind of work is this?" It is derived from tool categories.

- Maintain an EMA per category with time constant τ = 20 s, updated on every `tool.start`:
  the category of the tool gets weight 1, others 0, blended by `1 − exp(−Δt/τ)`.
- `exploring` ← `read` + `search` + `web`; `editing` ← `edit`; `testing` ← `exec` with
  `execKind ∈ {test, build, lint}`; `other` ← everything else (exec run/git/install, MCP).
- `displayedMode` switches only when another category's weight exceeds the current one by
  ≥ 0.15 **and** has done so for ≥ 5 s. This is the hysteresis that prevents flicker.
- Subagent events update the parent lane's mode with weight 0.5.

Rationale: agents interleave a read between edits constantly; the texture should not flip
on every tool call. The EMA gives a blend (audio can crossfade layers), and the displayed
mode is for the UI and for gesture decisions.

## Lifecycle

```
idle ──turn.start──▶ active ──(no events 90 s)──▶ quiet ──(no events 8 min)──▶ stale
  ▲                    │  ▲                          │                           │
  │                    │  └────── activity event ────┴───────────────────────────┘
  │                    ├── permission.request / question.asked ──▶ waiting
  │                    └── turn.end(completed) ──▶ turn_complete ──(20 s)──▶ idle
  │
  └── session.end (from any state) ; waiting ──turn.start──▶ active
  permission waiting ──turn.end(completed)──▶ turn_complete
  permission waiting ──tool event, same fingerprint as the request──▶ active (inferred)
```

- `waiting` is entered immediately on `permission.request` or `question.asked`, and on
  `turn.end` with `reason ∈ {question, permission, idle_prompt}` when the prompt is visible.
  An inferred `turn.end(question)` is also accepted when explicit question events are hidden:
  the source observed its own final response, while core remains agent-blind.
- `turn.end` with `reason = completed` → `turn_complete`, which triggers the `resolve`
  gesture and then decays to `idle` after 20 s. If a `turn.start` arrives during
  `turn_complete`, go straight to `active` (skip `arrive`).
- `quiet` means "still working, currently silent" (long model thinking, compaction). It is
  a texture-thinning hint, not an alert. `compaction` events set `quiet` immediately with
  `reasons` saying so.
- `stale` means no events for a long time while nominally active. Probably a hang, a
  hidden prompt, or a dead process. It raises prominence modestly and triggers a single
  `attention` gesture.
- Activity events from the session while `stale` or `quiet` return to `active`.
  `session.start` only observes that a session opened or resumed: it preserves the
  lifecycle and `lastEventAt`, so reading an old chat cannot make it work again or
  postpone quiet/stale/idle transitions. A new session starts idle; an existing active,
  waiting or completed session retains its status. A real `turn.start` or tool event
  still wakes a quiet/stale session. This rule applies to every adapter, without
  branching on agent identity or session-start source.
- A permission wait also ends on `turn.end(completed)`: completion is evidence that
  the turn is no longer blocked, even if the source has no separate approval-reply
  event. Preserve the completion event's confidence. A prior permission request must
  not keep displaying after normal completion. Question waits retain their answer rule.
- A permission wait whose `permission.request` named a tool also ends, as `inferred`,
  on a `tool.*` event with that tool's fingerprint: the requested action running is the
  grant, for sources with no approval-reply event (Codex has none). Without this
  exit a Codex lane showed "waiting for permission" for the rest of the turn after the
  user approved.
- `waiting` never expires through silence or unrelated tool activity. Its other exits
  are `turn.start` (the user answered), a `permission_replied` notification, or
  `session.end`. Do not time it out.
- `lifecycleConfidence` is `inferred` whenever the transition came from an event marked
  `inferred` or from an engine timeout; the UI shows it, the audio ignores it.

Invariants:

- `idle → waiting` never happens directly.
- `waiting` never expires on its own.
- `turn_complete` is entered from `active`/`quiet` or permission waiting via
  `turn.end(completed)`. It is never entered directly from idle or a question wait.

## Activity

`activity` is a normalized event-rate EMA (τ = 15 s) over `tool.*` events, scaled so that
one tool event per 4 s ≈ 1.0, clamped to [0, 1]. It drives texture density and decays
naturally in `quiet`. It carries no judgement.

## Progress

`progress` is a **novelty rate**: how much new ground the agent is covering.

Evidence (each adds to a leaky integrator, τ = 3 min, clamped to [0, 1]):

| Evidence | Weight | Detection |
|---|---|---|
| First time a file fingerprint is edited this turn | +0.10 | fingerprint not in turn's edit set |
| First time a command fingerprint runs this turn | +0.05 | fingerprint not in turn's exec set |
| `tool.end` for exec test/build after ≥ 1 prior `tool.fail` of the same fingerprint | +0.30 | "first green after red" |
| Test summary shows fewer failures than the previous run of the same fingerprint (Tier 2) | +0.20 | requires `outcome.testSummary` |
| `turn.end(completed)` | +0.20 | |

Progress is used for two things: to push struggle down, and (lightly) to brighten the
texture. It is not shown as a headline number in the UI beyond the timeline.

## Struggle

`struggle` is a leaky integrator with **half-life 10 min** absent evidence, clamped to
[0, 1]. It answers "is this agent going in circles?"

### Tier 1 evidence (MVP)

| Evidence | Weight | Detection window |
|---|---|---|
| Same exec fingerprint fails again | +0.15 per repeat after the first | 10 min |
| Same exec fingerprint fails a 4th+ time | +0.25 per repeat | 10 min |
| Same file fingerprint edited ≥ 3 times | +0.10 per edit beyond the 2nd | 5 min |
| Same file edited ≥ 6 times | +0.20 per edit beyond the 5th | 5 min |
| Identical exec fingerprint run again with no edit in between | +0.10 | 3 min |
| Edit → exec(test/build) fail → edit → same exec fail cycle | +0.20 per complete cycle | 15 min |
| Same read/search fingerprint ≥ 4 times | +0.05 per repeat beyond the 3rd | 5 min |

### Progress counter-evidence

Each unit of progress evidence subtracts `1.5 × weight` from struggle (progress beats
struggle asymmetrically; one green build should visibly relieve tension). A
`turn.end(completed)` resets struggle to `min(struggle, 0.2)`.

Fast release by design (ADR 0019, p3-t14): a first green after red (+0.30
progress) relieves 0.45 struggle, so a lane stuck at the 0.6 attention
threshold drops below the 0.4 re-arm on the first green — the structural
voice opens back up instead of ratcheting upward and staying stuck after
recovery. `packages/core/test/engine/struggle.test.ts` proves the release
at unit scale; the golden trajectories show it per fixture.

### Deferred evidence sources

Test-runner output parsing, revert detection via git, error-message set distance.
Not in MVP because they require per-tool parsing and are brittle.

### Presentation thresholds

- Struggle contributes to prominence continuously (see Attention)
- The `attention` gesture fires once when struggle crosses **0.6 upward**, and may fire
  again only after struggle has dropped below **0.4** and crossed 0.6 again (hysteresis)
- The UI colours struggle from 0.3; the texture starts to "stick" from ~0.3 (see
  `SOUND_DESIGN.md`)

### Explainability

Every increment appends a `Reason`: `struggle +0.15 — "npm test" failed again (3rd time in
6 min)`. The UI shows the last three. If the reason text can't be written in one plain
sentence, the heuristic is too clever.

## Invariants (property-tested)

1. Repeating an identical `tool.fail` with no other events never decreases `struggle`.
2. With no events, all of `activity`, `progress`, `struggle` converge toward 0; `struggle`
   halves every 10 min ± 5%.
3. `mode` weights sum to 1 ± 1e-6 after any sequence.
4. `displayedMode` changes at most once per 5 s.
5. Applying the same event sequence with the same clock yields deep-equal states
   (determinism).
6. Lifecycle transitions obey the diagram; illegal transitions are unreachable.
7. Subagent events never change the subagent's own lane (it has none); they mutate the
   parent.
8. For a lane whose capabilities deny a kind of evidence, the corresponding struggle
   components are exactly zero for the whole trajectory (disabled, not noisy).
9. Two lanes with identical event sequences and identical capabilities produce identical
   states regardless of `agent` — the engine is agent-blind.

## Attention model

Input: all `LaneState`s, `calm ∈ [0, 1]`, previous `AttentionState` (for hold timers).
Output: `LaneRender[]`.

### Prominence per lane

```
base(lifecycle):  waiting 0.90 | stale 0.55 | active 0.25 | quiet 0.15 | turn_complete 0.50→0 over 6 s | idle 0
struggleTerm   =  0.6 × struggle × (1 − 0.5 × calm)
transitionBump =  0.30 × exp(−(now − lastTransitionAt) / 8 s)     // any lifecycle or displayedMode change
prominence     =  clamp(base × (1 − 0.6 × calm × isActiveOrQuiet) + struggleTerm + transitionBump, 0, 1)
```

Calm scales down *routine* presence (active, quiet, mode transitions) and struggle
sensitivity, but **never** the `waiting` base. Waiting is unmistakable at any Calm.

### Foreground

At most one lane is `foreground` at a time:

- Candidate: highest prominence lane with prominence ≥ 0.5
- A lane holds foreground for at least **15 s** once acquired unless another lane enters
  `waiting`
- Ties broken by most recent transition

Foreground moves a lane "closer" (drier, brighter, wider — see `SOUND_DESIGN.md`). It does
not make it louder.

### Loudness budget

Lanes' texture gains are soft-normalized so that `Σ gain_i ≤ 1.0` with a soft knee from
0.8. Background lanes yield first. This is enforced in `core/scene/render`, not in the
audio graph, so it is testable.

### Gestures

Emitted once per transition, deduplicated per lane with a 3 s refractory period:

| Transition | Gesture |
|---|---|
| lane acquires a session (`session.start` or first `turn.start`) | `arrive` |
| enters `waiting` | `question` (then the tension layer holds) |
| enters `turn_complete` | `resolve` |
| struggle crosses 0.6 upward (hysteresis 0.4), or enters `stale` | `attention` |

No gesture for mode changes; those are texture crossfades. No gesture for leaving
`waiting`; the tension layer releasing is the cue.

## Calm

`calm ∈ [0, 1]`, default 0.6. Effects, in `core/scene/render` and attention:

- routine presence scaled by `(1 − 0.6 × calm)`
- struggle sensitivity scaled by `(1 − 0.5 × calm)`
- texture density and responsiveness to activity scaled by `(1 − 0.5 × calm)`
- master gain: `−6 dB × calm` on top of the default level
- at `calm ≥ 0.8` and all lanes in `active`/`quiet` with struggle < 0.3, target
  near-silence: bed at −40 dBFS, textures at −48 dBFS or below (asserted by audio QA)

Calm never affects: the `waiting` base, the `question`, `resolve` and
`attention` gestures, the tension layer while waiting.

Calm-invariance extends to all hard gestures (ADR 0018, p3-t14): at any
Calm, routine presence and macro density fall while arrival, waiting,
completion and attention stay perceptible. The scene mapping voices
gestures pre-trim (their gains never scale with Calm); `attention` keeps
its deliberate −4 dB audibility taper at calm 1, which is a gesture-level
voicing, not a presence cut.
