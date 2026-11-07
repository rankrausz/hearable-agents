// Plans event cues as acoustic piano rolls; must preserve pre-emption, spacing and event meaning.
import { panForRegister, recipeForLane } from "../graph/index.js";
import { type CueHarmony, PIANO_CUE_END_S, pianoRoll } from "../piano/chord.js";
import {
  attentionDb,
  CUT_RELEASE_S,
  GESTURE_BUS_ATTACK_S,
  type GestureTrigger,
  type GestureVoiceEvent,
  gestureBusyS,
  QUESTION_BUS_ATTACK_S,
} from "./types.js";
/** Compatibility exports for the named onset contract. Piano starts retain the 5 ms fade. */
export const GESTURE_NOTE_ATTACK_S = 0.005;
export const QUESTION_ONSET_ATTACK_S = 0.005;
export const QUESTION_ONSET_EMPHASIS_DB = 1;
export const ATTENTION_MIN_SPACING_S = 12;

/** One lane's player history: what is sounding and when attention last fired. */

type LanePlayerState = {
  busyUntil: number;
  ringUntil: number;

  lastAttentionAt: number;
};

/** Retains logical timing while allowing recorded strings to ring between events. */
export class GesturePlayer {
  private readonly state: LanePlayerState[] = [];

  /** Pure plans; the live audio boundary owns every source and its release. */
  play(
    trigger: GestureTrigger,
    calm: number,
    world: "lydian" | "dorian" = "lydian",
    tonic = 0,
    harmony?: CueHarmony,
  ): readonly GestureVoiceEvent[] {
    const lane = trigger.laneIndex;

    let state = this.state[lane];
    if (state === undefined) {
      state = {
        busyUntil: Number.NEGATIVE_INFINITY,
        ringUntil: Number.NEGATIVE_INFINITY,
        lastAttentionAt: Number.NEGATIVE_INFINITY,
      };
      this.state[lane] = state;
    }

    const busy = state.busyUntil > trigger.at;

    if (busy && trigger.gesture !== "question") return [];

    if (trigger.gesture === "attention") {
      if (trigger.at - state.lastAttentionAt < ATTENTION_MIN_SPACING_S) return [];

      state.lastAttentionAt = trigger.at;
    }

    state.busyUntil = trigger.at + gestureBusyS(trigger.gesture);
    const ringing = state.ringUntil > trigger.at;
    const offset = ringing ? CUT_RELEASE_S : 0;
    state.ringUntil = trigger.at + offset + PIANO_CUE_END_S[trigger.gesture];

    // Cut the old piano tail before opening the next chord, including question pre-emption.

    const events = [...gestureEvents(trigger, calm, offset, world, tonic, harmony)];

    if (ringing)
      events.unshift({
        kind: "bus",
        laneIndex: lane,
        startS: 0,
        endS: CUT_RELEASE_S,
        from: 1,
        to: 0,
        curve: "linear",
      });

    return events;
  }
}

/** Each rolled note overlaps the next and decays from a soft recorded hammer strike. */
export function gestureEvents(
  trigger: GestureTrigger,
  calm: number,
  startOffsetS = 0,
  _world: "lydian" | "dorian" = "lydian",
  tonic = 0,
  harmony?: CueHarmony,
): readonly GestureVoiceEvent[] {
  const { laneIndex, gesture } = trigger;
  const roll = pianoRoll(gesture, laneIndex, harmony ?? { chord: "Imaj9", tonic, bass: tonic });
  const level = gesture === "attention" ? 0.34 * 10 ** (attentionDb(calm) / 20) : 0.34;
  const end = PIANO_CUE_END_S[gesture];
  return [
    {
      kind: "bus",
      laneIndex,
      startS: startOffsetS,
      endS: startOffsetS + (gesture === "question" ? QUESTION_BUS_ATTACK_S : GESTURE_BUS_ATTACK_S),
      from: 0,
      to: 1,
      curve: "linear",
    },
    ...roll.map((note) => ({
      kind: "note" as const,
      instrument: "piano" as const,
      laneIndex,
      midi: note.midi,
      startS: startOffsetS + note.startS,
      attackS: 0.005,
      holdUntilS: startOffsetS + Math.min(end - 0.65, note.startS + 2.6),
      releaseS: 0.65,
      gain: level * note.touch,
      pan: panForRegister(laneIndex),
      timbre: recipeForLane(laneIndex),
    })),
    {
      kind: "bus",
      laneIndex,
      startS: startOffsetS + end - 0.65,
      endS: startOffsetS + end,
      from: 1,
      to: 0,
      curve: "linear",
    },
  ];
}
