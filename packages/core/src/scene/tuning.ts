// packages/core/src/scene/tuning.ts — every numeric constant the scene
// mapping uses, in one place. Values are transcribed verbatim from
// docs/SOUND_DESIGN.md §Mapping and docs/STATE_ENGINE.md §Attention model
// (Calm, §Calm) and §Loudness budget (§Attention model); any change must be
// justified against the audio QA numbers, never by feel. This module must
// not import anything: constants only, so the values stay trivially portable
// between daemon and browser.

/** Calm scaling of routine presence: `routine = 1 − 0.6·calm`. */
export const ROUTINE_CALM_SCALE = 0.6;

/** `activityCurve(a) = 0.35 + 0.65·a^0.7`; a quiet lane still exists. */
export const ACTIVITY_CURVE_FLOOR = 0.35;

/** Exponent of the activity curve above. */
export const ACTIVITY_CURVE_EXPONENT = 0.7;

/** Lifecycle gain while the lane is idle (silent). */
export const LIFECYCLE_GAIN_IDLE = 0;

/** Lifecycle gain while the lane is active. */
export const LIFECYCLE_GAIN_ACTIVE = 0.5;

/** Lifecycle gain while the lane is quiet (still working, silent). */
export const LIFECYCLE_GAIN_QUIET = 0.25;

/** Lifecycle gain while the lane is stale. */
export const LIFECYCLE_GAIN_STALE = 0.3;

/** Lifecycle gain while the lane is waiting for the user. */
export const LIFECYCLE_GAIN_WAITING = 0.22;

/**
 * Turn-complete target gain: the lane fades to this linear gain (silence)
 * over TURN_COMPLETE_FADE_SECONDS after resolve.
 */
export const TURN_COMPLETE_TARGET_GAIN = 0;

/** Fade duration of the turn_complete → silence release, in seconds. */
export const TURN_COMPLETE_FADE_SECONDS = 4;

/**
 * Share of the `other` mode weight routed to each of the air and grain
 * layers (no dedicated layer for `other`).
 */
export const OTHER_LAYER_SHARE = 0.5;

/** Stuck-gate depth at struggle 0 (a free phrase: the gate never closes). */
export const STUCK_GATE_MIN = 0;

/** Stuck-gate depth at struggle 1 (the full chop). */
export const STUCK_GATE_MAX = 0.8;

/**
 * Struggle where the stuck re-articulation starts to close: below this the
 * lane sounds free, above it repetition audibly sets in (the texture starts
 * to "stick" from ~0.3 per docs/STATE_ENGINE.md presentation thresholds).
 */
export const STRUGGLE_STUCK_LO = 0.15;

/** Struggle where the stuck re-articulation reaches full depth. */
export const STRUGGLE_STUCK_HI = 0.9;

/** Re-articulation depth at struggle 1: the gate swings 1 → 0.2. */
export const STUCK_GATE_MAX_DEPTH = STUCK_GATE_MAX;

/**
 * Re-articulation rate in Hz with the full pentatonic set: one chop per
 * ~2.5 s — a circling phrase, never a tremolo.
 */
export const STUCK_RATE_FULL_HZ = 0.4;

/**
 * Re-articulation rate in Hz, full AND narrowed sets (revp3t14): one chop
 * per ~2.5 s — a circling phrase, never a tremolo. Held flat across the
 * note-set narrowing on purpose: the QA repetition meter reads lag-4
 * (400 ms) autocorrelation, where 0.4 Hz correlates +0.53 but 0.8 Hz
 * aliases to −0.43, so a rate doubling would invert the rise the gate
 * asserts no matter the depth. Narrowing is expressed through depth
 * 0→0.8 plus the pulse 4 s→2 s contraction only; lane
 * register/timbre/pan never move, so the stuck pattern stays
 * distinguishable from the macro world's own motifs (ADR 0017).
 */
export const STUCK_RATE_NARROW_HZ = 0.4;

/** Pulse swell period in seconds at struggle 0 (free, wandering). */
export const PULSE_PERIOD_RELAXED_S = 4;

/**
 * Pulse swell period in seconds at struggle 1: the swell locks into a
 * smaller, faster cycle — the pattern contracts instead of detuning.
 */
export const PULSE_PERIOD_STUCK_S = 2;

/** Struggle above this narrows the grain note set to a two-note alternation. */
export const STRUGGLE_NARROW_NOTE_SET_THRESHOLD = 0.6;

/** Air cutoff drift range at struggle 0 (wide, free). */
export const AIR_RANGE_WIDE = 1.0;

/** Air cutoff drift range at struggle 1 (narrow, holds its breath). */
export const AIR_RANGE_NARROW = 0.25;

