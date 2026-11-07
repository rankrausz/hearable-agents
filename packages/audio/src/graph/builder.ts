// packages/audio/src/graph/builder.ts — Tone.js construction for the
// Clearing graph. What this is for: building the master chain (gentle
// tanh warmth into the 2:1 compressor at −24 dBFS into a limiter at
// −6 dBFS into master gain), the shared reverb (plate-ish, ~5 s decay,
// 30 ms pre-delay), the bed drone (D2+D3 detuned pairs low-passed at
// ~400 Hz), the shared HF air shimmer (p3-t13) and one per-lane chain
// (air/grain/pulse/tension gains, register, timbre, pan, width, density,
// voice LFO motion, flute breath) from the clearing scene recipes,
// returning live nodes that apply.ts ramps. What it must not do: schedule
// ramps itself, read events or SceneParams — it builds nodes at safe
// initial values; apply.ts moves them, and dispose() stops every started
// source and tears down every node for the sandbox lifecycle.

import type * as Tone from "tone";
import { createPianoBank, type PianoBank } from "../piano/bank.js";

import {
  AIR_BAND_HZ,
  AIR_VOICE,
  DRONE_RECIPE_TRIM_DB,
  DRONE_VIBRATO,
  DRONE_VOICE,
  FLUTE_RECIPE,
  FLUTE_VOICE,
  GLASS_VOICE,
  HARMONIC_FIELD,
  LANE_PANS,
  LANE_WIDTH,
  MALLET_VOICE,
  MASTER_CHAIN,
  NATURE_BED,
  PAD_VOICE,
  PULSE_PERIOD_RANGE_S,
  PULSE_PERIOD_RELAXED_S,
  REVERB,
  SAMPLE_START_FADE_S,
  SATURATION,
  STUCK_RATE_FULL_HZ,
  VOICE_OUTPUT_TRIM_DB,
  type VoiceRecipe,
} from "../scenes/clearing/index.js";
import { type NatureOffsets, natureOffsets } from "./nature.js";
import { rateForPeriodS, registerForLane } from "./plan.js";

/** Tone module surface this graph needs, injected so tests stay Tone-free. */
export type ToneModule = typeof Tone;

/**
 * One of a lane's two interchangeable pitched voice banks (p5-t01 slice).
 * `voices`, `gains` and `midi` are parallel arrays in construction order
 * (grain pair, pulse pair an octave down, tension set), so `midi[0]` is
 * the bank's root and every other voice keeps its own offset from it when
 * the bank is retuned. `gains` are the per-voice output gains the
 * crossfade ramps together; a silent bank holds them at 0.
 */
export type LaneVoiceBank = {
  readonly voices: readonly Tone.Oscillator[];
  readonly gains: readonly Tone.Gain[];
  readonly midi: readonly number[];
};

/** Every settable voice on one lane chain. */
export type LaneNodes = {
  readonly airGain: Tone.Gain;
  readonly airFilter: Tone.Filter;
  readonly airNoise: Tone.Noise;
  readonly grainGain: Tone.Gain;
  /** Real density control: grain repeat rate in grains/s (p3-t03 voices it). */
  readonly grainDensity: Tone.Signal<"frequency">;
  /**
   * Stuck re-articulation (p3-t14 revp3t14, ADR 0019): phrase-structure
   * voice, not a tremolo misuse. A per-lane Tone.Tremolo gates the grain
   * path: its LFOs swing 1→0 (never above unity — Tremolo's own topology
   * multiplies the path by the LFO output, so the capped depth can only
   * close toward silence, and struggle never raises loudness). The rate
   * doubles when the note set narrows (SceneParams stuckRateHz — noteSet
   * reaches audio through the re-articulation rate), and the pulse LFO
   * contraction shortens the swell cycle 4 s → 2 s, so the pattern
   * contracts as one structure. Lane register, timbre and pan never move
   * with struggle (ADR 0017).
   */
  readonly stuckTremolo: Tone.Tremolo;
  /** Per-lane gesture trim: inverts the master Calm trim (ADR 0018). */
  readonly gestureTrim: Tone.Gain;
  readonly pulseGain: Tone.Gain;
  readonly tensionGain: Tone.Gain;
  /** Per-lane send level into the single shared reverb (SceneParams-driven). */
  readonly reverbSend: Tone.Gain;
  readonly brightness: Tone.Filter;
  readonly widener: Tone.StereoWidener;
  /** Static per-register voice-output trim (tuning constant, never ramped). */
  readonly voiceTrim: Tone.Gain;
  readonly panner: Tone.Panner;
  readonly fadeGains: readonly Tone.Gain[];
  readonly voices: readonly Tone.Oscillator[];
  /**
   * The lane's pitched voices as TWO identical banks (p5-t01 slice,
   * ADR 0021). Each bank carries the lane's whole pitched voicing —
   * grain pair, pulse pair an octave down, tension set — into the same
   * filters, so a bank is the lane's full voice, not a layer of it. Bank
   * 0 sounds from construction; bank 1 runs silent. A note move retunes
   * the silent bank and equal-power crossfades the pair
   * (apply.ts crossfadeLaneVoices): the old note fades out while the new
   * one fades in, the lane's identity (timbre, register, pan, the octave
   * relations inside the voicing) is untouched, and no pitch ever bends.
   * Production never moves lane notes at all, so it only ever sounds
   * bank 0.
   */
  readonly voiceBanks: readonly LaneVoiceBank[];
  /** High-lane breath voices (flute timbre): one noise source per lane. */
  readonly breathVoices: readonly Tone.Noise[];
  /** Static per-note breath share into the grain gain (high lane only). */
  readonly breathFilter: Tone.Filter;
  /** Slow motion on static voice params (p3-t13): per-lane filter LFO. */
  readonly voiceLfo: Tone.LFO;
  readonly voiceLfoDepth: Tone.Gain;
  /** Per-lane grain voice low-pass the voice LFO breathes (p3-t13). */
  readonly grainFilter: Tone.Filter;
  readonly pulseFilter: Tone.Filter;
  /** Pulse swell LFO and its depth Gain (the LFO never touches audio). */
  readonly pulseLfo: Tone.LFO;
  readonly pulseDepth: Tone.Gain;
  readonly tensionFilter: Tone.Filter;
  readonly gestureBus: Tone.Gain;
};

/** The bed drone nodes. */
export type BedNodes = {
  readonly gain: Tone.Gain;
  readonly filter: Tone.Filter;
  readonly voices: readonly Tone.Oscillator[];
  readonly fadeGains: readonly Tone.Gain[];
  /** Slow detune drift per oscillator (DRONE_VIBRATO). */
  readonly lfos: readonly Tone.LFO[];
  /**
   * Two interchangeable drone banks (owner direction 2026-10-29): bank 0
   * sounds from construction, bank 1 runs silent, and a move of the tonal
   * centre crossfades them (apply.ts crossfadeDrone), so the floor follows
   * the key without ever bending a pitch.
   */
  readonly banks: readonly LaneVoiceBank[];
};

