// packages/audio/src/scenes/clearing/tuning.ts — the Clearing scene's
// musical constants. What this is for: the single transcription of
// docs/SOUND_DESIGN.md §Scene Clearing (key, pentatonic set, drone pitch and
// filter, lane registers, timbres, pans, width) and §Fatigue rules 2–3 (the
// 2–5 kHz guard band and the no-pure-sines rule) that graph construction
// reads. What it must not do: import Tone, touch time or randomness, or
// decide anything audible — values come from the sound design doc, and any
// change needs a `needs-ear` human gate.

/** The scene key: every pitched element is quantized to this set. */
export const CLEARING_KEY = "D" as const;

/**
 * D pentatonic pitch classes in semitones above D: D E F# A B.
 * Indexed 0–4; quantization wraps octaves, never leaves the set.
 */
export const PENTATONIC_OFFSETS = [0, 2, 4, 7, 9] as const;

/** MIDI note numbers for D2 and D3, the drone pair. */
export const DRONE_MIDI = { low: 38, high: 50 } as const;

/** Detune applied to each drone oscillator, in cents (±1 since 2026-10-29; ±3 beat audibly). */
export const DRONE_DETUNE_CENTS = 1;

/** Drone low-pass cutoff in Hz: the floor the mix rests on. */
export const DRONE_CUTOFF_HZ = 400;

/**
 * Slow detune drift per drone oscillator (see HARMONIC_FIELD.vibrato):
 * the static ±3 cent spread is applied to frequency; the drift rides the
 * detune param so the pairs never beat on one fixed period.
 */
export const DRONE_VIBRATO = { depthCents: 1, ratesHz: [0.05, 0.073, 0.091, 0.117] } as const;

/** Drone level in dB: quiet by design. */
export const DRONE_GAIN_DB = -33;

/**
 * Static trim on the drone chain that seats the sine/triangle recipe
 * (2026-09-30) at the level the four low-passed saws measured: below
 * 400 Hz the saws carried about 3.2 dB less energy than sines and
 * triangles at the same amplitude (near-silence read −40.8 → −38.4 dBFS on
 * the recipe change alone, and −40.0 with a first −2.4 dB trim). The bed's
 * planned gains are unchanged.
 */
export const DRONE_RECIPE_TRIM_DB = -3.2;

/**
 * Macro texture-swell level (p3-t12): the swell peaks at −36 dBFS of
 * linear swell share, a floor the lanes inhabit.
 */
export const MACRO_SWELL_GAIN_DB = -36;

/**
 * The harmonic field's voice (ADR 0025): six slow pad voices behind the
 * lanes, the chord core's `fieldAt` plans. Each slot is two banks of a
 * saw+triangle pair (pitch changes hand over between banks, never bend),
 * through one shared low-pass the checkpoint brightness drives, into its
 * own slow breath LFO (dynamics as harmony: which tone leads changes on
 * its own 23–53 s cycle), a fixed pan inside the centre of the image, the
 * field seat gain and a share into the shared reverb. The seat is the
 * level of the whole chord at field gain 1; core scales it with Calm,
 * presence and near-silence. Detune follows the interval class the way a
 * choir tunes: roots and fifths lock, colour tones shimmer, extensions
 * shimmer more.
 */
