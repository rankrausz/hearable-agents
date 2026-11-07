# Getting started

## Requirements

macOS for the app; Node 22.12+ and pnpm 11.25.0 for source builds. A packaged app bundles
its runtime and does not require external Node. Agent hooks require the corresponding
agent CLI. No hook installation is needed for fixture replay.

```sh
pnpm install --frozen-lockfile
pnpm mac
```

Open the tray popover. Audio starts off on a fresh installation. Enable it there; the app
remembers that choice. Volume, Calm, session portraits, Open at login, and Quit are also
available there.

## Agent hooks

```sh
pnpm --filter @hearable/cli hearable install codex
pnpm --filter @hearable/cli hearable install claude-code
pnpm --filter @hearable/cli hearable doctor
```

Install only the integrations you want. These commands update local agent hook files;
review the resulting configuration. Codex trust/feature settings may require attention.
Follow `doctor` diagnostics. Adapter-level uninstall is tested, but the top-level
`hearable uninstall` command is deferred; do not assume it exists.

## Replay without a live agent

With the Mac app running, run this from the repository root:

```sh
pnpm --filter @hearable/cli hearable replay ../../fixtures/sessions/codex/clean-feature.jsonl --speed 10
```

The relative fixture path is evaluated from the CLI package. This particular fixture is
labelled synthetic in its annotations. It demonstrates transport and rendering, not a
live agent benchmark. Start audio in the popover to hear it.

## Build an app

```sh
pnpm mac:build
```

The output is `apps/mac/release/Hearable-darwin-arm64/Hearable.app` on Apple Silicon
(`darwin-x64` on Intel). Copy it to Applications. This is an unsigned local build;
macOS may require Open Anyway in System Settings → Privacy & Security.
Signing, notarization, and automatic updates are not implemented.

## Development and troubleshooting

`pnpm dev` runs the local daemon and renderer development server. The browser route
`http://127.0.0.1:5173/?view=popover` previews the interface; native audio/login controls
require the Mac host. The root page is only the hidden audio endpoint.

Use `doctor` for hooks and daemon diagnostics. Quit stops a daemon the app started;
a daemon adopted from an existing CLI/service continues running. Another audio endpoint
may hold the playback lease. See [verification](VERIFICATION.md) for known startup issues.