/**
 * The shared high-frequency air (p3-t13): one faint centre-panned shimmer
 * above the lanes — filtered noise through the air band — shared by the
 * whole mix, so height reads as one acoustic space, never a lane voice.
 */
export type AirNodes = {
  readonly gain: Tone.Gain;
  readonly filter: Tone.Filter;
  readonly noise: Tone.Noise;
};

/**
 * The nature bed (p3-t15 revp3t15, ADR 0017): one low sampled nature
 * texture — two looped voices of the same soft-rain asset under the mix,
 * started at the seeded offsets (half a loop apart) and slow-crossfaded
 * on the descriptor tick (density class, equal-power pair balance), so a
 * 12 s loop never repeats obviously inside a long render. Centre-panned
 * and band-limited (400 Hz high-pass off the drone's floor, 5 kHz
 * low-pass below the air band) at −44 dBFS, so it sits below the texture
 * without masking the question onset or the stuck voice — hard signals
 * outrank bed richness. Its level follows the scene density scale only
 * (never lane state — ADR 0017 macro independence); its tick alternates
 * from the descriptor's own count, lane-blind. Every start carries the
 * ≥ 5 ms fade; crossfades ride the density approach, never steps.
 */
export type NatureNodes = {
  /** Bed seat gain: the one density-modulated level (never lane-driven). */
  readonly gain: Tone.Gain;
  readonly highpass: Tone.Filter;
  readonly lowpass: Tone.Filter;
  /** Crossfade voices: per-voice gains over the 6 s window. */
  readonly voiceGains: readonly [Tone.Gain, Tone.Gain];
  readonly players: readonly Tone.Player[];
  /**
   * Resolves when the sampled asset is decoded in this context — the
   * await-ready surface QA and live share (same lifecycle as
   * `reverb.ready`): callers await it before starting audio. Loud on
   * load failure: rejects when the fetch fails or the decode fails, so
   * a missing texture can never read as a passing silent bed.
   */
  readonly ready: Promise<void>;
};

/**
 * One harmonic-field slot (ADR 0025): two interchangeable pitched banks
 * (a saw+triangle pair each; a pitch change hands over between them, no
 * pitch ever bends), a slow breath LFO on a depth gain (the voice swells
 * and recedes on its own 23–53 s cycle), the slot's level gain (entries
 * and exits on the 12 s fieldVoice ramp) and a fixed pan.
 */
/** One bloom voice: the fundamental plus its partials, and their envelope. */
export type PingVoiceNodes = {
  readonly oscillators: readonly Tone.Oscillator[];
  readonly envelope: Tone.Gain;
};

export type FieldSlotNodes = {
  readonly banks: readonly LaneVoiceBank[];
  readonly breathLfo: Tone.LFO;
  /** Slow detune drift per oscillator across both banks (HARMONIC_FIELD.vibrato). */
  readonly driftLfos: readonly Tone.LFO[];
  readonly breathDepth: Tone.Gain;
  readonly gain: Tone.Gain;
  readonly panner: Tone.Panner;
};

/**
 * The macro world's own voice: one slow environmental texture swell —
 * filtered noise through the checkpoint-driven air band, breathed by a
 * slow LFO at the checkpoint's pulse rate — plus the harmonic field
 * (ADR 0025): six pad slots voicing the chord core plans, through one
 * shared low-pass the checkpoint brightness drives, the field seat gain
 * and a share into the shared reverb. The field is told apart from the
 * lanes by timbre, level and motion, never by register. It reads the
 * macro checkpoint and the field plan only (never lane state), so no
 * lane mode or lifecycle can steer it; meso scales its gain targets
 * downstream in apply.
 */
export type MacroNodes = {
  /** Texture-swell gain: the one evolving environmental texture. */
  readonly swellGain: Tone.Gain;
  /** Field seat gain: the whole chord's level (core field gain × seat dB). */
  readonly fieldGain: Tone.Gain;
  readonly swellFilter: Tone.Filter;
  /** Shared field low-pass (checkpoint brightness as timbre). */
  readonly fieldFilter: Tone.Filter;
  /** The vowel stage beside the low-pass (HARMONIC_FIELD.choir). */
  readonly formants: readonly Tone.Filter[];
  /** Bloom-note low-pass into the field seat (ADR 0025). */
  readonly pingFilter: Tone.Filter;
  /**
   * Bloom voices (ADR 0025): a small pool of always-running sine stacks
   * behind closed envelopes. Built once, so scheduling a bloom creates no
   * node (nodes made inside an offline transport callback belong to the
   * wrong context) and a night of blooms allocates nothing.
   */
  readonly pingVoices: readonly PingVoiceNodes[];
  /** Glass-bloom low-pass into the field seat (the second bloom timbre). */
  readonly glassFilter: Tone.Filter;
  /** Glass-bloom voice pool, alternating with the pad blooms by id. */
  readonly glassVoices: readonly PingVoiceNodes[];
  readonly swellNoise: Tone.Noise;
  /** The six field slots, index-aligned with core FIELD_SLOTS. */
  readonly fieldSlots: readonly FieldSlotNodes[];
  /** Field share into the shared reverb (static). */
  readonly fieldSend: Tone.Gain;
  /** Breathing LFO on the swell gain at the checkpoint pulse rate. */
  readonly pulseLfo: Tone.LFO;
  readonly pulseDepth: Tone.Gain;
  readonly fadeGains: readonly Tone.Gain[];
};

/** The master chain nodes. */
export type MasterNodes = {
  readonly compressor: Tone.Compressor;
  readonly limiter: Tone.Limiter;
  /** Gentle tanh warmth before the compressor (p3-t13, static). */
  readonly warmth: Tone.WaveShaper;
  /** Dry/wet voice of the warmth: the shaped/dry paths meet here. */
  readonly warmthMix: Tone.CrossFade;
  /** Dry path into the warmth mix (unity, static). */
  readonly warmthDry: Tone.Gain;
  /** Master fader in dB: Calm rides this with the declared linear ramp. */
  readonly gain: Tone.Volume;
};

