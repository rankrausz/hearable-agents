# Verification and limitations

## Reproduce checks

Install with `pnpm install --frozen-lockfile`. For browser and native tests, install
Chromium with `pnpm exec playwright install chromium`.

| Command | What it checks |
|---|---|
| `pnpm lint` | Style and package restrictions |
| `pnpm typecheck` | Workspace TypeScript contracts |
| `pnpm test` | Core trajectories, adapters, daemon, audio and host units |
| `pnpm boundaries` | Import and purity restrictions |
| `pnpm conformance` | Adapter mapping, installation, outage, privacy, and timing |
| `pnpm check:public` | Public file boundaries and local Markdown links |
| `pnpm test:e2e` | Browser runtime and offline audio graph |
| `pnpm test:mac` | Muted native host, popover, playback, focus, and lifecycle |
| `pnpm audio:qa` | Numeric audio render and replay scenarios |
| `pnpm mac:build` | Standalone unsigned Mac packaging |

## Known limits

- Earlier runs exceeded the 50 ms hook budget under load and reported audio startup
  timeouts. Long sleep/wake endurance and next-login startup still need observation.
- Claude Code and Codex hooks vary in what they can observe. A permission request can
  be auto-approved, so the app may lack evidence that a person is blocked.
- Synthetic fixtures exercise transport and behavior. Perception and productivity
  have yet to be measured, and struggle detection is still being calibrated.
- The Mac preview is unsigned. Signing, notarization, and automatic updates are pending.

## Listening

Run `pnpm audio:qa` and `pnpm owner:listen` to prepare local WAVs. Keep a listening
session to 15 minutes and at most two pending changes. Record the build revision,
output device, volume, scenarios, and the listener's observations. Listen for smooth
fades, distracting repetition, and whether waiting and completion cues are
distinguishable without the popover. Numeric results measure signal properties.
Listening supplies evidence about clarity and pleasantness.
