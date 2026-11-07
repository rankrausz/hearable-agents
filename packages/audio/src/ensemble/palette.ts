// packages/audio/src/ensemble/palette.ts — the p5-t01 audition note palette.
// What this is for: the small curated D-centered note set the A/B
// schedulers move between — three candidates per lane register, all inside
// the lane's documented register and quantized to the D pentatonic set, so
// every move is small (adjacent candidates differ by two or three
// semitones), stable in register/timbre, and shares common tones with the
// macro world's pivot/added tones (D/A/E/F#/B). Each set is ANCHORED on the
// pitch the lane's own voice recipe is built at, so a lane's first move is
// a step from where it already sounds. What it must not do: sound anything,
// keep state, touch time/randomness, or leave the scene key — broader
// grammar or key changes need an explicit owner decision (ADR 0021).

import {
  LANE_REGISTER_ORDER,
  LANE_REGISTERS,
  type LaneRegisterName,
  PENTATONIC_OFFSETS,
} from "../scenes/clearing/index.js";

/** D pitch class (MIDI pitch class of the scene key). */
const KEY_PITCH_CLASS = 2;

/**
 * Ordered candidates (low to high) per register; moves step adjacently.
 *
 * Each set is the lane's CONSTRUCTION pitch (voices.ts: pad E2/40, mallet
 * A4/69, flute A5/81) plus its neighbouring scale degrees of the D
 * pentatonic set, inside the lane's register (tuning.ts LANE_REGISTERS).
 * That anchoring is the p5-t01 refinement: the previous sets were chosen
 * for their own internal shape (A2/B2/D3, D4/E4/F#4, A4/B4/D5) and sat 3,
 * 5 and 12 semitones away from where the lanes actually sound, so a lane's
 * FIRST move lurched across that gap before any musical step happened —
 * the owner heard it as a long, surprising transition. Anchored, every
 * move including the first is one scale degree.
 */
const CANDIDATES: Record<LaneRegisterName, readonly number[]> = {
  // D2, E2, F#2 — around the pad's own E2; E2/40 is the start.
  low: [38, 40, 42],
  // E4, F#4, A4 — the mallet's own A4/69 is the register ceiling (mid tops
  // out at 69), so the set reaches down from it; A4 is the start.
  mid: [64, 66, 69],
  // F#5, A5, B5 — around the flute's own A5; A5/81 is the start.
  high: [78, 81, 83],
  upper: [71, 74, 76],
};

/**
 * The pitch each lane's voice recipe is CONSTRUCTED at, by register
 * (voices.ts PAD/MALLET/FLUTE/GLASS_VOICE roots). The palette anchors on these,
 * so `startPitchForLane` is what the graph already sounds before the first
 * move rather than a pitch the lane has to travel to.
 */
const CONSTRUCTION_PITCH: Record<LaneRegisterName, number> = {
  low: 40,
  mid: 69,
  high: 81,
  upper: 74,
};

/** Seat register for a lane index (low/mid/high/upper). */
export function registerForEnsembleLane(laneIndex: number): LaneRegisterName {
  return LANE_REGISTER_ORDER[laneIndex % LANE_REGISTER_ORDER.length] ?? "low";
}

/** Candidate pitches for a lane index, low to high. */
export function candidatesForLane(laneIndex: number): readonly number[] {
  return CANDIDATES[registerForEnsembleLane(laneIndex)];
}

/**
 * Starting pitch per lane: E2 / A4 / A5 / D5 (upper seat) — the pitch the lane's own voice
 * recipe is built at, so the slice starts where the graph already sounds
 * and no move has to close a gap the listener never asked for.
 */
export function startPitchForLane(laneIndex: number): number {
  const register = registerForEnsembleLane(laneIndex);
  const candidates = candidatesForLane(laneIndex);
  const construction = CONSTRUCTION_PITCH[register];
  if (candidates.includes(construction)) return construction;
  return candidates[Math.min(1, candidates.length - 1)] ?? candidates[0] ?? 60;
}