/** Everything createScene builds: nodes plus the single shared reverb. */
export type ClearingGraph = {
  readonly master: MasterNodes;
  readonly piano?: PianoBank;
  /**
   * The one shared reverb (plate-ish, 4–6 s decay, 30 ms pre-delay): every
   * lane sends to it, and its return joins the compressor-limiter-master
   * path. Await `ready` before starting audio — Tone generates the IR
   * asynchronously and the convolver is silent until it resolves.
   */
  readonly reverb: Tone.Reverb;
  readonly bed: BedNodes;
  /** The macro world's own voice (checkpoint-driven, lane-blind). */
  readonly macro: MacroNodes;
  /** The sampled nature bed (p3-t15): low, density-driven, lane-blind. */
  readonly nature: NatureNodes;
  /** The shared HF air shimmer (p3-t13): height, never identity. */
  readonly air: AirNodes;
  readonly lanes: readonly LaneNodes[];
  dispose(): void;
};

/** Options for createScene: lane count follows the SceneParams lanes. */
export type CreateSceneOptions = {
  readonly laneCount: number;
  readonly pianoAssetUrls?: Readonly<Record<number, string>>;
  /**
   * Seeded start offsets for the two nature-bed loop voices (revp3t15):
   * QA passes its render seed; live takes the default. Threaded as data,
   * never a loader seam — QA and live share the identical fetch + decode
   * path below.
   */
  readonly natureOffsets?: NatureOffsets;
  /** Bundler-resolved URL of the nature-bed WAV (live: import; QA: same). */
  readonly natureAssetUrl: string;
  /**
   * Byte loader for the nature-bed asset (tests only): when present the
   * graph decodes these bytes in the caller's own context through the
   * identical decode path as the fetch below. Live and QA never use this
   * — they fetch the bundler-resolved URL, so a divergent loader cannot
   * hide a 404.
   */
  readonly natureBytes?: () => Promise<ArrayBuffer>;
};

/** Resting pitch of the bloom voices before their first bloom (silent behind the envelope). */
const FIELD_PING_REST_MIDI = 74;

/** Voice recipe per lane register (pad/mallet/flute/glass). */
export function recipeForLane(laneIndex: number): VoiceRecipe {
  const register = registerForLane(laneIndex);
  if (register === "mid") return MALLET_VOICE;
  if (register === "high") return FLUTE_VOICE;
  if (register === "upper") return GLASS_VOICE;
  return PAD_VOICE;
}

/** Pan per lane register (−0.6/0/+0.6, upper centre). */
export function panForRegister(laneIndex: number): number {
  const register = registerForLane(laneIndex);
  return LANE_PANS[register];
}

/**
 * Builds the full Clearing graph. Every layer gain starts at silence (0)
 * so the first apply() ramps audibly from nothing; the master fader starts
 * at unity (0 dB). All final sources route through compressor → limiter →
 * master fader, including the single shared reverb return: each lane taps
 * a send gain off its brightness node into the one shared reverb
 * (plate-ish, ~5 s decay, 30 ms pre-delay), and the shared return joins the
 * compressor, so wet energy stays inside the limiter path. Sources start
 * through the ≥ 5 ms fade: Noise carries Tone's built-in fadeIn/fadeOut
 * envelope on its looped buffer, and every oscillator enters through a
 * per-voice fade Gain that opens from 0 with a linear ramp — so no sample
 * ever steps at start. Reverb generation is async in Tone (Reverb.generate
 * builds the IR via Offline); callers await `graph.reverb.ready` before
 * starting audio, otherwise the convolver renders dry until the IR lands.
 */
export function createScene(Tone: ToneModule, options: CreateSceneOptions): ClearingGraph {
  // Mild saturation before the compressor (p3-t13): one gentle tanh
  // waveshaper on the master path takes the sterile digital edge off.
  // tanh is odd-symmetric, so its mean is exactly zero — no DC beyond
  // the 0.01 fatigue bound. Static by construction — no parameter moves.
  const warmth = new Tone.WaveShaper(driveCurve(SATURATION.drive), 1024);
  warmth.oversample = "2x";
  // Dry/wet voice of the warmth (WaveShaper is fully wet by itself):
  // every source fans into the shaped path AND the dry path; both meet
  // at the mix node, whose fade voices the effect share without touching
  // the dry level. Static by construction — no parameter moves.
  const warmthMix = new Tone.CrossFade(SATURATION.wet);
  const warmthDry = new Tone.Gain(1);
  const compressor = new Tone.Compressor(
    MASTER_CHAIN.compressorThresholdDb,
    MASTER_CHAIN.compressorRatio,
  );
  const limiter = new Tone.Limiter(MASTER_CHAIN.limiterThresholdDb);
  const masterGain = new Tone.Volume(0);
  warmth.connect(warmthMix.b);
  warmthDry.connect(warmthMix.a);
  warmthMix.connect(compressor);
  const warmthBus: Tone.Gain = warmthDry;
  const warmthShaped: Tone.WaveShaper = warmth;
  compressor.connect(limiter);
  limiter.connect(masterGain);
  masterGain.toDestination();

  // The one shared reverb. Fully wet send return (wet = 1, so its output
  // is convolver-only): lane sends arrive via reverbSend gains and the
  // return joins the warmth input, never the master fader directly.
  const reverb = new Tone.Reverb({ decay: REVERB.decayS, preDelay: REVERB.preDelayS });
  reverb.wet.value = 1;
  reverb.connect(warmthBus);
  reverb.connect(warmthShaped);

  const bedFilter = new Tone.Filter(DRONE_VOICE.lowpassHz, "lowpass");
  const bedGain = new Tone.Gain(0);
  const bedVoices: Tone.Oscillator[] = [];
  const bedFades: Tone.Gain[] = [];
  // Static recipe trim (DRONE_RECIPE_TRIM_DB): the softer recipe seated at
  // the level the saws measured, so the planned bed gains keep meaning
  // what the docs say. A constant gain, never ramped.
  const bedTrim = new Tone.Gain(10 ** (DRONE_RECIPE_TRIM_DB / 20));
  bedFades.push(bedTrim);
  bedFilter.connect(bedTrim);
  bedTrim.connect(bedGain);
  bedGain.connect(warmthBus);
  bedGain.connect(warmthShaped);
  const bedLfos: Tone.LFO[] = [];
  const bedBanks: LaneVoiceBank[] = [0, 1].map((bank) => {
    const voices: Tone.Oscillator[] = [];
    const gains: Tone.Gain[] = [];
    const midi: number[] = [];
    DRONE_VOICE.oscillators.forEach((osc, index) => {
      // The static spread lives in the frequency; the detune param carries
      // a slow independent drift per oscillator (DRONE_VIBRATO), so the two
      // copies never beat on one fixed period.
      const voice = new Tone.Oscillator({
        frequency: midiToFrequency(osc.midi) * 2 ** (osc.detuneCents / 1200),
        type: osc.type,
        detune: 0,
      });
      const drift = new Tone.LFO(
        DRONE_VIBRATO.ratesHz[(index + bank) % DRONE_VIBRATO.ratesHz.length] ?? 0.07,
        -DRONE_VIBRATO.depthCents,
        DRONE_VIBRATO.depthCents,
      );
      drift.phase = ((index + bank * 0.5) * 360) / DRONE_VOICE.oscillators.length;
      drift.connect(voice.detune);
      drift.start();
      bedLfos.push(drift);
      const fade = bank === 0 ? startFaded(Tone, voice) : startSilent(Tone, voice);
      fade.connect(bedFilter);
      bedVoices.push(voice);
      bedFades.push(fade);
      voices.push(voice);
      gains.push(fade);
      midi.push(osc.midi);
    });
    return { voices, gains, midi };
  });

  const lanes: LaneNodes[] = [];
  for (let laneIndex = 0; laneIndex < options.laneCount; laneIndex += 1) {
    lanes.push(createLane(Tone, laneIndex, { dry: warmthBus, shaped: warmthShaped }, reverb));
  }
  const macro = createMacro(Tone, { dry: warmthBus, shaped: warmthShaped }, reverb);
  const nature = createNature(
    Tone,
    { dry: warmthBus, shaped: warmthShaped },
    options.natureAssetUrl,
    options.natureOffsets ?? natureOffsets(),
    options.natureBytes,
  );
  const air = createSharedAir(Tone, { dry: warmthBus, shaped: warmthShaped });
  const overflowBus = new Tone.Gain(1);
  const overflowSend = new Tone.Gain(0.3);
  overflowBus.connect(compressor);
  overflowBus.connect(overflowSend);
  overflowSend.connect(reverb);
  const piano =
    options.pianoAssetUrls === undefined
      ? undefined
      : createPianoBank(
          Tone,
          options.pianoAssetUrls,
          lanes.map((lane) => lane.gestureBus),
          overflowBus,
        );
  return {
    master: { compressor, limiter, warmth, warmthMix, warmthDry, gain: masterGain },
    reverb,
    piano,
    bed: {
      gain: bedGain,
      filter: bedFilter,
      voices: bedVoices,
      fadeGains: bedFades,
      lfos: bedLfos,
      banks: bedBanks,
    },
    macro,
    nature,
    air,
    lanes,
    dispose() {
      piano?.dispose();
      overflowBus.dispose();
      overflowSend.dispose();
      disposeAir(air);
      disposeNature(nature);
      disposeMacro(macro);
      for (const lane of lanes) {
        disposeLane(lane);
      }
      reverb.dispose();
      for (const voice of bedVoices) {
        voice.stop();
        voice.dispose();
      }
      for (const fade of bedFades) {
        fade.dispose();
      }
      for (const lfo of bedLfos) {
        lfo.stop();
        lfo.dispose();
      }
      bedGain.dispose();
      bedFilter.dispose();
      masterGain.dispose();
      limiter.dispose();
      warmth.dispose();
      warmthMix.dispose();
      warmthDry.dispose();
      compressor.dispose();
    },
  };
}

