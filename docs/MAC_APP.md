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

Security: sandboxed renderer, context isolation, no Node integration, restricted
navigation, strict CSP, and sender/schema checks on IPC. See `src/main/policy.ts`,
`windows.ts`, `bridge.ts`, and the focused native tests.

Build with `pnpm mac:build`; run source with `pnpm mac`. `pnpm test:mac` runs isolated,
muted native/browser tests. Installed-app and endurance tests require an explicitly
selected executable; see their headers under `apps/mac/test/`.

The app remains unsigned. Signing, notarization, auto-update, observed next-login startup,
and qualified long-duration sleep/wake evidence are outstanding. [Verification](VERIFICATION.md)
records the difference between completed automated checks and pending observation.
