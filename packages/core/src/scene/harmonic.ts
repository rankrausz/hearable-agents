// packages/core/src/scene/harmonic.ts — the pure shared harmonic planner.
// What this is for: the owner-selected hybrid direction (ADRs 0021/0022)
// as product logic, connecting smoothed per-lane agent behavior to
// constrained musical movement. Independent world fields stay untouched
// (macro.ts owns them); per-lane eligibility (sustained change or fresh
// progress evidence, with hysteresis, hold and cooldown) stays per-lane;
// musical selection and fair arbitration (one routine transition at a
// time, expiry and coalescing of pending changes) happen here. Holding is
// always permitted, no valid choice means hold, and quiet lanes never get
// fabricated progress. No raw hook-to-note mapping, no new inference.
// What it must not do: I/O, time, randomness, node:* or workspace imports
// (values come from tuning.ts), or read agent identity (LaneSignal carries
// no agent field, so identical trajectories always plan identically).

import type { HarmonicMove, LaneSignal } from "./schema.js";
import {
  HARMONIC_CANDIDATES,
  HARMONIC_COOLDOWN_S,
  HARMONIC_ELIGIBILITY_WINDOW_S,
  HARMONIC_KEY_PITCH_CLASS,
  HARMONIC_MIN_HOLD_S,
  HARMONIC_PENTATONIC_OFFSETS,
  HARMONIC_PROGRESS_EVIDENCE_MOVES,
  HARMONIC_REGISTER_BOUNDS,
  HARMONIC_START_PITCH,
  HARMONIC_SUSTAINED_DELTA,
} from "./tuning.js";

export type { HarmonicMove } from "./schema.js";

/** One smoothed per-lane sample of the signal trajectory the planner reads. */
export type HarmonicSample = {
  /** Lane index the sample belongs to (0-based, in join order). */
  readonly laneIndex: number;
  /** Engine-clock seconds this sample was taken at. */
  readonly atS: number;
  /** The smoothed lane signals at this time. */
  readonly signal: LaneSignal;
};

/** Per-lane planner state across planning steps: eligibility bookkeeping. */
export type HarmonicLaneState = {
  /** Lane index this state belongs to. */
  readonly laneIndex: number;
  /** Highest progress level acknowledged as evidence so far. */
  readonly lastEvidence: number;
  /** Last eligibility time admitted for this lane (dedupe spacing). */
  readonly lastEligibleAt: number | null;
  /** Last planned move time for this lane (hold enforcement). */
  readonly lastMoveAt: number | null;
  /** Pitch the lane carries now (starts at the construction pitch). */
  readonly pitch: number;
  /** Step direction through the candidate set (+1 up, −1 down, ping-pong). */
  readonly direction: 1 | -1;
};

/** Whole-planner state: per-lane eligibility state plus ensemble arbitration. */
export type HarmonicState = {
  /** Per-lane state, keyed by lane index. */
  readonly lanes: ReadonlyMap<number, HarmonicLaneState>;
  /** Last planned ensemble move time (cooldown enforcement). */
  readonly lastEnsembleAt: number | null;
};

/** Planner tuning: engine seconds and move budgets, defaulting to tuning.ts. */
export type HarmonicTuning = {
  readonly sustainedDelta: number;
  readonly eligibilityWindowS: number;
  readonly minHoldS: number;
  readonly cooldownS: number;
  readonly progressMoves: number;
};

/** Default planner tuning: the auditioned hybrid values, verbatim. */
export const HARMONIC_DEFAULT_TUNING: HarmonicTuning = {
  sustainedDelta: HARMONIC_SUSTAINED_DELTA,
  eligibilityWindowS: HARMONIC_ELIGIBILITY_WINDOW_S,
  minHoldS: HARMONIC_MIN_HOLD_S,
  cooldownS: HARMONIC_COOLDOWN_S,
  progressMoves: HARMONIC_PROGRESS_EVIDENCE_MOVES,
};

/** Lane role for a lane index: its seat (low/mid/high/upper), repeating past the cap. */
export function harmonicRole(laneIndex: number): number {
  const roles = HARMONIC_CANDIDATES.length;
  return ((laneIndex % roles) + roles) % roles;
}

/** Candidate pitches for a lane index, low to high. */
export function harmonicCandidates(laneIndex: number): readonly number[] {
  return HARMONIC_CANDIDATES[harmonicRole(laneIndex)] ?? [];
}