/** Stops every started source on a lane, then tears down every node. */
function disposeLane(lane: LaneNodes): void {
  lane.airNoise.stop();
  lane.airNoise.dispose();
  for (const voice of lane.voices) {
    voice.stop();
    voice.dispose();
  }
  for (const voice of lane.breathVoices) {
    voice.stop();
    voice.dispose();
  }
  for (const fade of lane.fadeGains) {
    fade.dispose();
  }
  lane.grainDensity.dispose();
  lane.stuckTremolo.dispose();
  lane.gestureTrim.dispose();
  lane.airGain.dispose();
  lane.airFilter.dispose();
  lane.grainGain.dispose();
  lane.pulseGain.dispose();
  lane.pulseLfo.stop();
  lane.pulseLfo.dispose();
  lane.pulseDepth.dispose();
  lane.pulseFilter.dispose();
  lane.tensionGain.dispose();
  lane.tensionFilter.dispose();
  lane.gestureBus.dispose();
  lane.reverbSend.dispose();
  lane.brightness.dispose();
  lane.widener.dispose();
  lane.voiceTrim.dispose();
  lane.panner.dispose();
  lane.breathFilter.dispose();
  lane.voiceLfo.stop();
  lane.voiceLfo.dispose();
  lane.voiceLfoDepth.dispose();
  lane.grainFilter.dispose();
}

