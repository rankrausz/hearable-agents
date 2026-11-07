// packages/core/src/rng.ts — the seeded deterministic random source.
// What this is for: reproducible randomness for drift (`packages/audio`)
// and audio QA renders — the same seed plus the same inputs yields the same
// output, so CI renders are byte-stable and live sessions can use a random
// seed. What it must not do: I/O, time, `Math.random()`, `node:*` or
// workspace imports — it is closed-over integer arithmetic (mulberry32) so
// it runs identically in the daemon, tests and the browser.

/** Minimal deterministic random source: uniform values plus substreams. */
export type Rng = {
  /** Next uniform value in [0, 1). */
  readonly next: () => number;
  /**
   * An independent substream derived from this generator's seed and `salt`.
   * Forking never advances the parent, so two forks with the same salt
   * produce the same sequence regardless of when they are taken.
   */
  readonly fork: (salt: number) => Rng;
};

// mulberry32 increment and the two output-mixing constants below are the
// published algorithm constants, not tuned values, which is why they live
// here rather than in a tuning module.
const MULBERRY32_STEP = 0x6d2b79f5;
const MULBERRY32_MIX_A = 0x85ebca6b;
const MULBERRY32_MIX_B = 0xc2b2ae35;

/** One mulberry32 step: advances `state` and returns a uniform [0, 1). */
function step(state: { value: number }): number {
  state.value = (state.value + MULBERRY32_STEP) | 0;
  let mixed = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
}

/** Mixes a seed with a salt into a new 32-bit seed for `fork`. */
function mixSeed(seed: number, salt: number): number {
  let mixed = Math.imul(seed ^ salt, MULBERRY32_MIX_A);
  mixed = Math.imul(mixed ^ (mixed >>> 13), MULBERRY32_MIX_B);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

/**
 * Creates a deterministic generator from any integer seed. Non-integers are
 * truncated to 32 bits, so callers never need to sanitize slider values.
 */
export function createRng(seed: number): Rng {
  const normalized = seed | 0;
  const state = { value: normalized };
  return {
    next: () => step(state),
    fork: (salt: number) => createRng(mixSeed(normalized, salt | 0)),
  };
}