/**
 * Starting pitch for a lane: its voice's construction pitch, so the planner
 * starts where the lane already sounds and no first move closes a gap the
 * listener never asked for.
 */
export function harmonicStartPitch(laneIndex: number): number {
  return HARMONIC_START_PITCH[harmonicRole(laneIndex)] ?? 60;
}

/**
 * Next candidate after `current` in `direction` (+1 up, −1 down),
 * ping-ponging at the ends so motion stays bounded and never jumps the set.
 * Returns `current` unchanged when it is not a candidate (hold, per ADR
 * 0021: no valid move means hold) or when the lane has a single candidate.
 */
export function harmonicStepPitch(
  laneIndex: number,
  current: number,
  direction: 1 | -1,
): { readonly pitch: number; readonly direction: 1 | -1 } {
  const candidates = harmonicCandidates(laneIndex);
  const at = candidates.indexOf(current);
  if (at === -1 || candidates.length <= 1) return { pitch: current, direction };
  const next = at + direction;
  if (next < 0 || next >= candidates.length) {
    const turned: 1 | -1 = direction === 1 ? -1 : 1;
    return { pitch: candidates[at + turned] ?? current, direction: turned };
  }
  return { pitch: candidates[next] ?? current, direction };
}

/** Pitch class of a MIDI note relative to D. */
export function harmonicPitchClassRelativeToD(midi: number): number {
  return (((Math.round(midi) - HARMONIC_KEY_PITCH_CLASS) % 12) + 12) % 12;
}

/**
 * True when a MIDI note is a member of the key: the given palette (pitch
 * classes above D — the harmonic field's current chord, ADR 0025
 * amendment) or, without one, the D pentatonic set.
 */
export function harmonicIsInKey(midi: number, palette?: readonly number[]): boolean {
  const pc = harmonicPitchClassRelativeToD(midi);
  if (palette !== undefined) return palette.includes(pc);
  return (HARMONIC_PENTATONIC_OFFSETS as readonly number[]).includes(pc);
}

/** Legal routine steps in semitones: a whole tone or a minor third, never a semitone. */
export const HARMONIC_PALETTE_STEPS: readonly number[] = [2, 3];

/**
 * Steps a lane toward the current chord (ADR 0025 amendment): the nearest
 * in-register pitch of the palette a whole tone or minor third away in
 * `direction`, else in the other direction (flipping it), else hold. The
 * lane sings from the chord the field is playing, and a lane whose note
 * left the chord finds its way back by step.
 */
export function harmonicStepPitchInPalette(
  laneIndex: number,
  current: number,
  direction: 1 | -1,
  palette: readonly number[],
): { readonly pitch: number; readonly direction: 1 | -1 } {
  const legal = (candidate: number): boolean =>
    HARMONIC_PALETTE_STEPS.includes(Math.abs(candidate - current)) &&
    harmonicIsInKey(candidate, palette) &&
    harmonicIsInRegister(candidate, laneIndex);
  for (const dir of [direction, direction === 1 ? -1 : 1] as const) {
    for (const step of HARMONIC_PALETTE_STEPS) {
      const candidate = current + dir * step;
      if (legal(candidate)) return { pitch: candidate, direction: dir };
    }
  }
  return { pitch: current, direction };
}

/** True when a MIDI note sits inside the lane's documented register. */
export function harmonicIsInRegister(midi: number, laneIndex: number): boolean {
  const bounds = HARMONIC_REGISTER_BOUNDS[harmonicRole(laneIndex)];
  const root = bounds?.[0] ?? 0;
  const top = bounds?.[1] ?? 127;
  return midi >= root && midi <= top;
}

/** True while a lane is routine (active or quiet): eligible for moves. */
export function harmonicIsRoutine(lifecycle: LaneSignal["lifecycle"]): boolean {
  return lifecycle === "active" || lifecycle === "quiet";
}

/**
 * Creates fresh planner state for a set of lanes: every lane starts at
 * its construction pitch with no moves held and its current progress
 * level already acknowledged. Acknowledging at creation is what keeps a
 * lane that simply IS progressing from earning a move it did no new work
 * for: only a rise above the creation level counts as fresh evidence.
 * (A lane that joins mid-trajectory via planHarmonicStep gets the same
 * treatment — its first observed level is its baseline, see below.)
 */