/** Reverb send for the least prominent lane (far). */
export const REVERB_SEND_MIN = 0.65;

/** Reverb send for the most prominent lane (near). */
export const REVERB_SEND_MAX = 0.15;

/** Lane-bus high-shelf gain in dB at prominence 0. */
export const BRIGHTNESS_MIN_DB = -4;

/**
 * Lane-bus high-shelf gain in dB at prominence 1: 3 → 1.5 dB (owner
 * listen 2026-09-30: the foreground lift read as pointy; closeness still
 * comes from the drier send and the wider region).
 */
export const BRIGHTNESS_MAX_DB = 1.5;

/** Stereo width at prominence 0. */
export const WIDTH_MIN = 0.15;

/** Stereo width at prominence 1. */
export const WIDTH_MAX = 0.35;

/** Gain nudge in dB for the single foreground lane. */
export const FOREGROUND_GAIN_NUDGE_DB = 1;

/**
 * Waiting duck in dB: while a lane waits, its own routine air/grain/pulse
 * path yields this far so the question gesture's first note reads against
 * a quiet floor. The tension pad holds the band instead, so waiting stays
 * present while the gesture onset separates from the texture.
 */
export const WAITING_DUCK_DB = 6;

/**
 * Waiting duck at calm 0 in dB (the Calm-invariant duck eases 3.5 → 2 dB
 * across calm 0 → 1): at high Calm the routine floor is already thin, so
 * the duck stays shallow rather than double-ducking toward silence.
 */
export const WAITING_DUCK_AT_CALM0_DB = 3.5;
export const WAITING_DUCK_AT_CALM0 = WAITING_DUCK_AT_CALM0_DB;

/** Master gain slope: `masterGainDb = default − 6 dB·calm`. */
export const CALM_MASTER_GAIN_SLOPE_DB = 6;

/** Density scale slope: `densityScale = 1 − 0.5·calm`. */
export const CALM_DENSITY_SLOPE = 0.5;

/**
 * Calm at or above this with all lanes routine and struggle below
 * NEAR_SILENCE_STRUGGLE_MAX targets near-silence.
 */
export const NEAR_SILENCE_CALM_MIN = 0.8;

/** Struggle below this keeps a routine calm lane eligible for near-silence. */
export const NEAR_SILENCE_STRUGGLE_MAX = 0.3;

/** Bed level in dBFS in the near-silence case. */
export const BED_GAIN_NEAR_SILENCE_DBFS = -40;

/** Bed level in dBFS in the normal case. */
export const BED_GAIN_NORMAL_DBFS = -33;

/** Texture level ceiling in dBFS in the near-silence case. */
export const TEXTURE_NEAR_SILENCE_DBFS = -48;

/**
 * The empty room (owner direction 2026-10-29): with no agent running the
 * scene all but disappears — "extremely minimalistic, even bordering no
 * sound". The drone sits 23 dB under its normal seat, the chord about 26 dB
 * under, the rain about 14 dB under, and the texture swell closes. What is
 * left is a faint room tone that says the app is on, nothing to listen to.
 */
export const EMPTY_ROOM_BED_DBFS = -56;

/** Harmonic-field level scale while no agent is running (about −26 dB). */
export const EMPTY_ROOM_FIELD_SCALE = 0.05;

/** Density scale (nature bed level) while no agent is running (about −14 dB). */
export const EMPTY_ROOM_DENSITY_SCALE = 0.2;

/** Air cutoff brightening with progress: up to +20%. */
export const PROGRESS_CUTOFF_BRIGHTENING = 0.2;

/** Progress above this picks grain notes from the upper half of the register. */
export const PROGRESS_UPPER_REGISTER_THRESHOLD = 0.6;

/**
 * Soft loudness budget: texture gains are soft-normalized so that
 * `Σ texture_i ≤ LOUDNESS_BUDGET_LINEAR` with a soft knee from
 * LOUDNESS_KNEE_LINEAR. Background lanes yield first.
 */
export const LOUDNESS_BUDGET_LINEAR = 1.0;

/** Sum of texture gains where the soft knee starts compressing. */
export const LOUDNESS_KNEE_LINEAR = 0.8;

// ---- Harmonic planner (p5-t02, ADRs 0021/0022) ----
// The owner-selected hybrid direction as product tuning, transcribed from
// the p5-t01 audition prototype (`packages/audio/src/ensemble/schedule.ts`
// and `palette.ts`, record in `docs/SOUND_DESIGN.md`): the same
// values the slice auditioned (DELTA 0.1, window 8 s, hold 15 s, cooldown
// 6 s, one progress move per evidence). Timing values are engine seconds.