export const HARMONIC_FIELD = {
  /**
   * Seat of the whole chord in dBFS at field gain 1, before Calm. Measured
   * on the routine three-lane mix (2026-09-30, v2 voices): at −18 the
   * chord read about −25.5 dBFS in that mix, 2 dB above the lane texture
   * (routine −27.5 → −23.4). Those first reads were mostly drone (the
   * solo render was not muting the bed); with the solo fixed, −30 read
   * −34.9 dBFS field alone against a −27.5 lane texture. −28 seats the
   * chord about 5 dB under the lanes — behind the soloist, not beneath
   * notice.
   */
  seatDb: -28,
  /** Share into the shared reverb: the chord lives in the room, behind the lanes. */
  reverbSend: 0.5,
  /** Fixed pan per slot: centre-weighted, never a lane's seat. */
  pans: [0, -0.28, 0.28, -0.14, 0.14, 0],
  /** Silent construction pitch per slot, inside its window (D3 D4 F#4 A4 D5 A5). */
  constructionMidi: [50, 62, 66, 69, 74, 81],
  /** Breath LFO period per slot in seconds (mutually prime-ish, never in step). */
  breathPeriodsS: [37, 29, 43, 23, 53, 31],
  /** Breath LFO floor: a voice never breathes below this share of its level. */
  breathFloor: 0.6,
  /**
   * Per-oscillator detune in cents by interval class. Zero since the owner
   * listen of 2026-10-29 ("all kinds of vibrations"): each voice is one
   * sine, so there is no pair to spread. Kept as data so the interval-class
   * tuning can return if the ear asks for more life.
   */
  detuneCents: { stable: 0, colour: 0, extension: 0 },
  /**
   * Ceiling on any field pair's beat rate in Hz (owner listen 2026-10-29):
   * the interval-class spread above is cut wherever it would beat faster,
   * so the upper voices shimmer instead of trembling. The drift depth is
   * cut the same way per slot.
   */
  maxBeatHz: 0.6,
  /**
   * Slow, independent detune drift per oscillator (±cents at rates no two
   * of which are in step): two equally detuned copies beat at full depth
   * on a fixed period — a mechanical wobble the struggle-ramp regularity
   * meter read as periodic and an ear reads as seasick. Drifting each
   * copy on its own slow cycle turns the beat into the aperiodic shimmer
   * of many voices. Rate per slot; each oscillator in a bank takes the
   * next rate along.
   */
  vibrato: {
    // 3 → 1 cent (owner listen 2026-10-29): a slow breath of pitch, not a wobble.
    depthCents: 1,
    ratesHz: [0.11, 0.17, 0.23, 0.13, 0.19, 0.29, 0.07, 0.31],
  },
  /**
   * Voice recipe per bank: a detuned sine pair with a quiet triangle an
   * octave up — a soft, choral spectrum, nothing reedy (the saw+triangle
   * pair the owner heard as bagpipes). The partial's share is a static
   * gain inside the bank.
   */
  partialSemitones: 12,
  partialShare: 0.22,
  /**
   * The vowel stage (owner listen 2026-10-29, "more natural"): two
   * band-passes near the formants of a sung "oo/oh" (about 450 Hz and
   * 1 kHz) beside the field low-pass give the chord a soft vocal body. The
   * quiet sawtooth that fed it was dropped the same day as buzz.
   */
  choir: {
    formants: [
      { hz: 450, q: 2.2, gain: 0.9 },
      { hz: 1000, q: 3, gain: 0.45 },
    ],
  },
  /**
   * Bloom notes (owner listen 2026-09-30: the field needs moments, not only
   * a wash): a slow-swelling tone on a chord tone in C5–C6 through the
   * field seat and reverb. The 0.5 s swell is what keeps it from reading
   * as an agent gesture — every gesture is articulated, a bloom never is.
   */
  ping: {
    /** Pool size: blooms are at least 15 s apart and last about 7 s, two never overlap. */
    voices: 2,
    attackS: 0.5,
    holdS: 0.4,
    releaseS: 6,
    /** Peak gain relative to the field seat at level 1. */
    peak: 0.5,
    // 3600 → 2600 Hz (owner listen 2026-10-29): the twelfth of a C6 bloom
    // sat in the 2–5 kHz band the ear tires of first.
    lowpassHz: 2600,
    /** Partials above the fundamental: octave and twelfth, as gain shares. */
    partials: [
      { semitones: 12, share: 0.35 },
      { semitones: 19, share: 0.15 },
    ],
  },
  /**
   * The second bloom timbre (owner listen 2026-09-30): a glassier stack —
   * octave and double octave — with a shorter swell
   * and a longer, brighter tail, quieter than the pad bloom. Blooms
   * alternate: even ids take the pad bloom, odd ids the glass.
   */
  pingGlass: {
    voices: 2,
    attackS: 0.3,
    holdS: 0.2,
    releaseS: 8,
    peak: 0.26,
    // 5200 → 3000 Hz and no fifth above the double octave (owner listen
    // 2026-10-29): the top partial reached 6 kHz and read as a needle.
    lowpassHz: 3000,
    partials: [
      { semitones: 12, share: 0.35 },
      { semitones: 24, share: 0.12 },
    ],
  },
} as const;

