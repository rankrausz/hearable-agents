// packages/audio/src/graph/nature.ts — the pure nature-bed schedule: seeded
// loop start offsets plus the per-apply crossfade parity. What this is for:
// giving createNature (builder.ts) deterministic slow variation — two voices
// of the one sampled loop staggered by half the loop, re-balanced per apply —
// without reading lane state, clocks or agent events. What it must not do:
// import Tone, keep mutable state, or branch on anything but the seed/tick.

import { createRng } from "@hearable/core";
import { NATURE_BED } from "../scenes/clearing/index.js";

/** Seeded start offsets for the two loop voices, in seconds into the loop. */
export type NatureOffsets = {
  readonly voiceA: number;
  readonly voiceB: number;
};

/**
 * Seeded slow variation for the nature bed: the two loop voices' start
 * offsets, staggered by half the loop so the 12 s texture never repeats
 * obviously inside a long render. Pure function of the seed — the same
 * schedule every render, deterministic or with the documented tolerance
 * the harness already grants unseeded noise. Threaded into createNature
 * by the caller (QA passes its render seed explicitly; live takes the
 * default), so the schedule is data, never a loader seam.
 */
export function natureOffsets(seed: number = NATURE_BED.seed): NatureOffsets {
  const rng = createRng(seed);
  const voiceA = rng.next() * NATURE_BED.loopDurationS;
  const voiceB = (voiceA + NATURE_BED.loopDurationS / 2) % NATURE_BED.loopDurationS;
  return { voiceA, voiceB };
}

/**
 * Crossfade parity for a descriptor tick: even ticks lead voice A, odd
 * ticks voice B. Pure function of the tick alone — no lane field, no
 * clock, no agent event — so the alternation is lane-blind by signature.
 */
export function natureCrossfadeParity(tick: number): 0 | 1 {
  return tick % 2 === 0 ? 0 : 1;
}

/**
 * Equal-power voice gains for a parity angle: the pair always sums in
 * power to unity (cos² + sin² = 1 at either angle), so the seat gain —
 * the one density-planned level — is the only thing that sets the bed
 * level. The crossfade only re-balances the pair, never lifts it.
 */
export function natureVoiceGains(parity: 0 | 1): readonly [number, number] {
  const angle = parity === 0 ? Math.PI / 6 : Math.PI / 3;
  return [Math.cos(angle), Math.sin(angle)];
}
