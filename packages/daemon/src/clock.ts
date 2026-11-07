// packages/daemon/src/clock.ts — the daemon's clock type. What this is for:
// giving ingest, lanes and the broadcaster one injectable time source so tests
// and (from p1-t06) the replayer can drive time deterministically instead of
// depending on the wall clock, mirroring docs/ARCHITECTURE.md §Time. What it
// must not do: read Date.now() itself — callers pass the implementation, and
// the default (Date.now) is the caller's choice, never a daemon core import of
// Date.now inside a supposedly-redistributable pure path.

/** Returns the current daemon time in milliseconds since the epoch. */
export type Clock = () => number;

/** The live wall-clock implementation used when no clock is injected. */
export const wallClock: Clock = () => Date.now();