export function initialHarmonicState(
  laneIndexes: readonly number[],
  baseline?: ReadonlyMap<number, number>,
): HarmonicState {
  const lanes = new Map<number, HarmonicLaneState>();
  for (const laneIndex of laneIndexes) {
    lanes.set(laneIndex, {
      laneIndex,
      lastEvidence: baseline?.get(laneIndex) ?? 0,
      lastEligibleAt: null,
      lastMoveAt: null,
      pitch: harmonicStartPitch(laneIndex),
      direction: 1,
    });
  }
  return { lanes, lastEnsembleAt: null };
}

/**
 * Registers a lane that joined after planning started: it starts at its
 * construction pitch like every lane, so joining never forces other lanes
 * to retune and a new lane's first move is a step, never a leap.
 */
export function harmonicJoinLane(state: HarmonicState, laneIndex: number): HarmonicState {
  if (state.lanes.has(laneIndex)) return state;
  const lanes = new Map(state.lanes);
  lanes.set(laneIndex, {
    laneIndex,
    lastEvidence: 0,
    lastEligibleAt: null,
    lastMoveAt: null,
    pitch: harmonicStartPitch(laneIndex),
    direction: 1,
  });
  return { lanes, lastEnsembleAt: state.lastEnsembleAt };
}

/**
 * Removes a departed lane's planner state: departures change nothing for
 * the lanes that remain (no forced retune, no borrowed timing).
 */
export function harmonicLeaveLane(state: HarmonicState, laneIndex: number): HarmonicState {
  if (!state.lanes.has(laneIndex)) return state;
  const lanes = new Map(state.lanes);
  lanes.delete(laneIndex);
  return { lanes, lastEnsembleAt: state.lastEnsembleAt };
}

/** L1 (vector) distance between two mode triples. */
function modeVectorDelta(left: LaneSignal["mode"], right: LaneSignal["mode"]): number {
  return (
    Math.abs(left.exploring - right.exploring) +
    Math.abs(left.editing - right.editing) +
    Math.abs(left.testing - right.testing)
  );
}

/**
 * Per-lane eligibility for one sample against its observation trail: a
 * sustained activity/mode change (the changed condition REMAINS valid
 * across the whole eligibility window -- arrival, span and excursion
 * vetoes below -- so a transient spike earns nothing) or fresh positive
 * progress evidence (progress rose above the highest level acknowledged
 * so far). `trail` is the lane's own samples from
 * `[atS - windowS - 1, atS)`, oldest first, EXCLUDING the current sample
 * (one extra sample before the window so the pre-tail excursion veto can
 * consult it). Progress is acknowledged on every path -- a lane that
 * reports while waiting cannot stockpile it into a burst later -- but
 * only routine lanes move. A held level never re-earns; non-routine lanes
 * are never eligible; invalid move targets (a pitch that is not a
 * candidate, the single-candidate lane, a step that goes nowhere) are
 * never eligible either. Spacing stamps only when arbitration actually
 * moves the lane (see planHarmonicStep), so a lane that loses arbitration
 * stays admittable.
 */
