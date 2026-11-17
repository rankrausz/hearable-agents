# Mac menu bar host

`apps/mac` is a thin Electron host for the daemon and renderer. The popover shows session
portraits, lifecycle words, inferred labels, connection state, Calm, volume, audio enable,
Open at login, and Quit. Portrait actions can focus a verified local agent host or hide
quiet/finished sessions. A resumed chat stays quiet until actual work starts.

The hidden audio window loads `apps/web/src/AudioHost.tsx`. It holds the audio lease,
heartbeats, and playback lifetime; closing the popover never ends playback. There is no
Open console action or developer interface in the public build.

The app adopts an existing daemon when possible and stops only a daemon it owns. Audio
starts off on a fresh install; a remembered choice may restart it. Audio is gated by
activity and endpoint ownership, and parameter changes retain the existing ramps.

For a separate test daemon, put a `daemon.json` in
`~/Library/Application Support/Hearable/` before opening the app. Use the daemon's
normal config fields and choose both an unused loopback `port` and a separate absolute
`dataDir`. The app uses this file instead of `~/.config/hearable/config.json` when
present. `HEARABLE_MAC_CONFIG` takes precedence over both. This changes only the Mac
app's daemon; installed hooks and the CLI keep their own settings.

The packaged app can install user-level Claude Code or Codex hooks through **Connect an
agent**. A native dialog requires the user's choice before changing settings. The hooks point
at the relay inside the installed app and deliver to the app's configured loopback daemon.
Packaging includes a checksum-pinned standalone Node runtime for that relay.

Security: sandboxed renderer, context isolation, no Node integration, restricted
navigation, strict CSP, and sender/schema checks on IPC. See `src/main/policy.ts`,
`windows.ts`, `bridge.ts`, and the focused native tests.

Build with `pnpm mac:build`; run source with `pnpm mac`. `pnpm test:mac` runs isolated,
muted native/browser tests. Installed-app and endurance tests require an explicitly
selected executable; see their headers under `apps/mac/test/`.

The app remains unsigned. Signing, notarization, auto-update, observed next-login startup,
and qualified long-duration sleep/wake evidence are outstanding. [Verification](VERIFICATION.md)
records the difference between completed automated checks and pending observation.
