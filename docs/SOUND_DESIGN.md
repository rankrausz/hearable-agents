# Sound design

Clearing is a shared ambient scene. Each audible session occupies a seat with its own
register, timbre, and stereo position. The centre seat fills first, and established
sessions keep their seats as others arrive or leave. Four seats can sound at once.
Overflow sessions stay visible as queued and can trigger a quiet queue cue.

## Mapping

The [state engine](STATE_ENGINE.md) derives activity, mode, lifecycle, progress, and
struggle. The pure [scene mapper](../packages/core/src/scene/render.ts) turns those
signals into targets. Activity affects presence. Exploring, editing, and testing shape
the mix of air, grain, and pulse. Waiting adds tension. Struggle changes the pattern of
the voice without raising its volume. Calm reduces routine presence while keeping
event cues distinct.

The shared harmonic field, drone, rain, and reverb make the mix sound like one space.
Routine pitch changes crossfade between two banks while each sounding bank holds its
pitch. [Core scene tuning](../packages/core/src/scene/tuning.ts) defines the mapping
constants. [Clearing tuning](../packages/audio/src/scenes/clearing/tuning.ts) defines
the voice and space settings.

## Gestures

Event cues are soft rolled chords made from [locally bundled piano recordings](../packages/audio/src/scenes/clearing/ASSETS.md).
Their voicing follows the harmony at the instant of the cue. Lane cues retain the
seat's position and room send.

| Cue | Meaning |
|---|---|
| Arrival | A session starts or resumes audible work |
| Question | A session enters waiting |
| Resolve | A turn finishes |
| Attention | A session crosses an attention threshold |
| Overflow | A session joins the queue for an audible seat |

The [gesture player](../packages/audio/src/gestures/player.ts) owns cue spacing,
priority, and pre-emption. A question can interrupt a cue already playing in that
lane. The [piano bank](../packages/audio/src/piano/bank.ts) owns sample loading and
note lifetimes.

## Ramps and playback

Use the named [ramp classes](../packages/audio/src/ramps.ts) for audible changes.
Audio starts behind a closed output gate. In the default activity-only mode, a working
or waiting session keeps the gate open. Once only quiet or inactive lanes remain, the
mix fades to silence over two seconds and resumes when work returns. A quiet lane
still plays at reduced presence if another lane keeps the gate open. Continuous mode
keeps the ambient mix playing.

When a turn completes, its ambient voice starts fading immediately. The gate stays
open for four seconds to let the rolled piano cue play before the two-second fade.
Manual start and stop use a one-second ramp. Disconnects mute the local graph.
See the [playback policy](../apps/web/src/playback-policy.ts) and
[output gate](../packages/audio/src/output-gate.ts).

## Automated QA

Run `pnpm audio:qa` to render named scenarios through the browser audio graph.
The [audio QA spec](../e2e/audio-qa.spec.ts) defines the scenario inputs, analysis
windows, and assertions for level, sample jumps, DC offset, spectral balance, cue
timing, and other scenario-specific limits. It distinguishes assertions from reported
diagnostics. The harness writes WAVs for review. Follow the
[listening procedure](VERIFICATION.md#listening) for changes people will hear.