function laneEligibility(
  lane: HarmonicLaneState,
  signal: LaneSignal,
  trail: readonly LaneSignal[],
  atS: number,
  tuning: HarmonicTuning,
  obliged = false,
): { readonly times: readonly number[]; readonly next: HarmonicLaneState } {
  let next = lane;
  // Fresh progress evidence is acknowledged even off the routine path, so
  // a lane that reports progress while waiting (or completes and returns)
  // cannot stockpile it into a burst later: the evidence is spent, never
  // queued. Acknowledgement is not eligibility -- only routine lanes move.
  if (signal.progress > next.lastEvidence && signal.progress > 0) {
    next = { ...next, lastEvidence: signal.progress };
  }
  if (!harmonicIsRoutine(signal.lifecycle)) return { times: [], next };
  const admitted: number[] = [];
  const admittable = (at: number): boolean => {
    const last = next.lastEligibleAt;
    if (last !== null && at - last < tuning.eligibilityWindowS) return false;
    const held = at - (next.lastMoveAt ?? Number.NEGATIVE_INFINITY);
    if (held < tuning.minHoldS) return false;
    return true;
  };
  // Sustained change: the window (eight observed samples plus the current
  // one, nine seconds end to end) must read as changed at every scale,
  // and no single sample may be load-bearing. Three probes -- tail
  // (oldest observed), midpoint (half a window before now), young (last
  // observed) -- plus the pre-tail (one before the tail) and the current
  // sample, compared as follows:
  //
  //   arrival:  young changed vs tail (the change is true now; full delta
  //             including the mode-vector rule, so a mode-identity change
  //             with a steady peak still arrives);
  //   span:     midpoint changed vs tail, OR young changed vs tail (the
  //             midpoint probe may sit exactly on the step edge for one
  //             tick -- tolerate it via the young end);
  //   no-blip:  young NOT changed vs midpoint (a blip inside the newer
  //             half shows here);
  //   no-edge:  current NOT changed vs young (a blip at either edge shows
  //             here);
  //   no-tail:  pre-tail (when it exists) NOT changed vs tail (the tail
  //             must be the settled level, not an excursion);
  //   no-next:  tail-successor NOT changed vs current (the sample right
  //             after the tail must already sit at the current level);
  //   no-hot:   tail NOT hotter than both young and current (activity or
  //             peak weight by the auditioned threshold) with young settled
  //             with current -- the leftover-blip veto (see tailHotOutlier;
  //             the symmetric dip side is deliberately left to the
  //             midpoint/current legs, which catch dips at young/current
  //             while a dip-recovery tail that still shows arrival IS a
  //             sustained level move and may earn).
  //
  // A genuine drift holds arrival+span with every veto quiet from the
  // first tick where the window fills behind it. All legs read the
  // auditioned DELTA (scalar halves plus the vector rule on arrival/span;
  // activity/dominant scalars on the hot-tail veto) -- no new signal, no
  // new threshold, no inference.
  if (admittable(atS)) {
    // All probes index from the YOUNG end, so the halves stay aligned
    // however long the warmup trail has grown.
    const size = windowSamples(tuning);
    const half = Math.max(1, Math.floor(size / 2));
    const settled = trail.length >= size;
    const tail = trail[Math.max(0, trail.length - size)] ?? null;
    const midpoint = trail[Math.max(0, trail.length - half)] ?? null;
    const young = trail[trail.length - 1] ?? null;
    const preTail = trail.length > size ? (trail[trail.length - size - 1] ?? null) : null;
    const tailNext = trail[Math.max(0, trail.length - size) + 1] ?? null;
    const arrived = tail !== null && young !== null && changedFrom(tail, young, tuning);
    const remains =
      tail !== null &&
      midpoint !== null &&
      young !== null &&
      tailNext !== null &&
      (changedFrom(tail, midpoint, tuning) || changedFrom(tail, young, tuning)) &&
      !changedFrom(midpoint, young, tuning) &&
      !changedFrom(signal, young, tuning) &&
      (preTail === null || !changedFrom(preTail, tail, tuning)) &&
      !changedFrom(tailNext, signal, tuning) &&
      !tailHotOutlier(tail, young, signal, tuning);
    if (settled && arrived && remains) {
      admitted.push(atS);
    }
  }
  if (signal.progress > lane.lastEvidence && signal.progress > 0) {
    for (let m = 0; m < tuning.progressMoves; m += 1) {
      if (admittable(atS) && !admitted.includes(atS)) admitted.push(atS);
    }
  }
  // Voice-leading obligation (ADR 0025 amendment): a lane whose note fell
  // out of the chord earns a move on its own, inside the same hold and
  // spacing every other move respects — the harmony moved under it.
  if (obliged && admittable(atS) && !admitted.includes(atS)) admitted.push(atS);
  return { times: admitted, next };
}

/**
 * Window length in samples at the caller's 1 Hz tick: the trail must hold
 * this many OBSERVED samples (strictly before now) before a sustained
 * delta counts — the changed condition remains valid across the whole
 * window, never just its endpoints.
 */
function windowSamples(tuning: HarmonicTuning): number {
  return Math.max(1, Math.round(tuning.eligibilityWindowS));
}

/**
 * True when the window tail is a leftover spike-from-above the rest of
 * the window has recovered from: the tail activity/dominant weight lies
 * strictly HOTTER than both the young end and the current sample (by the
 * auditioned threshold) while the young end has settled with current (no
 * delta between them). Blip t=20..22: tail hot vs young/current settled:
 * veto. Drift t=14: tail old vs young/current new -- tail colder, not
 * hotter: pass. Drift t=18 (tail slid to new): inside the band: pass.
 * Deltas and direction of the ALREADY-AUDITIONED signals only -- no new
 * signal, no new threshold, no inference.
 */