/** Builds one lane chain: sources → layer gains → timbre → pan/width → master. */
function createLane(
  Tone: ToneModule,
  laneIndex: number,
  bus: { dry: Tone.Gain; shaped: Tone.WaveShaper },
  reverb: Tone.Reverb,
): LaneNodes {
  const recipe = recipeForLane(laneIndex);
  const register = registerForLane(laneIndex);
  // Static voice-output trim per register (tuning, not timbre): seats
  // the three lanes' sustained energy per unit layer gain. A constant
  // gain node — every audible move stays on the ramps.
  const voiceTrim = new Tone.Gain(10 ** ((VOICE_OUTPUT_TRIM_DB[register] ?? 0) / 20));
  const panner = new Tone.Panner(panForRegister(laneIndex));
  // StereoWidener's width is mid/side balance (0 = all mid, 1 = all side,
  // 0.5 = no change): the scene's ~0.2 region width maps to just above
  // centre (0.5 + 0.2/2), never near the extremes, so the widener shapes
  // the region without multiplying level.
  const widener = new Tone.StereoWidener(0.5 + LANE_WIDTH / 2);
  const brightness = new Tone.Filter(2500, "highshelf");
  widener.connect(voiceTrim);
  voiceTrim.connect(panner);
  panner.connect(brightness);
  brightness.connect(bus.dry);
  brightness.connect(bus.shaped);

  const reverbSend = new Tone.Gain(0.3);
  brightness.connect(reverbSend);
  // Each lane sends into the one shared reverb; the shared return joins
  // the warmth input (wired in createScene), so every wet sample passes
  // back through the warmth → compressor → limiter → master chain and
  // the −6 dBFS ceiling holds for dry and reverberated energy alike.
  // The send level is SceneParams-driven (apply.ts ramps it with the
  // reverbSend class).
  reverbSend.connect(reverb);

  const airGain = new Tone.Gain(0);
  const airFilter = new Tone.Filter((AIR_BAND_HZ.low + AIR_BAND_HZ.high) / 2, "bandpass");
  const airNoise = new Tone.Noise({ type: "pink", fadeIn: SAMPLE_START_FADE_S });
  airNoise.connect(airFilter);
  airFilter.connect(airGain);
  airGain.connect(widener);
  airNoise.start();

  // Grain density is a real control: a Signal in grains/s that the p3-t03
  // grain voice reads as its repeat rate. Until that voice exists the
  // Signal still schedules (and tests prove) the 4 s drift trajectory —
  // SceneParams density is consumed from the first apply, not parked.
  const grainDensity = new Tone.Signal(1, "frequency");
  const grainGain = new Tone.Gain(0);
  const voices: Tone.Oscillator[] = [];
  const breathVoices: Tone.Noise[] = [];
  const fadeGains: Tone.Gain[] = [];
  // Two interchangeable pitched banks per lane (p5-t01 slice): bank 0
  // sounds from construction, bank 1 runs silent, and a note move
  // crossfades them (apply.ts crossfadeLaneVoices). Both banks feed the
  // same filters and the same layer gains, so a bank switch cannot move
  // the lane's timbre, register, pan or level — only which pitch is
  // sounding. Production sounds bank 0 and never moves lane notes.
  const bankVoices: Tone.Oscillator[][] = [[], []];
  const bankGains: Tone.Gain[][] = [[], []];
  const bankMidi: number[][] = [[], []];
  /**
   * Builds one voice of one bank and records it in both the flat lists
   * (construction/disposal) and its bank's parallel arrays. Bank 0 opens
   * through the shared ≥ 5 ms start fade; bank 1 stays at silence until a
   * move fades it in, so its pitch can be reset without a click.
   */
  const addBankVoice = (
    bank: number,
    midi: number,
    options: ConstructorParameters<typeof Tone.Oscillator>[0],
    destination: Tone.InputNode,
  ): void => {
    const voice = new Tone.Oscillator(options);
    const fade = bank === 0 ? startFaded(Tone, voice) : startSilent(Tone, voice);
    fade.connect(destination);
    voices.push(voice);
    fadeGains.push(fade);
    bankVoices[bank]?.push(voice);
    bankGains[bank]?.push(fade);
    bankMidi[bank]?.push(midi);
  };
  // Slow motion on static voice params (p3-t13): one sub-audio LFO per
  // lane breathes the grain voice's low-pass ±8% at 0.07 Hz through a
  // depth gain (never the audio path) — the timbre drifts, never steps.
  // No ramp class invented: static construction, declarative 0.07 Hz.
  const voiceLfoDepth = new Tone.Gain(0.08 * recipe.lowpassHz);
  const voiceLfo = new Tone.LFO(0.07, -1, 1);
  voiceLfo.connect(voiceLfoDepth.gain);
  voiceLfo.start();
  const grainFilter = new Tone.Filter(recipe.lowpassHz, "lowpass");
  voiceLfoDepth.connect(grainFilter.frequency);
  for (const bank of [0, 1]) {
    for (const osc of recipe.oscillators) {
      addBankVoice(
        bank,
        osc.midi,
        {
          frequency: midiToFrequency(osc.midi),
          type: osc.type,
          detune: osc.detuneCents,
        },
        grainFilter,
      );
    }
  }
  // Stuck re-articulation (p3-t14 revp3t14, ADR 0019 — REAL phrase
  // structure, not a detune): the grain layer carries the lane's full
  // voice pair through the grain filter into a per-lane Tremolo. The
  // Tremolo's own LFOs swing the path 1→0 (never above unity — the
  // effect multiplies the path by the LFO output, so the capped depth
  // can only close toward silence): struggle re-articulates and
  // truncates phrases, it never adds level. Depth 0 is bypass-equivalent
  // (no gating); the rate holds 0.4 Hz full AND narrow (SceneParams
  // stuckRateHz — narrowing is expressed through depth 0→0.8 plus the
  // pulse 4 s→2 s contraction, so the lag-4 repetition meter reads the
  // deepening structure instead of aliasing on a rate doubling), and the
  // pulse LFO contraction shortens the swell cycle 4 s → 2 s, so the
  // pattern contracts as one structure.
  // Lane register, timbre and pan never move with struggle (ADR 0017):
  // the stuck pattern stays distinguishable from the macro world's own
  // motifs.
  //
  // Series cap proof, stated not hidden: the Tremolo sits in series on
  // the grain path with depth ≤ 0.8 (STUCK_GATE_MAX), so the grain path
  // output ≤ grainGain target at every sample — the audio equivalent of
  // the plan-level "struggle never raises gain" assertion. Mono-safe:
  // spread 0 keeps both channels' LFOs in phase, so the gate never
  // widens the lane image.
  const stuckTremolo = new Tone.Tremolo({
    frequency: STUCK_RATE_FULL_HZ,
    depth: 0,
    spread: 0,
  });
  stuckTremolo.start();
  grainFilter.connect(grainGain);
  grainGain.connect(stuckTremolo);
  stuckTremolo.connect(widener);
  // The narrowed two-note set needs no extra voices and no rate change:
  // the same recipe pair re-articulates at the held 0.4 Hz while depth
  // deepens 0→0.8 and the pulse locks 4 s→2 s, so variation drops WITH
  // struggle through structure, not through added oscillators. No new
  // timbre, no new register — identity preserved.

  // High-lane breath (flute timbre, p3-t13): filtered noise through the
  // voice low-pass into the grain gain — the breath rides the same layer
  // envelope as the grain voice, so it never leaks at silence. Static
  // share (FLUTE_RECIPE.breathShare); construction-only branch.
  const breathFilter = new Tone.Filter(recipe.lowpassHz, "lowpass");
  if (register === "high") {
    const breath = new Tone.Noise({ type: "pink", fadeIn: SAMPLE_START_FADE_S });
    const breathShare = new Tone.Gain(FLUTE_RECIPE.breathShare);
    breath.connect(breathFilter);
    breathFilter.connect(breathShare);
    breathShare.connect(grainGain);
    breath.start();
    breathVoices.push(breath);
    fadeGains.push(breathShare);
  }

  const pulsePeriodS = (PULSE_PERIOD_RANGE_S.min + PULSE_PERIOD_RANGE_S.max) / 2;
  // The pulse layer is a slow low swell: the LFO opens and closes a depth
  // Gain on the filtered voices at the mid period. Depth (not the audio
  // path) carries the LFO, so the swell can never add level beyond the
  // planned pulse gain — the p3-t03 pulse voice will drive its rate.
  const pulseGain = new Tone.Gain(0);
  const pulseFilter = new Tone.Filter(800, "lowpass");
  const pulseDepth = new Tone.Gain(1);
  const pulseLfo = new Tone.LFO(1 / pulsePeriodS, 0, 1);
  pulseLfo.connect(pulseDepth.gain);
  pulseLfo.start();
  for (const bank of [0, 1]) {
    for (const osc of recipe.oscillators.slice(0, 2)) {
      // The pulse pair sits an octave below the recipe, and the bank
      // records that: a lane note move (p5-t01) re-roots the whole bank,
      // so this voice keeps its octave below the new note.
      addBankVoice(
        bank,
        osc.midi - 12,
        {
          frequency: midiToFrequency(osc.midi - 12),
          type: osc.type === "sawtooth" ? "sine" : osc.type,
          detune: osc.detuneCents,
        },
        pulseFilter,
      );
    }
  }
  pulseFilter.connect(pulseDepth);
  pulseDepth.connect(pulseGain);
  pulseGain.connect(widener);
  // The pulse layer's own period is SceneParams-driven (p3-t14): the swell
  // LFO starts at the relaxed period; plan/apply re-voices its rate per
  // struggle (free and slow → stuck and contracted) on the period ramp.
  pulseLfo.frequency.value = rateForPeriodS(PULSE_PERIOD_RELAXED_S);

  const tensionGain = new Tone.Gain(0);
  const tensionFilter = new Tone.Filter(900, "lowpass");
  for (const bank of [0, 1]) {
    for (const osc of recipe.oscillators) {
      addBankVoice(
        bank,
        osc.midi,
        { frequency: midiToFrequency(osc.midi), type: "sine", detune: osc.detuneCents },
        tensionFilter,
      );
    }
  }
  tensionFilter.connect(tensionGain);

  // Piano gestures retain pan, brightness, reverb and Calm compensation
  // while bypassing the sustained instrument's width and output trim.
  // ADRs 0018/0028: The trim inverts the master Calm trim in linear gain
  // (plan gestureCalmCompensation; apply schedules it on the master
  // class), so gestures hold their level at any Calm while routine
  // presence falls. The trim is post-bus unity at calm 0 — routine
  // mixes never pass through it.
  const gestureTrim = new Tone.Gain(1);
  gestureTrim.connect(panner);
  const gestureBus = new Tone.Gain(0);
  gestureBus.connect(gestureTrim);
  tensionGain.connect(widener);

  return {
    airGain,
    airFilter,
    airNoise,
    grainGain,
    grainDensity,
    stuckTremolo,
    pulseGain,
    tensionGain,
    gestureBus,
    gestureTrim,
    reverbSend,
    brightness,
    widener,
    voiceTrim,
    panner,
    fadeGains,
    voices,
    voiceBanks: [0, 1].map((bank) => ({
      voices: bankVoices[bank] ?? [],
      gains: bankGains[bank] ?? [],
      midi: bankMidi[bank] ?? [],
    })),
    breathVoices,
    breathFilter,
    voiceLfo,
    voiceLfoDepth,
    grainFilter,
    pulseFilter,
    pulseLfo,
    pulseDepth,
    tensionFilter,
  };
}

