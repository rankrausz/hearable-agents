# Working on Hearable Agents

Read [architecture](docs/ARCHITECTURE.md) and the relevant
[event](docs/EVENTS.md), [state](docs/STATE_ENGINE.md), [audio](docs/SOUND_DESIGN.md), or
[Mac](docs/MAC_APP.md) specification before changing behavior.

## Invariants

1. Core is pure: no I/O, workspace imports, ambient time, or unseeded randomness.
2. Hooks always exit zero, print nothing to stdout, and target a total latency below
   50 ms. Drop events when the daemon is unreachable. Never interfere with the agent.
3. Audible changes use ramps, named numeric QA scenarios, and a batched human ear gate.
4. Never edit recordings or weaken thresholds to pass checks. Deliberate golden changes
   explain improvements and regressions per fixture.
5. Stay within the task. Escalate unresolved product/privacy/scope contradictions.
6. Core branches on capabilities, not agent identity. Adapters never invent evidence.

## Workflow

State the approach and acceptance checks before edits. Keep changes reviewable. Update
public technical documentation with behavior. Record lasting decisions. TypeScript
is strict ESM; use named exports, boundary schemas, explicit dependencies, and plain data.
Modules explain purpose and prohibited responsibilities. User-facing text uses sentence
case and concrete recovery advice. Justify every new dependency; core and hook-side code
have no new runtime dependencies.

Use scoped checks while iterating and the integrated matrix at milestones. Report failing
baselines as failures; never silently waive regressions. Verify external APIs against
installed types or official documentation. See [verification](docs/VERIFICATION.md).

Work in one session on main and review the diff before committing locally. Push, publish,
release, and GitHub mutations require explicit owner authorization. Keep private development
notes and tools out of the app source and build.