/**
 * Per-seat register in MIDI note numbers, stable while the lane is live
 * (docs/SOUND_DESIGN.md §Seats and allocation). `upper` is the fourth seat
 * (p7b-t03, ADR 0024): A4–A5, inside the high seat's lower octave and
 * touching the mid seat only at A4.
 */
export const LANE_REGISTERS = {
  low: { root: 33, top: 52 },
  mid: { root: 52, top: 69 },
  high: { root: 69, top: 88 },
  upper: { root: 69, top: 81 },
} as const;

export type LaneRegisterName = keyof typeof LANE_REGISTERS;

/**
 * Lane index → seat: 0/1/2/3 back low/mid/high/upper. This is identity, not
 * allocation order — the daemon hands seats out centre-first (p7b-t02); a
 * lane index always resolves to the same seat. Its length is the lane cap
 * (core LANE_CAP; a test pins the two together).
 */
export const LANE_REGISTER_ORDER: readonly LaneRegisterName[] = ["low", "mid", "high", "upper"];

/** Timbre per lane register, per the framework table. */
export const LANE_TIMBRES = {
  low: "pad",
  mid: "mallet",
  high: "flute",
  upper: "glass",
} as const;

export type LaneTimbre = (typeof LANE_TIMBRES)[LaneRegisterName];

/**
 * Lane C (high) flute recipe shaping (p3-t13 replaces the FM bell): the
 * breath-noise share per note and the legato attack in seconds.
 */
export const FLUTE_RECIPE = {
  breathShare: 0.12,
  attackS: 0.35,
  // 2800 → 2200 Hz (owner listen 2026-09-30): less pointy, still a flute.
  lowpassHz: 2200,
} as const;

/**
 * Lane C (high) legacy FM bell shaping, retired by p3-t13 (kept for
 * reference only — construction reads FLUTE_VOICE instead).
 */
export const BELL_FM = {
  harmonicity: 1,
  modulationIndex: 1.5,
  modulationType: "sine",
} as const;

/**
 * Voice output trim in dB per lane register (mix-calibration tuning, not
 * timbre): seats the three lanes' sustained energy per unit layer gain.
 * Applied in the graph builder as a static voice gain; every move stays
 * on the declared ramps. p3-t13 seats the new pad/mallet/flute material:
 * low −2 (the low pad carries the most sustained energy), mid 0 (the
 * p3-t09 seat — the mid mallet wins the gated window-1 diagonal in raw
 * RMS and loudness without lifting the near-silence floor), high −4
 * (the flute breath adds HF energy the old bell never had). Routine
 * level and the near-silence floor are owned by these trims plus the
 * shared-air parking (silent lanes park the air); nothing here moves.
 *
 * revp3t14 re-seat (+5.4 dB all lanes, measured in three steps): the
 * p3-t14 Tremolo insert costs ~4.2 dB of mean grain energy at low
 * struggle (the effect passes the path through its series gain staging
 * even at depth 0 — measured −27.9 at {−6.5,−5.5,−10.5} vs −26.6
 * pre-insert at {−9,−8,−13}, −27.6 at {−6,−5,−10} after the
 * amplitude→Tremolo rework, −26.7 at {−4.8,−3.8,−8.8}). The correction
 * restores the seat (routine → −25.7, inside −26…−20; near-silence
 * −39.7, 0.3 dB over the −40 line — owned remainder, see below);
 * the semantic mapping is untouched — presence, duck, stuck
 * depth/rate and calm-compensation all plan the same targets.
 *
 * Owned remainder (revp3t14): the +5.4 dB re-seat that centers routine
 * (−25.7) pushes near-silence 0.3 dB over its line (−39.7 vs −40, bed
 * −44.3 / texture −41.6 — the texture estimate carries the miss). A
 * per-register re-balance (not a uniform lift) belongs to the voice
 * owner (p3-t13/p3-t02); lowering the uniform lift would push routine
 * back out of its gate.
 */
