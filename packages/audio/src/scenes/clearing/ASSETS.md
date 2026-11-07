# Clearing scene assets

Per `docs/SOUND_DESIGN.md` Assets: synthesis first, plus recorded/sampled
material alongside synthesis per ADR 0017 (CC0, self-recorded, or licensed
for redistribution, with an explicit bundled size budget).

Current (2026-10-29, ADR 0028): the scene ships one nature-bed file and seven
recorded acoustic piano notes for every event cue. The piano is Salamander Grand
Piano v3 by Alexander Holm, CC BY 3.0; full attribution, source blob identities,
checksums and modification details: [piano/ATTRIBUTION.md](assets/piano/ATTRIBUTION.md).
The full licence is beside those recordings. `apps/web/public/audio-credits.txt`
ships in both the web build and packaged Mac app.

The p3-t15 nature bed:

| Asset | Type | Source | Licence | Notes |
|---|---|---|---|---|
| `assets/nature-bed-soft-rain-12s.wav` | mono WAV, 16 kHz 16-bit, 12 s, 384,044 bytes | Self-recorded by synthesis: generated for this task from a seeded RNG (`seed 20260909` — deterministic filtered-noise soft-rain recipe, script kept in the task result, no third-party material) | CC0 (task author's own generation, dedicated to the public domain) | The p3-t15 nature bed: a soft-rain texture looped under the mix with seeded start offsets and two-voice slow crossfades; peak −12 dBFS in-file so the −44 dBFS bed seat holds headroom. Loaded via the Offline-ready asset path (same `await ready` lifecycle as `reverb.ready`); never steps (≥ 5 ms fades on starts, equal-power crossfade windows). |

Remaining voices are synthesized by the live graph (`graph/builder.ts`)
and the offline gesture renderer (`gestures/render.ts`):

- Lane voices: pad (filtered saw pair), mallet (sine+triangle), flute
  (breathy sine+triangle pair plus filtered-noise breath per note).
- Texture/noise voices: pink/white noise through band-pass/low-pass
  filters (lane air, grain-layer breath, pulse swell, shared HF air,
  historical attention-knock diagnostic burst) generated from fixed-seed RNG (`gestures/
  render.ts`), so the noise slots are filled by generation, not by a
  shipped file.
- Shared space: the one generated-IR reverb (`Tone.Reverb`, plate-ish,
  ~5 s decay, 30 ms pre-delay) — no sampled impulse shipped.
- Saturation: a static odd-symmetric tanh `Tone.WaveShaper` on the master path —
  no impulse, no table file.

## Convolution decision (p3-t13, recorded per the task)

Evaluated, not shipped. Tone 15.1.22 generates the shared Reverb impulse
asynchronously inside `Tone.Offline`, and every QA render already awaits
`reverb.ready` inside the same Offline context; a sampled convolution IR
would need its own buffered-Convolver path with async decode inside
Offline plus a CC0 IR asset inside the size budget — a live/QA lifecycle
the current harness does not cover. The shared generated-IR reverb stays
the believable shared space; a sampled-convolution upgrade belongs to a
task that also owns the Offline-ready asset path.

## Convolution evaluation (p3-t16 — one sampled IR vs generated, keep)

Evaluated one self-generated CC0 candidate (seeded exponential-decay
noise, mono 16 kHz 16-bit 2.0 s, 64,044 bytes — inside the 140,244 bytes
remain; RT60 fit ~2.3 s, peak −12 dBFS in-file, no predelay, mono) against
the shared generated-IR space (Tone 15.1.22 `Reverb.generate`, verified in
the shipped ESM: stereo decorrelated noise burst, 5 s decay param via
`exponentialApproachValueAtTime`, 30 ms predelay via the gain gate, IR
rendered in its own OfflineContext and fed to the ConvolverNode behind
the `ready` lifecycle QA/live already await).

Listening-relevant numbers:

| Read | Sampled candidate | Generated (shipped) |
|---|---|---|
| Tail (RT60) | ~2.3 s — less shared-space glue | 5 s decay param — the coherent tail |
| Image | mono (collapses the width drift p3-t16 adds) | stereo decorrelated (carries width drift) |
| Onset separation | no predelay | 30 ms predelay (question/attention read) |
| Budget | 64,044 bytes of the 140,244 remain | 0 bytes |
| Lifecycle | new buffered-Convolver path + async decode inside Offline + ready surface (harness work beyond this task) | already awaited (`reverb.ready`, same Offline context) |

Decision: KEEP generated — no silent upgrade. The candidate's shorter
mono tail buys nothing the 5 s stereo tail does not already carry, and
shipping it would cost a new Offline-ready asset path (async decode
inside Offline plus lifecycle) the task explicitly excludes: per the task
notes, when the IR needs harness work beyond the task, the drift half
ships and the IR files as the named follow-up. Follow-up:
`p3-t1x-sampled-convolution-space` — owns the buffered-Convolver path,
the Offline-ready decode lifecycle, and a stereo CC0 IR inside the
≤ 512 KB budget (baseline to beat: 5 s stereo tail, 30 ms predelay,
`reverb.ready` lifecycle, 0 bytes).

## Bundled size budget

Current budget: **≤ 2 MiB total** across sample/impulse files, amended by
ADR 0028 for the owner-requested recorded piano. The earlier 512 KiB budget
applied to the nature-only graph. Every future sample added to the
scene must be listed below with source and licence before it is used.

| Asset | Type | Source | Licence | Notes |
|---|---|---|---|---|
| `assets/nature-bed-soft-rain-12s.wav` (see above) |  |  |  | 384,044 bytes |
| `assets/piano/{C3,Fs3,C4,Fs4,C5,Fs5,C6}.wav` | mono WAV, 22.05 kHz, 16-bit, 4.2 s each | Alexander Holm, Salamander Grand Piano v3 (soft layer 3) | CC BY 3.0 | 1,297,086 bytes; with rain, 1,681,130 of 2,097,152 bytes used |

This file is the single ledger for scene assets; any future sample added to
the scene must be listed here with source and licence before it is used.
