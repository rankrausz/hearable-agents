<p align="center">
  <img src="docs/media/app-icon.png" width="180" height="180" alt="Hearable Agents headphone mascot">
</p>

<h1 align="center">Hearable Agents</h1>

<p align="center">
  <strong>Keep an ear on your coding agents.</strong><br>
  Hear their live activity as an evolving ambient soundscape.
</p>

Hearable is a small Mac menu bar app (currently) that lets you hear what your coding agents are doing.
It plays quiet ambient music that reflects their current status, and cues you when an agent
needs you or finishes. It lets you have awareness on your agent without checking on them, so you can better focus on the rest of your work.

<p align="center">
  <img src="docs/media/active-portraits-mixed-light.png" alt="Hearable with working, quiet, and waiting sessions">
</p>

## What it actually does

Hearable builds the soundscape from the events your coding sessions produce. Each harness
connects through an adapter that translates events like tool starts, permission requests,
and turn endings into a shared format. The adapter also declares which signals its harness
can report, so the same state engine can handle different harnesses based on the evidence
each one provides.

```mermaid
flowchart TD
    Claude["Claude Code"] --> ClaudeAdapter
    Codex["Codex"] --> CodexAdapter
    Other["Another harness"] -.-> NewAdapter

    subgraph Daemon["Local daemon"]
        ClaudeAdapter["Claude Code adapter"] --> Contract["Shared events and capabilities"]
        CodexAdapter["Codex adapter"] --> Contract
        NewAdapter["New adapter"] -.-> Contract
        Contract --> State["Session state engine"]
    end

    State --> View["Session view"]
    State --> Audio["Sound planner and renderer"]
    Audio --> Mix["Ambient soundscape"]
```

The state engine uses recent events and their timing to track how active each session is,
what kind of work it’s doing, and whether it needs input. An explicit permission request
can change the state immediately. A stretch of silence gradually lowers the session’s
activity level.

Activity determines how far forward a session sits in the mix. Exploring, editing, and
testing shift the blend of airy textures, grain, and pulse. The renderer fades between
those settings and plays chords made from recorded piano notes at specific transitions.
Sessions share a harmonic palette, so their sounds can change independently and still
fit together as one piece.

## Try it

The preview DMG requires an Apple Silicon Mac with macOS 13 or later.
[Download Hearable 0.1.0](https://github.com/rankrausz/hearable-agents/releases/download/v0.1.0/Hearable-0.1.0-macos-arm64.dmg)

Open the DMG and drag **Hearable** into **Applications**. Launch it from Applications,
then turn on **Audio** in the menu bar popover. This preview has no Apple notarization.
If macOS blocks the first launch, follow [Apple’s Open Anyway instructions](https://support.apple.com/en-us/102445).

### Connect an agent

Current packaged builds offer **Connect an agent** in the menu bar popover. Choose
Claude Code or Codex and start a new agent session. The v0.1.0 download above
requires you to install hooks from source.

Clone this repository to run that installer. You’ll need Node **22.12+** and pnpm **11.25.0**.
From the repository root, install dependencies and run the hook installer.

```sh
pnpm install --frozen-lockfile
pnpm --filter @hearable/cli hearable install
```

The installer detects Claude Code and Codex on your `PATH` and asks before updating their
local hook configuration. If Codex prompts you to trust the hooks, review them in `/hooks`.
Start a new session in the agent you connected to hear it in the mix.

To run Hearable from source, use `pnpm mac` after installing dependencies.
See [Getting started](docs/GETTING_STARTED.md) for fixture replay, standalone builds, and troubleshooting.
See [privacy and recording](docs/PRIVACY.md) for what Hearable processes and stores locally.

Code is [MIT licensed](LICENSE). The bundled recordings (piano samples and the rain bed) have
their own [licenses and attribution](packages/audio/src/scenes/clearing/ASSETS.md).