function tailHotOutlier(
  tail: LaneSignal,
  young: LaneSignal,
  signal: LaneSignal,
  tuning: HarmonicTuning,
): boolean {
  if (!harmonicIsRoutine(tail.lifecycle)) return false;
  const settled = !changedFrom(young, signal, tuning) && !changedFrom(signal, young, tuning);
  if (!settled) return false;
  const activityHot =
    tail.activity - young.activity >= tuning.sustainedDelta &&
    tail.activity - signal.activity >= tuning.sustainedDelta;
  const peak = (mode: LaneSignal["mode"]): number => dominantWeight(mode);
  const dominantHot =
    peak(tail.mode) - peak(young.mode) >= tuning.sustainedDelta &&
    peak(tail.mode) - peak(signal.mode) >= tuning.sustainedDelta;
  return activityHot || dominantHot;
}

/**
 * True when `sample` shows a sustained-change delta against `reference`:
 * both endpoints routine with an activity, dominant-mode or mode-vector
 * (L1, twice the scalar threshold) delta at or above threshold.
 */
function changedFrom(reference: LaneSignal, sample: LaneSignal, tuning: HarmonicTuning): boolean {
  if (!harmonicIsRoutine(reference.lifecycle) || !harmonicIsRoutine(sample.lifecycle)) {
    return false;
  }
  const activityDelta = Math.abs(sample.activity - reference.activity);
  const dominantDelta = Math.abs(dominantWeight(sample.mode) - dominantWeight(reference.mode));
  const vectorDelta = modeVectorDelta(sample.mode, reference.mode);
  return (
    activityDelta >= tuning.sustainedDelta ||
    dominantDelta >= tuning.sustainedDelta ||
    vectorDelta >= tuning.sustainedDelta * 2
  );
}

/** Highest of the exploring/editing/testing weights. */
function dominantWeight(mode: LaneSignal["mode"]): number {
  return Math.max(mode.exploring, mode.editing, mode.testing);
}

/**
 * Plans one step: folds a frame of per-lane samples (all at `atS`) into
 * planner state, arbitrates newly eligible lanes into at most one move,
 * and returns the updated state plus that move (or null when nothing moves
 * — holding is the common case). Deterministic: the same initial state,
 * timestamped signal trajectory, seed and engine times always plan the
 * same moves, however the caller slices frames into ticks, seeks, or
 * replays at another speed — every decision reads sample timestamps and
 * stored planner state only, never tick timing. Starvation-free: among
 * lanes eligible at the same time the lane that moved least recently
 * wins (never-moved first, lowest index only as the final deterministic
 * tie-break), so recurring simultaneous eligibility rotates instead of
 * pinning the lowest lane. Losing arbitration costs nothing — spacing
 * stamps only when a move actually happens, so the loser stays admittable
 * while its evidence persists. Pending eligibility that falls inside a
 * hold or the ensemble cooldown expires (dropped, never queued), so
 * bursts coalesce instead of backlog-starving quiet lanes.
 *
 * `history` is the window trail the eligibility rule reads: a
 * caller-supplied map from lane index to that lane's own samples from
 * `[sample.atS - eligibilityWindowS - 1, sample.atS)`, oldest first (or
 * absent when the lane has no samples that old yet) -- one extra sample
 * before the window so the pre-tail excursion veto can consult it. The
 * planner never interpolates: without a trail the sustained-change half
 * abstains, while the fresh-progress half still answers -- progress
 * evidence is point-in-time, not windowed.
 */