/**
 * Minimum smoothed activity/mode delta that counts as a sustained change:
 * the delta must persist across the full eligibility window (harmonic.ts),
 * not spike once — so a burst earns nothing while a genuine drift earns one
 * eligibility.
 */
export const HARMONIC_SUSTAINED_DELTA = 0.1;

/**
 * Eligibility persistence window in seconds: a lane's signal must hold its
 * delta against the window-old baseline for this long before the change
 * earns a move, and sustained re-eligibility is spaced at least this far
 * apart (dedupe — constant traffic never continually earns moves).
 */
export const HARMONIC_ELIGIBILITY_WINDOW_S = 8;

/** Minimum hold per lane in seconds: no lane moves twice inside this window. */
export const HARMONIC_MIN_HOLD_S = 15;

/** Cooldown between routine ensemble moves in seconds: one move at a time. */
export const HARMONIC_COOLDOWN_S = 6;

/** Fresh positive progress evidence earns at most this many moves. */
export const HARMONIC_PROGRESS_EVIDENCE_MOVES = 1;

/**
 * The lane cap: how many seats the scene voices, and so how many lanes the
 * daemon allocates by default (p7b-t03, ADR 0024). Web, QA, replay and the
 * daemon read this one value; sessions beyond it queue, and the queue is
 * announced rather than silent (`docs/SOUND_DESIGN.md` §Seats and
 * allocation). A lane index at or above the cap has no seat.
 */
export const LANE_CAP = 4;

/**
 * Seats the live macro presence is normalised over (p7b-t03): the three
 * seats the macro world was tuned against (p3-t12). Presence is the lanes'
 * summed activity over this count, clamped to 1, so padding a frame with
 * idle seats up to LANE_CAP never dilutes the world, and one to three
 * agents read exactly as they did before the fourth seat existed. A busy
 * fourth agent can only push presence toward its ceiling of 1.
 */
export const MACRO_PRESENCE_SEATS = 3;

/**
 * Curated lane-note candidates (MIDI), indexed by lane role
 * (lane index → seat: low/mid/high/upper, one role per seat up to
 * LANE_CAP). Each set is three D-pentatonic degrees ANCHORED on the pitch
 * its lane voice is constructed at (pad E2/40, mallet A4/69, flute A5/81,
 * glass D5/74 — p7b-t03's fourth seat),
 * one scale degree apart inside the register, so every move including the
 * first is an adjacent 2–3 semitone step. Transcribed from the p5-t01
 * palette; broadening the grammar needs an explicit owner decision.
 */
export const HARMONIC_CANDIDATES: readonly (readonly number[])[] = [
  [38, 40, 42],
  [64, 66, 69],
  [78, 81, 83],
  [71, 74, 76],
];

/**
 * Starting pitch per lane role (MIDI): the construction pitch itself, so
 * the planner starts where the lane already sounds and no first move has
 * to close a gap the listener never asked for.
 */
export const HARMONIC_START_PITCH: readonly number[] = [40, 69, 81, 74];

/**
 * Lane register bounds (MIDI root/top) per lane role, transcribed from the
 * Clearing scene tuning — the planner's `isInRegister` check reads these,
 * never audio state, so core stays import-free.
 */
export const HARMONIC_REGISTER_BOUNDS: readonly (readonly [number, number])[] = [
  [33, 52],
  [52, 69],
  [69, 88],
  [69, 81],
];

// ---- Harmonic field (ADR 0025) ----

/**
 * Calm slope on the harmonic field's level: `1 − 0.5·calm`, the same slope
 * routine density follows, so Calm thins the chord without changing it.
 */
export const FIELD_CALM_SLOPE = 0.5;

/**
 * Presence floor on the field level: a solo agent still gets most of the
 * chord (owner direction D2 — fullness comes from the scene, never from
 * voices that represent nobody); busier scenes fill the rest.
 */
export const FIELD_PRESENCE_FLOOR = 0.7;

/** Field voices that sound while the agents are quiet (presence 0); busy work adds the rest. */
export const FIELD_VOICES_QUIET = 3;

/** Field level scale under near-silence: 20 dB down, under the texture ceiling. */
export const FIELD_NEAR_SILENCE_SCALE = 0.1;

/** D pitch class (MIDI pitch class of the scene key). */
export const HARMONIC_KEY_PITCH_CLASS = 2;

/** D pentatonic pitch classes in semitones above D: D E F# A B. */
export const HARMONIC_PENTATONIC_OFFSETS: readonly number[] = [0, 2, 4, 7, 9];
