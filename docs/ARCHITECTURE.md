# Architecture

Hearable observes coding-agent events and presents their lifecycle through a Mac popover
and audio. It does not control agent decisions or send events to an inference service.

## Boundaries

| Component | Responsibility | Must not do |
|---|---|---|
| `packages/core` | Schemas, classification, state, attention, musical planning | I/O, ambient clock/randomness, agent-name branching |
| `packages/adapter-kit` | Adapter contracts, relay, conformance harness | Depend on daemon or presentation |
| `packages/adapters/*` | Source mapping, capabilities, installation, diagnostics | Invent source evidence or block an agent |
| `packages/daemon` | Ingest, sessions, lanes, recording/replay, endpoint ownership | Delegate state authority to a renderer |
| `packages/audio` | Tone.js graph, ramps, voices, offline QA | Infer agent lifecycle |
| `packages/cli` | Local commands and services | Hide unsupported commands |
| `apps/web` | [Popover](UI.md), feed client, hidden audio host | Include development console/lab UI |
| `apps/mac` | Electron windows, tray, login, daemon ownership, validated IPC | Reimplement product inference |

## Event flow

A hook relay forwards payloads to `POST /events`. Adapters validate and map them into the
[normalized event contract](EVENTS.md). Core derives activity, mode, struggle, and progress
using declared capabilities; attention and scene planning then produce render targets.
The daemon broadcasts snapshots and frames over `/ws`. The renderer applies those targets
to the audio graph. All renderer clients see the same daemon-owned state.

The relay exits zero and writes nothing to stdout, including daemon outages. The wall-clock
budget is 50 ms, including startup; recorded load-sensitive failures remain open. This is
a requirement, not a claim that every measured invocation currently meets it.

## Time and determinism

Core receives timestamps and seeded RNGs explicitly. The daemon owns clocks and replay
scheduling. Live harmonic field epochs follow elapsed audio time from graph startup.
Gesture timestamps still use the daemon clock. Golden trajectories, seeded invariants,
and replay tests exercise these boundaries. Audio rendering is tested separately against
the browser's Web Audio runtime.
See [state engine](STATE_ENGINE.md) and [sound design](SOUND_DESIGN.md).

## Transport and ownership

`/health` exposes health, `/events` ingests events, `/ws` carries the feed, and `/calm`
changes the shared Calm setting. The authoritative transport implementations are
`packages/daemon/src/server.ts`, `broadcast.ts`, `audio-election.ts`, and the runtime guards
in `apps/web/src/protocol.ts`. Each connection receives a snapshot before incremental
frames. One endpoint holds the audio lease; heartbeat, release, and explicit takeover
prevent duplicate playback across renderers. Disconnects mute the local graph.

## Mac lifetime

The [Mac host](MAC_APP.md) adopts a healthy existing daemon or starts its own. Quit stops
only an owned daemon. The popover and hidden audio endpoint use isolated renderer windows
served by the daemon. Native actions cross a validated, sender-checked preload bridge.
Node integration is disabled. Navigation and CSP remain restricted to the daemon origin.

## Scope

Claude Code and Codex are implemented. OpenCode, Cursor, ACP, and generic emit remain
future integrations even where their names appear in schemas or design records.