export const VOICE_OUTPUT_TRIM_DB = {
  low: -3.6,
  mid: -2.6,
  high: -7.6,
  // p7b-t03 fourth seat, seated 2 dB under the flute it shares a register
  // with: it adds a second centre voice, so it takes level rather than
  // asking for any (the budget takes, it does not give). The three
  // existing trims are not re-seated — lanes 0–2 are byte-unchanged
  // (before → after: low −3.6 → −3.6, mid −2.6 → −2.6, high −7.6 → −7.6).
  upper: -9.6,
} as const;

/**
 * Stereo pan per seat: low left, mid centre, high right. The upper seat
 * shares centre with mid and is told apart from it by register; see
 * docs/SOUND_DESIGN.md §Seats and allocation for why no lateral place works.
 */
export const LANE_PANS = { low: -0.6, mid: 0, high: 0.6, upper: 0 } as const;

/**
 * Upper seat glass recipe shaping (p7b-t03): the low-pass sits under the
 * flute's 2800 Hz so the struck family the scene retired as too bright at
 * length (p3-t13) comes back dark, and the octave partial is the one
 * even-harmonic spectrum in the table — what tells glass from flute once
 * the image is summed to mono.
 */
export const GLASS_RECIPE = {
  constructionMidi: 74,
  partialSemitones: 12,
  partialDetuneCents: 3,
  // 2400 → 2000 Hz (owner listen 2026-09-30): darker glass.
  lowpassHz: 2000,
} as const;

/** Stereo width of each lane region: a region, not a point. */
export const LANE_WIDTH = 0.2;

/**
 * Announced-overflow cue (p7b-t03, owner choice batched into p7b-t05): one
 * soft open fifth on the drone's own D3 plus A3, centre, pure sines under
 * a dark low-pass — the room acknowledging an agent it cannot seat, never
 * a seat's timbre, so it cannot be heard as a lane. Simultaneous, not the
 * ascending D→A of `arrive`. Enters and leaves on linear ramps (no step),
 * peaks ~13 dB under a gesture note, and fires at most once per spacing
 * window however many sessions queue. Nothing sustained.
 */
export const OVERFLOW_CUE = {
  midi: [50, 57],
  detuneCents: [-3, 3],
  lowpassHz: 1200,
  attackS: 0.12,
  holdS: 0.5,
  releaseS: 1.8,
  peakGain: 0.05,
  reverbShare: 0.3,
  minSpacingS: 30,
} as const;

/**
 * Air band-pass range in Hz: pink noise through 500–2200 Hz (owner listen
 * 2026-09-30: the 800–3000 Hz band read as hiss; lower and narrower is
 * breath, not steam). The exploring mode keeps its identity by band.
 */
export const AIR_BAND_HZ = { low: 500, high: 2200 } as const;

/**
 * Shared high-frequency air (p3-t13): one faint filtered-noise shimmer
 * above the lanes — band-passed air plus a breath of harmonics from the
 * lane voices, never an exposed bright tone. Centre-panned so it adds
 * height, never identity. The static level sits 20 dB under any voice
 * seat — a shimmer the near-silence gate never hears.
 */
export const AIR_VOICE = {
  bandHz: { low: 6000, high: 9000 },
  gainDb: -60,
} as const;

/** Pulse period range in seconds: a slow low swell. */
export const PULSE_PERIOD_RANGE_S = { min: 2, max: 4 } as const;

/**
 * Pulse swell period with the texture free (p3-t14, ADR 0019): the lane's
 * own cycle wanders slowly — re-exported from core tuning so the graph
 * starts on the mapped voice.
 */
/** Stuck-gate rate with the full pentatonic set (a circling phrase). */
export { PULSE_PERIOD_RELAXED_S, STUCK_RATE_FULL_HZ } from "@hearable/core";