export function planHarmonicStep(
  state: HarmonicState,
  frame: readonly HarmonicSample[],
  history: ReadonlyMap<number, readonly LaneSignal[]>,
  options?: {
    readonly atS?: number;
    readonly seed?: number;
    readonly tuning?: Partial<HarmonicTuning>;
    /**
     * The chord to sing from, as pitch classes above D (the harmonic
     * field's current palette). With it, steps land on chord tones and a
     * lane whose note left the chord is obliged to move; without it the
     * curated pentatonic triples apply.
     */
    readonly palette?: readonly number[];
  },
): { readonly state: HarmonicState; readonly move: HarmonicMove | null } {
  const tuning: HarmonicTuning = { ...HARMONIC_DEFAULT_TUNING, ...options?.tuning };
  const palette = options?.palette;
  void options?.atS;
  void options?.seed;
  type Candidate = { readonly laneIndex: number; readonly atS: number };
  const candidates: Candidate[] = [];
  const lanes = new Map(state.lanes);
  const ordered = [...frame].sort((a, b) => a.laneIndex - b.laneIndex);
  for (const sample of ordered) {
    const known = lanes.get(sample.laneIndex);
    // A lane the caller never registered joins now at its construction
    // pitch with its first observed progress already acknowledged:
    // joining never retunes the lanes already here, and never earns a
    // move for progress it did no new work for.
    const lane =
      known ??
      initialHarmonicState(
        [sample.laneIndex],
        new Map([[sample.laneIndex, sample.signal.progress]]),
      ).lanes.get(sample.laneIndex);
    if (lane === undefined) continue;
    const obliged = palette !== undefined && !harmonicIsInKey(lane.pitch, palette);
    const { times, next } = laneEligibility(
      lane,
      sample.signal,
      history.get(sample.laneIndex) ?? [],
      sample.atS,
      tuning,
      obliged,
    );
    lanes.set(sample.laneIndex, next);
    for (const at of times) candidates.push({ laneIndex: sample.laneIndex, atS: at });
  }
  // Fair rotation: least recently moved first (never-moved before moved),
  // lowest lane index only as the final deterministic tie-break — so a
  // lane that keeps losing ties eventually becomes the longest-waiting
  // and wins, instead of the lowest index winning every tie forever.
  const movedAt = (laneIndex: number): number =>
    lanes.get(laneIndex)?.lastMoveAt ?? Number.NEGATIVE_INFINITY;
  candidates.sort(
    (a, b) =>
      a.atS - b.atS || movedAt(a.laneIndex) - movedAt(b.laneIndex) || a.laneIndex - b.laneIndex,
  );
  let lastEnsembleAt = state.lastEnsembleAt;
  let move: HarmonicMove | null = null;
  for (const candidate of candidates) {
    if (move !== null) break;
    if (candidate.atS - (lastEnsembleAt ?? Number.NEGATIVE_INFINITY) < tuning.cooldownS) continue;
    const lane = lanes.get(candidate.laneIndex);
    if (lane === undefined) continue;
    const held = candidate.atS - (lane.lastMoveAt ?? Number.NEGATIVE_INFINITY);
    if (held < tuning.minHoldS) continue;
    const stepped =
      palette === undefined
        ? harmonicStepPitch(candidate.laneIndex, lane.pitch, lane.direction)
        : harmonicStepPitchInPalette(candidate.laneIndex, lane.pitch, lane.direction, palette);
    if (stepped.pitch === lane.pitch) continue;
    if (
      !harmonicIsInKey(stepped.pitch, palette) ||
      !harmonicIsInRegister(stepped.pitch, candidate.laneIndex)
    ) {
      continue;
    }
    move = {
      laneIndex: candidate.laneIndex,
      atS: round2(candidate.atS),
      pitch: stepped.pitch,
      fromPitch: lane.pitch,
    };
    lanes.set(candidate.laneIndex, {
      ...lane,
      lastEligibleAt: candidate.atS,
      lastMoveAt: candidate.atS,
      pitch: stepped.pitch,
      direction: stepped.direction,
    });
    lastEnsembleAt = candidate.atS;
  }
  return { state: { lanes, lastEnsembleAt }, move };
}

/**
 * Plans a whole trajectory: folds timestamped frames in ascending time
 * order and returns the final state plus every planned move. Frames must
 * arrive in ascending timestamp order with at most one sample per lane
 * per frame (the live tick shape); frame SIZE is advisory — the same
 * samples sliced into different per-tick frames plan the same moves,
 * which the lane-determinism tests prove by re-slicing one trajectory
 * several ways. (Batching several ticks of one lane into a single frame
 * folds them in array order within one arbitration step, which can merge
 * separate ticks' eligibility — callers keep one tick per frame.)
 */
export function planHarmonicTrajectory(
  initial: HarmonicState,
  frames: readonly (readonly HarmonicSample[])[],
  historyFor: (laneIndex: number, atS: number) => readonly LaneSignal[],
  options?: { readonly seed?: number; readonly tuning?: Partial<HarmonicTuning> },
): { readonly state: HarmonicState; readonly moves: readonly HarmonicMove[] } {
  let state = initial;
  const moves: HarmonicMove[] = [];
  for (const frame of frames) {
    const history = new Map<number, readonly LaneSignal[]>();
    for (const sample of frame) {
      history.set(sample.laneIndex, historyFor(sample.laneIndex, sample.atS));
    }
    const step = planHarmonicStep(state, frame, history, options);
    state = step.state;
    if (step.move !== null) moves.push(step.move);
  }
  return { state, moves };
}

/** Rounds a plan time to centiseconds (deterministic plan times). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
