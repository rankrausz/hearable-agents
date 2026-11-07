// packages/audio/src/scenes/clearing/index.ts — the Clearing scene barrel.
// What this is for: the single import surface p3-t03 (gestures) and p3-t06
// (sandbox) consume for scene constants, quantization and voice recipes.
// What it must not do: import Tone or create audio nodes — construction
// stays in graph/ and apply.ts so this module remains import-safe in Node.

export { noteInRegister, quantizeToPentatonic, registerRange } from "./scale.js";
export {
  AIR_BAND_HZ,
  AIR_VOICE,
  BELL_FM,
  CLEARING_KEY,
  DRONE_CUTOFF_HZ,
  DRONE_DETUNE_CENTS,
  DRONE_GAIN_DB,
  DRONE_MIDI,
  DRONE_RECIPE_TRIM_DB,
  DRONE_VIBRATO,
  FATIGUE_BAND_SHARE_MAX,
  FLUTE_RECIPE,
  GLASS_RECIPE,
  HARMONIC_FIELD,
  LANE_PANS,
  LANE_REGISTER_ORDER,
  LANE_REGISTERS,
  LANE_TIMBRES,
  LANE_WIDTH,
  type LaneRegisterName,
  type LaneTimbre,
  MACRO_SWELL_GAIN_DB,
  MASTER_CHAIN,
  NATURE_BED,
  OVERFLOW_CUE,
  PENTATONIC_OFFSETS,
  PULSE_PERIOD_RANGE_S,
  PULSE_PERIOD_RELAXED_S,
  REVERB,
  REVERB_SEND_BASE,
  SAMPLE_START_FADE_S,
  SATURATION,
  STUCK_RATE_FULL_HZ,
  SUSTAINED_TONE_CEILING_HZ,
  VOICE_OUTPUT_TRIM_DB,
} from "./tuning.js";
export {
  BELL_VOICE,
  DRONE_VOICE,
  FLUTE_VOICE,
  GLASS_VOICE,
  hasHarmonicContent,
  MALLET_VOICE,
  PAD_VOICE,
  type VoiceFm,
  type VoiceName,
  type VoiceOscillator,
  type VoiceRecipe,
} from "./voices.js";