/** Equal-tempered frequency for a MIDI note at A4 = 440 Hz. */
export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * The widest ±cents spread a pair at `frequencyHz` may take before its beat
 * rate passes `maxBeatHz` (owner listen 2026-10-29: "vibrating mid-high
 * pitches"). A fixed cents spread beats faster the higher the note: ±5 c
 * at A5 trembles at about 5 Hz, which the ear hears as a vibrating tone
 * rather than a living one. Capping the beat in Hz keeps every pair a
 * slow shimmer whatever its register.
 */
export function beatLimitedCents(frequencyHz: number, maxBeatHz: number): number {
  return 600 * Math.log2(1 + maxBeatHz / Math.max(1, frequencyHz));
}

/**
 * Builds the macro world's own voice: one slow environmental texture
 * (pink noise through a checkpoint-driven air band into a swell gain,
 * breathed by a slow LFO at the checkpoint pulse rate) plus the harmonic
 * field (ADR 0025): six pad slots, each two silent-startable voice banks
 * of a saw+triangle pair (the same two-bank handover the lanes use, so a
 * pitch change is a 5 s crossfade and never a bend), a breath LFO on a
 * depth gain (dynamics as harmony: each voice swells on its own period,
 * so which tone leads the chord keeps changing), a slot gain that
 * apply.ts ramps on the 12 s fieldVoice class, and a fixed pan. Slots
 * sum through one shared low-pass into the field seat gain, which feeds
 * the warmth stage and a share into the shared reverb. Every bank starts
 * at a construction pitch inside its slot window behind a closed slot
 * gain; apply.ts retunes the sounding bank before the first fade-in.
 */
function createMacro(
  Tone: ToneModule,
  bus: { dry: Tone.Gain; shaped: Tone.WaveShaper },
  reverb: Tone.Reverb,
): MacroNodes {
  const swellFilter = new Tone.Filter(1900, "bandpass");
  const swellGain = new Tone.Gain(0);
  const swellNoise = new Tone.Noise({ type: "pink", fadeIn: SAMPLE_START_FADE_S });
  swellNoise.connect(swellFilter);
  // The breathing LFO rides a depth gain on the swell path (never the
  // audio path itself), so the pulse can never add level beyond the
  // planned swell gain — the same topology as the lane pulse layer.
  const pulseDepth = new Tone.Gain(1);
  const pulseLfo = new Tone.LFO(0.15, 0, 1);
  pulseLfo.connect(pulseDepth.gain);
  pulseLfo.start();
  swellFilter.connect(pulseDepth);
  pulseDepth.connect(swellGain);
  swellGain.connect(bus.dry);
  swellGain.connect(bus.shaped);
  swellNoise.start();

  const fadeGains: Tone.Gain[] = [];
  const fieldFilter = new Tone.Filter(1400, "lowpass");
  const fieldGain = new Tone.Gain(0);
  // The vowel stage (HARMONIC_FIELD.choir): band-passes beside the field
  // low-pass, so every slot sounds through a soft sung "oo/oh".
  const formants = HARMONIC_FIELD.choir.formants.map((formant) => {
    const filter = new Tone.Filter({ frequency: formant.hz, type: "bandpass", Q: formant.q });
    const trim = new Tone.Gain(formant.gain);
    filter.connect(trim);
    trim.connect(fieldGain);
    fadeGains.push(trim);
    return filter;
  });
  const fieldSend = new Tone.Gain(HARMONIC_FIELD.reverbSend);
  fieldFilter.connect(fieldGain);
  // Blooms enter the field seat through their own brighter low-pass, so
  // they ride the same Calm/near-silence scale and reverb share as the
  // chord without the chord's darkness.
  const pingFilter = new Tone.Filter(HARMONIC_FIELD.ping.lowpassHz, "lowpass");
  pingFilter.connect(fieldGain);
  const buildPool = (
    spec: {
      readonly voices: number;
      readonly partials: readonly { readonly semitones: number; readonly share: number }[];
    },
    into: Tone.Filter,
  ): PingVoiceNodes[] => {
    const pool: PingVoiceNodes[] = [];
    for (let index = 0; index < spec.voices; index += 1) {
      const envelope = new Tone.Gain(0);
      envelope.connect(into);
      const oscillators: Tone.Oscillator[] = [];
      for (const part of [{ semitones: 0, share: 1 }, ...spec.partials]) {
        const osc = new Tone.Oscillator({
          frequency: midiToFrequency(FIELD_PING_REST_MIDI + part.semitones),
          type: "sine",
          detune: 0,
        });
        const trim = new Tone.Gain(part.share);
        osc.connect(trim);
        trim.connect(envelope);
        osc.start();
        oscillators.push(osc);
        fadeGains.push(trim);
      }
      pool.push({ oscillators, envelope });
    }
    return pool;
  };
  const pingVoices = buildPool(HARMONIC_FIELD.ping, pingFilter);
  const glassFilter = new Tone.Filter(HARMONIC_FIELD.pingGlass.lowpassHz, "lowpass");
  glassFilter.connect(fieldGain);
  const glassVoices = buildPool(HARMONIC_FIELD.pingGlass, glassFilter);
  fieldGain.connect(bus.dry);
  fieldGain.connect(bus.shaped);
  fieldGain.connect(fieldSend);
  fieldSend.connect(reverb);
  const fieldSlots: FieldSlotNodes[] = HARMONIC_FIELD.constructionMidi.map((midi, slot) => {
    const gain = new Tone.Gain(0);
    const panner = new Tone.Panner(HARMONIC_FIELD.pans[slot] ?? 0);
    const breathDepth = new Tone.Gain(1);
    const periodS = HARMONIC_FIELD.breathPeriodsS[slot] ?? 30;
    const breathLfo = new Tone.LFO(1 / periodS, HARMONIC_FIELD.breathFloor, 1);
    // Distinct start phases so six voices never swell together at t=0.
    breathLfo.phase = (slot * 360) / HARMONIC_FIELD.constructionMidi.length;
    breathLfo.connect(breathDepth.gain);
    breathLfo.start();
    breathDepth.connect(gain);
    gain.connect(panner);
    panner.connect(fieldFilter);
    for (const formant of formants) panner.connect(formant);
    const driftLfos: Tone.LFO[] = [];
    const banks: LaneVoiceBank[] = [0, 1].map((bank) => {
      const voices: Tone.Oscillator[] = [];
      const gains: Tone.Gain[] = [];
      const midis: number[] = [];
      // A sine at the pitch plus a quiet triangle an octave up. The
      // partial's share is a static gain between its fade and the breath
      // depth; apply.ts retunes the bank as a whole, each voice keeping
      // its offset from the root.
      const recipe: readonly { type: "sine" | "triangle"; offset: number; share: number }[] = [
        // One sine and its octave partial (owner listen 2026-10-29: "all
        // kinds of vibrations"): no detuned twin to beat against, no saw
        // to buzz. Clarity comes from one clean tone per voice.
        { type: "sine", offset: 0, share: 1 },
        {
          type: "triangle",
          offset: HARMONIC_FIELD.partialSemitones,
          share: HARMONIC_FIELD.partialShare,
        },
      ];
      recipe.forEach((part, index) => {
        const voice = new Tone.Oscillator({
          frequency: midiToFrequency(midi + part.offset),
          type: part.type,
          detune: 0,
        });
        // Slow independent detune drift on each copy (HARMONIC_FIELD.vibrato)
        // so a pair never beats on one fixed period; the interval-class
        // spread is applied to the frequency at retune (apply.ts).
        // The depth is cut by the slot's beat ceiling so two drifting copies
        // never pass maxBeatHz between them, even at the top of the field.
        const rates = HARMONIC_FIELD.vibrato.ratesHz;
        const depth = Math.min(
          HARMONIC_FIELD.vibrato.depthCents,
          beatLimitedCents(midiToFrequency(midi + part.offset), HARMONIC_FIELD.maxBeatHz),
        );
        const drift = new Tone.LFO(
          rates[(slot + index * 3 + bank * 5) % rates.length] ?? 0.13,
          -depth,
          depth,
        );
        drift.phase = ((slot * 7 + index * 3 + bank) * 41) % 360;
        drift.connect(voice.detune);
        drift.start();
        driftLfos.push(drift);
        const fade = bank === 0 ? startFaded(Tone, voice) : startSilent(Tone, voice);
        if (part.share === 1) {
          fade.connect(breathDepth);
        } else {
          const trim = new Tone.Gain(part.share);
          fade.connect(trim);
          trim.connect(breathDepth);
          fadeGains.push(trim);
        }
        voices.push(voice);
        gains.push(fade);
        midis.push(midi + part.offset);
        fadeGains.push(fade);
      });
      return { voices, gains, midi: midis };
    });
    return { banks, breathLfo, driftLfos, breathDepth, gain, panner };
  });
  return {
    swellGain,
    fieldGain,
    swellFilter,
    fieldFilter,
    formants,
    pingFilter,
    pingVoices,
    glassFilter,
    glassVoices,
    swellNoise,
    fieldSlots,
    fieldSend,
    pulseLfo,
    pulseDepth,
    fadeGains,
  };
}

/**
 * Builds the nature bed: two looped player voices of the one sampled
 * soft-rain asset through the bed-seat chain (high-pass → low-pass →
 * density gain) into the warmth. The asset reaches the graph through its
 * bundler-resolved URL (revp3t15: the caller's `?url` import, threaded
 * through CreateSceneOptions — no loader seam, no divergent lifecycle)
 * and decodes in the caller's own context via its `decodeAudioData`, so
 * the same code path decodes live and inside `Tone.Offline`. Both voices
 * share the one decoded buffer; the seeded offsets start them staggered
 * by half the loop, and the per-voice gains hold the slow crossfade.
 * `ready` resolves when the decode lands and REJECTS loudly when the
 * asset is missing or undecodable (a texture must never fail silent);
 * the graph still never throws synchronously for a texture. Silent until
 * ready by construction: the seat gain starts at 0 and apply.ts ramps
 * it, so a slow decode never steps.
 */
function createNature(
  Tone: ToneModule,
  bus: { dry: Tone.Gain; shaped: Tone.WaveShaper },
  assetUrl: string,
  offsets: NatureOffsets,
  bytes?: () => Promise<ArrayBuffer>,
): NatureNodes {
  const highpass = new Tone.Filter(NATURE_BED.highpassHz, "highpass");
  const lowpass = new Tone.Filter(NATURE_BED.lowpassHz, "lowpass");
  const gain = new Tone.Gain(0);
  highpass.connect(lowpass);
  lowpass.connect(gain);
  gain.connect(bus.dry);
  gain.connect(bus.shaped);
  const voiceGains = [new Tone.Gain(1), new Tone.Gain(1)] as const;
  for (const voiceGain of voiceGains) {
    voiceGain.connect(highpass);
  }
  const players: Tone.Player[] = [];
  const ready = (async () => {
    // Tests inject bytes directly (Node has no fetchable asset URL);
    // live and QA fetch the bundler-resolved URL. Both decode in the
    // caller's own context below — one decode path, never two loaders.
    const fetched =
      bytes !== undefined
        ? await bytes()
        : await (async () => {
            const response = await fetch(assetUrl);
            if (!response.ok) {
              throw new Error(`nature bed asset missing (${response.status}): ${assetUrl}`);
            }
            return response.arrayBuffer();
          })();
    if (fetched.byteLength === 0) {
      throw new Error(`nature bed asset empty: ${assetUrl}`);
    }
    const audioBuffer = await Tone.getContext().decodeAudioData(fetched.slice(0));
    const wrapped = new Tone.ToneAudioBuffer(audioBuffer);
    if (!wrapped.loaded) {
      throw new Error(`nature bed asset failed to decode: ${assetUrl}`);
    }
    const starts = [offsets.voiceA, offsets.voiceB];
    for (const [index, voiceGain] of voiceGains.entries()) {
      // No URL fetch: point the player at the already-decoded buffer —
      // `set buffer` calls `ToneAudioBuffer.set`, which wraps the
      // AudioBuffer without loading (verified in the shipped Tone
      // 15.1.22 ESM). The voice gains open the slow crossfade in
      // apply.ts; the players start the loop at staggered offsets.
      // Offset zero must sound the buffer from its first sample even
      // when the Offline transport reads a nonzero start: pass the
      // offset explicitly (the Player defaults a looped start to
      // loopStart only when the offset is undefined).
      const player = new Tone.Player({
        loop: true,
        fadeIn: NATURE_BED.startFadeS,
        fadeOut: NATURE_BED.startFadeS,
      });
      player.buffer = wrapped;
      player.connect(voiceGain);
      players.push(player);
      player.start(0, starts[index] ?? 0);
    }
  })();
  return { gain, highpass, lowpass, voiceGains, players, ready };
}

/** Stops the nature-bed players and tears down their nodes. */
function disposeNature(nature: NatureNodes): void {
  for (const player of nature.players) {
    player.stop();
    player.dispose();
  }
  for (const voiceGain of nature.voiceGains) {
    voiceGain.dispose();
  }
  nature.gain.dispose();
  nature.highpass.dispose();
  nature.lowpass.dispose();
}

/**
 * Builds the shared high-frequency air (p3-t13): one faint centre-panned
 * filtered-noise shimmer through the air band into a static gain at the
 * AIR_VOICE level. One voice for the whole mix — height, never identity.
 * Every source enters through the ≥ 5 ms fade; the gain never moves.
 */
function createSharedAir(
  Tone: ToneModule,
  bus: { dry: Tone.Gain; shaped: Tone.WaveShaper },
): AirNodes {
  const filter = new Tone.Filter(
    Math.sqrt(AIR_VOICE.bandHz.low * AIR_VOICE.bandHz.high),
    "bandpass",
  );
  const gain = new Tone.Gain(10 ** (AIR_VOICE.gainDb / 20));
  const noise = new Tone.Noise({ type: "pink", fadeIn: SAMPLE_START_FADE_S });
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(bus.dry);
  gain.connect(bus.shaped);
  noise.start();
  return { gain, filter, noise };
}

/** Stops the shared air and tears down its nodes. */
function disposeAir(air: AirNodes): void {
  air.noise.stop();
  air.noise.dispose();
  air.filter.dispose();
  air.gain.dispose();
}

/**
 * Gentle saturation curve (p3-t13): a soft-knee tanh with the Drive
 * amount as the knee sharpness. Odd-symmetric by construction, so its
 * mean is exactly zero (no DC); Drive 0.15 stays a warmth that takes
 * the sterile digital edge off without touching a level. Kept as a pure
 * function so tests can prove the symmetry without audio.
 */
export function driveCurve(drive: number): Float32Array {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh((1 + 3 * drive) * x) / Math.tanh(1 + 3 * drive);
  }
  return curve;
}

