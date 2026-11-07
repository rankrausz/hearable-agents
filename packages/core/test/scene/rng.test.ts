// packages/core/test/scene/rng.test.ts — behaviour tests for the seeded
// RNG: uniform range, determinism per seed, distinct seeds diverge, fork
// substreams are independent of the parent and of each other, and no code
// path touches Math.random or Date.now (the boundary lint re-proves that).

import { describe, expect, it } from "vitest";

import { createRng } from "../../src/rng.js";

function sequence(seed: number, count: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.next());
}

describe("seeded RNG", () => {
  it("stays inside [0, 1) over a long stream", () => {
    for (const value of sequence(7, 10_000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("reproduces the same stream for the same seed", () => {
    expect(sequence(1234, 200)).toEqual(sequence(1234, 200));
  });

  it("diverges for different seeds", () => {
    expect(sequence(1, 20)).not.toEqual(sequence(2, 20));
  });

  it("advances on every call so a stream never sticks", () => {
    const values = sequence(99, 50);
    expect(new Set(values).size).toBeGreaterThan(40);
  });

  it("forks a substream that is reproducible and leaves the parent untouched", () => {
    const parent = createRng(42);
    parent.next();
    const forked = parent.fork(3).next();
    const fresh = createRng(42);
    fresh.next();
    expect(parent.next()).toBe(fresh.next());
    expect(forked).toBe(createRng(42).fork(3).next());
  });

  it("forks independent substreams per salt", () => {
    const rng = createRng(5);
    expect(rng.fork(1).next()).not.toBe(rng.fork(2).next());
  });

  it("truncates non-integer and negative seeds instead of producing NaN", () => {
    for (const seed of [3.9, -1, Number.MAX_SAFE_INTEGER + 0.5]) {
      const value = createRng(seed).next();
      expect(Number.isNaN(value)).toBe(false);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