/**
 * Shared reverb: plate-ish, 6.5 s decay, 30 ms pre-delay (owner listen
 * 2026-09-30: a longer room, more Endel than sandbox).
 */
export const REVERB = { decayS: 6.5, preDelayS: 0.03 } as const;

/**
 * Convolution decision (p3-t13, ADR 0017 space requirement — recorded in
 * ASSETS.md): evaluated, not shipped. Tone 15.1.22 generates the shared
 * Reverb impulse asynchronously inside Tone.Offline, and every QA render
 * is already `await reverb.ready` inside the same Offline context; a
 * sampled convolution IR would need its own buffered-Convolver path with
 * async decode inside Offline plus a CC0 IR asset inside the size budget
 * — a live/QA lifecycle the current harness does not cover. The shared
 * generated-IR reverb stays the believable shared space; a
 * sampled-convolution upgrade belongs to a task that also owns the
 * Offline-ready asset path.
 */

/**
 * Nature bed (p3-t15, ADR 0017 — sampled material alongside synthesis):
 * one low sampled nature texture under the Clearing mix. Soft rain seats
 * better than wind/leaves here: the scene's air band (800–3000 Hz) and
 * macro swell already carry airy motion, so a leafy high-frequency bed
 * would double the band the fatigue rule guards; rain's dense broadband
 * murmur sits below the lanes without a competing spectral home. The
 * bed file is listed with source and licence in ASSETS.md BEFORE use,
 * inside the ≤ 512 KB budget — the constants below only seat it.
 */
export const NATURE_BED = {
  /** Bundled WAV filename, served under the web build's asset path. */
  assetFile: "nature-bed-soft-rain-12s.wav",
  /** Loop length in seconds (the asset's own duration). */
  loopDurationS: 12,
  /** Bed seat in dBFS: 11 dB under the −33 dBFS drone, below the texture. */
  gainDb: -44,
  /** High-pass in Hz: keeps the sampled low end off the drone's floor. */
  highpassHz: 400,
  /** Low-pass in Hz: keeps the bed below the air band it must not double. */
  lowpassHz: 5000,
  /** Slow crossfade window between the two loop voices in seconds. */
  crossfadeS: 6,
  /** Fade applied to every player start in seconds (fatigue rule 6). */
  startFadeS: 0.05,
  /** QA seed for the deterministic slow-variation schedule. */
  seed: 161,
} as const;

/**
 * Shared-reverb send base: plan targets are 0..1 shares of this wet gain.
 * Mix-calibration tuning (0.5 → 0.25, −6.0 dB wet energy); the reverbSend
 * mapping order is unchanged.
 */
export const REVERB_SEND_BASE = 0.3;

/** Master chain: gentle 2:1 compressor at −24 dBFS, limiter at −6 dBFS. */
export const MASTER_CHAIN = {
  compressorThresholdDb: -24,
  compressorRatio: 2,
  limiterThresholdDb: -6,
} as const;

/**
 * Master bus saturation (p3-t13): one gentle tanh waveshaper on the
 * master path, before the compressor — a soft odd-symmetric knee that
 * takes the sterile digital edge off without touching a level. tanh is
 * odd-symmetric by construction, so its mean is exactly zero (no DC;
 * the fatigue bound is 0.01). The driveCurve helper in graph/builder.ts
 * builds the curve; the drive below sets the knee sharpness. Applied as
 * a static shaper; every move stays on the declared ramps. The wet
 * share voices the effect: 0.5 keeps the warmth audible at the low
 * p3-t13 voice seats without lifting the near-silence floor.
 */
export const SATURATION = {
  drive: 0.15,
  wet: 0.5,
} as const;

/** No sustained tone above this frequency in Hz (fatigue rule 2). */
export const SUSTAINED_TONE_CEILING_HZ = 6000;

/** Energy share cap for the 2–5 kHz band (fatigue rule 2). */
export const FATIGUE_BAND_SHARE_MAX = 0.15;

/** Fade applied to every sample start in seconds (fatigue rule 6). */
export const SAMPLE_START_FADE_S = 0.005;