/** Index of a lane's start pitch in its candidate set (−1 if absent). */
export function startIndexForLane(laneIndex: number): number {
  return candidatesForLane(laneIndex).indexOf(startPitchForLane(laneIndex));
}

/**
 * Next candidate after `current` in `direction` (+1 up, -1 down),
 * ping-ponging at the ends so motion stays bounded and never jumps the set.
 * Returns `current` unchanged when it is not a candidate (hold, per ADR 0021:
 * no valid move means hold).
 */
export function stepPitch(laneIndex: number, current: number, direction: 1 | -1): number {
  const candidates = candidatesForLane(laneIndex);
  const at = candidates.indexOf(current);
  if (at === -1) return current;
  const next = at + direction;
  if (next < 0 || next >= candidates.length) return candidates[at - direction] ?? current;
  return candidates[next] ?? current;
}

/** Pitch class of a MIDI note relative to D. */
export function pitchClassRelativeToD(midi: number): number {
  return (((Math.round(midi) - KEY_PITCH_CLASS) % 12) + 12) % 12;
}

/** True when a MIDI note is a member of the D pentatonic set. */
export function isInKey(midi: number): boolean {
  return (PENTATONIC_OFFSETS as readonly number[]).includes(pitchClassRelativeToD(midi));
}

/** True when a MIDI note sits inside the lane's documented register. */
export function isInRegister(midi: number, laneIndex: number): boolean {
  const range = LANE_REGISTERS[registerForEnsembleLane(laneIndex)];
  return midi >= range.root && midi <= range.top;
}

/**
 * Sustained voice pitches for a handover: EVERY pitched voice of the lane
 * (grain pair, the pulse pair an octave down, the tension set) keeps its
 * own offset from the bank root and sounds at the same offset from the
 * move pitch — same type/detune spread and the same octave relations
 * (timbre and voicing untouched), only the base pitch moves old → new.
 * Moving them together is the p5-t01 refinement: retuning the grain pair
 * alone left the pulse and tension layers holding the construction pitch,
 * so every move opened a permanent clash against the lane's own voice
 * (up to 5 semitones) — heard as the lane not being smooth. Pure: the
 * handover retunes the incoming bank's voices to these targets at the
 * move anchor (where that bank's gain is exactly 0) and crossfades the
 * banks on the crossfade class — no frequency ever ramps.
 * p5-t01 slice only; production lanes never retune.
 */
export function voiceFreqsForMove(
  recipeMidi: readonly number[],
  movePitch: number,
): readonly number[] {
  if (recipeMidi.length === 0) return [];
  const root = recipeMidi[0] ?? movePitch;
  return recipeMidi.map((midi) => movePitch + (midi - root));
}

/**
 * Offline sustained-voice proof: renders the lane's grain-voice pair
 * as a sustained tone through the offline gesture renderer — the
 * recipe oscillators at the given MIDI pitches, voiced continuously
 * (long hold, bus left open), so the spectral content centers on the
 * carried pitch. Proves the sustained voice changes across a move:
 * render at the old move pitch and at the new move pitch, and the
 * spectral centroid must move with the pitch. p5-t01 regression
 * surface only; production voicing lives in the graph.
 */
export function sustainedVoiceEventsForPitch(
  laneIndex: number,
  pitch: number,
): readonly import("../gestures/index.js").GestureVoiceEvent[] {
  return [
    {
      kind: "bus",
      laneIndex,
      startS: 0,
      endS: 4.8,
      from: 1,
      to: 1,
      curve: "linear",
    },
    {
      kind: "note",
      laneIndex,
      midi: pitch,
      startS: 0,
      attackS: 0.02,
      holdUntilS: 4,
      releaseS: 0.8,
      gain: ROUTINE_SUSTAIN_GAIN,
      pan: 0,
      timbre: {
        name: "mallet",
        oscillators: [
          { type: "sine", midi: pitch, detuneCents: 0 },
          { type: "triangle", midi: pitch, detuneCents: 4 },
        ],
        lowpassHz: 3200,
      },
    },
  ];
}

/** Gain of the offline sustained-voice proof tone (audible, never a gate). */
export const ROUTINE_SUSTAIN_GAIN = 0.2;