/** Stops the macro world's sources and tears down its nodes. */
function disposeMacro(macro: MacroNodes): void {
  macro.swellNoise.stop();
  macro.swellNoise.dispose();
  for (const slot of macro.fieldSlots) {
    for (const bank of slot.banks) {
      for (const voice of bank.voices) {
        voice.stop();
        voice.dispose();
      }
    }
    slot.breathLfo.stop();
    slot.breathLfo.dispose();
    for (const lfo of slot.driftLfos) {
      lfo.stop();
      lfo.dispose();
    }
    slot.breathDepth.dispose();
    slot.gain.dispose();
    slot.panner.dispose();
  }
  for (const fade of macro.fadeGains) {
    fade.dispose();
  }
  macro.pulseLfo.stop();
  macro.pulseLfo.dispose();
  macro.pulseDepth.dispose();
  macro.swellGain.dispose();
  macro.swellFilter.dispose();
  macro.fieldGain.dispose();
  macro.fieldSend.dispose();
  macro.fieldFilter.dispose();
  for (const formant of macro.formants) formant.dispose();
  for (const voice of [...macro.pingVoices, ...macro.glassVoices]) {
    for (const osc of voice.oscillators) {
      osc.stop();
      osc.dispose();
    }
    voice.envelope.dispose();
  }
  macro.pingFilter.dispose();
  macro.glassFilter.dispose();
}

/**
 * Starts an oscillator through a per-voice fade Gain that opens from 0
 * with a linear ramp over the sample-start fade, so the voice never steps
 * at start. Returns the fade Gain for chaining. Oscillators only — noise
 * sources carry Tone's built-in fadeIn/fadeOut envelope instead.
 */
/**
 * Starts a voice at silence: the oscillator runs (so it never has to be
 * started mid-move, which would click) behind a gain parked at 0. Only
 * the p5-t01 second voice bank uses this — its pitch can be reset at any
 * time because nothing of it is audible until a move fades it in.
 */
function startSilent(Tone: ToneModule, voice: Tone.Oscillator): Tone.Gain {
  const fade = new Tone.Gain(0);
  voice.connect(fade);
  voice.start();
  return fade;
}

function startFaded(Tone: ToneModule, voice: Tone.Oscillator): Tone.Gain {
  const fade = new Tone.Gain(0);
  voice.connect(fade);
  voice.start();
  fade.gain.setRampPoint(Tone.now());
  fade.gain.linearRampTo(1, SAMPLE_START_FADE_S);
  return fade;
}
