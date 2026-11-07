// packages/core/src/scene/macro.ts — the pure macro-evolution schedule.
// What this is for: Clearing's slow musical world on its own clock
// (ADR 0017, owner direction §§Three timescales, Musical development): a
// deterministic function of engine-clock seconds plus an injected seeded
// RNG — the 1–4 minute epoch schedule, and per epoch the environmental
// texture swell, density share, brightness and bed bloom. The harmonic
// content of each epoch lives in field.ts (ADR 0025) on this same
// schedule. Nothing here reads agent traffic, so no agent event can
// trigger, steer or synchronize the world; meso (agent state) scales it
// downstream in render.ts and micro gestures stay untouched. What it must
// not do: I/O, Date.now(), Math.random(), node:* or workspace imports, or
// read LaneRender/agent fields.

import { createRng, type Rng } from "../rng.js";

/**
 * One macro checkpoint: the world's texture and level shape from
 * `atSeconds` until the next checkpoint. Meso scales it downstream
 * (presence, density, brightness, bed bloom) without re-triggering it:
 * the checkpoint times and contents below never move, whatever the lanes
 * do. The chord sounding under this checkpoint is `fieldAt` (field.ts).
 */
export type MacroState = {
  /** Engine-clock seconds this checkpoint starts at. */
  readonly atSeconds: number;
  /** Texture-swell level 0..1 (environmental air, one evolving texture). */
  readonly textureSwell: number;
  /** Share of base texture activity sounding under this field (0.4..0.9). */
  readonly densityShare: number;
  /** Color brightness offset in dB (−2..+1.5). */
  readonly brightnessDb: number;
  /** Slow bed-level bloom in dB (±1.5). */
  readonly bedBloomDb: number;
};

/** Macro epoch length: the world re-voices every 1–4 minutes. */
export const MACRO_EPOCH_SECONDS_MIN = 60;
export const MACRO_EPOCH_SECONDS_MAX = 240;

/** First checkpoint sounds from engine second 0. */
export const MACRO_FIRST_AT_SECONDS = 0;

/**
 * Draws one uniform value for epoch `index` and `salt` from a fork of
 * `rng`: forking never advances the parent, so every epoch's content is
 * a pure function of (seed, index) whichever epoch the caller asks
 * about, and call history can never steer the world. Shared with the
 * harmonic field so both read the one epoch schedule.
 */
export function macroEpochDraw(rng: Rng, index: number, salt: number): number {
  return rng.fork(index * 1013 + salt * 77 + 1).next();
}

/** Epoch length in seconds for epoch `index`: uniform in 60..240 s. */
export function macroEpochLength(rng: Rng, index: number): number {
  const draw = macroEpochDraw(rng, index, 11);
  return MACRO_EPOCH_SECONDS_MIN + draw * (MACRO_EPOCH_SECONDS_MAX - MACRO_EPOCH_SECONDS_MIN);
}

function checkpoint(rng: Rng, index: number, atSeconds: number): MacroState {
  const draw = (salt: number): number => macroEpochDraw(rng, index, salt);
  return {
    atSeconds,
    textureSwell: 0.25 + draw(71) * 0.55,
    densityShare: 0.4 + draw(97) * 0.5,
    brightnessDb: -2 + draw(131) * 3.5,
    bedBloomDb: -1.5 + draw(173) * 3,
  };
}

/**
 * Derives the macro checkpoint active at `nowSeconds` from the injected
 * clock and RNG alone: the nth epoch starts at the cumulative sum of
 * seeded epoch lengths, and epoch n's content comes from a fork by n.
 * Agent traffic is not an input — there is no parameter for it to
 * arrive through. Pure and agent-blind by construction.
 */
export function macroAt(nowSeconds: number, rng: Rng): MacroState {
  const at = Math.max(0, nowSeconds);
  let cursor = MACRO_FIRST_AT_SECONDS;
  let index = 0;
  for (;;) {
    const length = macroEpochLength(rng, index);
    if (at < cursor + length || index > 100_000) {
      return checkpoint(rng, index, cursor);
    }
    cursor += length;
    index += 1;
  }
}

/** Convenience: the checkpoint active at `nowSeconds` for a seed. */
export function macroAtSeed(seed: number, nowSeconds: number): MacroState {
  return macroAt(nowSeconds, createRng(seed));
}

/**
 * First checkpoint boundary strictly after `fromSeconds`: QA starts a
 * render just before it to cover a macro transition inside one render.
 */
export function nextBoundaryAfter(seed: number, fromSeconds: number): number {
  const rng = createRng(seed);
  let cursor = MACRO_FIRST_AT_SECONDS;
  let index = 0;
  for (;;) {
    const length = macroEpochLength(rng, index);
    cursor += length;
    index += 1;
    if (cursor > fromSeconds || index > 100_000) return cursor;
  }
}
