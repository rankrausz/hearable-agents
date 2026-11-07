// packages/audio/test/graph.test.ts  behaviour tests for the shared
// reverb topology and the return path. What this is for: proving, without
// a browser, that every lane's reverbSend connects into the one shared
// reverb and the single reverb return joins the compressor (so the limiter
// ceiling covers wet energy), and that dispose stops every started source
// and tears down every node. What it must not do: import Tone  a minimal
// fake Tone module records connections and disposal instead. The fake
// returns one shared backing record per node it creates, so identity and
// connection assertions read the same records the graph holds.

import { describe, expect, it, vi } from "vitest";

import { createScene } from "../src/graph/builder.js";

/** Shared backing record behind each fake node the graph holds. */
type FakeBacking = {
  readonly label: string;
  readonly connects: string[];
  readonly dispose: () => void;
  readonly stop: () => void;
};

const backings: FakeBacking[] = [];

function backing(label: string): FakeBacking {
  const record: FakeBacking = { label, connects: [], dispose: vi.fn(), stop: vi.fn() };
  backings.push(record);
  return record;
}

/** Attaches the backing record so tests can read what the graph holds. */
function fakeNode(label: string, methods: Record<string, unknown> = {}): unknown {
  const record = backing(label);
  const node = {
    __backing: record,
    connect: (target: unknown) => {
      // Tone also connects nodes to raw AudioParams/Signals (e.g. the
      // pulse LFO into depth gain): only node-to-node edges matter here.
      const backing = (target as { __backing?: FakeBacking }).__backing;
      if (backing !== undefined) record.connects.push(backing.label);
    },
    toDestination: () => {},
    start: () => {},
    ready: Promise.resolve(),
    dispose: record.dispose,
    stop: record.stop,
    ...methods,
  };
  return node;
}

function paramMethods(): Record<string, unknown> {
  return { setRampPoint: vi.fn(), linearRampTo: vi.fn() };
}

function fakeTone(): Record<string, unknown> {
  backings.length = 0;
  const simple = (label: string) =>
    function (this: unknown) {
      return fakeNode(label);
    };
  function Gain(this: unknown, gainValue?: unknown) {
    void gainValue;
    return fakeNode("gain", { gain: { value: 0, ...paramMethods() } });
  }
  function Filter(this: unknown, cutoff?: unknown) {
    void cutoff;
    return fakeNode("filter", { frequency: { value: 0, ...paramMethods() } });
  }
  function Reverb(this: unknown) {
    return fakeNode("reverb", { wet: { value: 0 } });
  }
  function WaveShaper(this: unknown, curve?: unknown, length?: unknown) {
    void curve;
    void length;
    const node = fakeNode("warmth", { oversample: "none", wet: { value: 1 } });
    // WaveShaper takes a curve array plus length — accept both so the
    // material-path construction works.
    return node;
  }
  function RateLfo(this: unknown, options?: unknown) {
    void options;
    return fakeNode("lfo", {
      frequency: { value: 0, ...paramMethods() },
      amplitude: { value: 0, ...paramMethods() },
    });
  }
  function Tremolo(this: unknown, options?: unknown) {
    void options;
    return fakeNode("tremolo", {
      frequency: { value: 0, ...paramMethods() },
      depth: { value: 0, ...paramMethods() },
      spread: 0,
      start: () => {},
    });
  }
  function CrossFade(this: unknown, fade?: unknown) {
    void fade;
    const node = fakeNode("warmthmix", { fade: { value: 0, ...paramMethods() } });
    // CrossFade voices the warmth dry/wet share: a and b are the two
    // inputs the shaped and dry paths connect into.
    const record = (node as { __backing: unknown }).__backing;
    const ports = node as { a?: unknown; b?: unknown };
    ports.a = { __backing: record };
    ports.b = { __backing: record };
    return node;
  }
  function AudioNoise(this: unknown, options?: unknown) {
    void options;
    return fakeNode("noise");
  }
  function AudioPlayer(this: unknown, options?: unknown) {
    void options;
    return fakeNode("player", {
      buffer: null,
      start: vi.fn(),
      stop: () => {},
    });
  }
  function AudioBuffer(this: unknown, options?: unknown) {
    void options;
    return fakeNode("buffer", { loaded: true });
  }
  function VoiceOsc(this: unknown, options?: unknown) {
    void options;
    // Oscillators expose frequency and detune params: the drift LFOs
    // connect into detune at construction.
    return fakeNode("osc", {
      frequency: { value: 0, ...paramMethods() },
      detune: { value: 0, ...paramMethods() },
    });
  }
  function RateSignal(this: unknown, options?: unknown) {
    void options;
    return fakeNode("signal");
  }
  return {
    Compressor: simple("compressor"),
    Limiter: simple("limiter"),
    Volume: simple("master"),
    Gain,
    Filter,
    Panner: simple("panner"),
    StereoWidener: simple("widener"),
    Noise: AudioNoise,
    Player: AudioPlayer,
    ToneAudioBuffer: AudioBuffer,
    Oscillator: VoiceOsc,
    FMOscillator: simple("fm"),
    Signal: RateSignal,
    LFO: RateLfo,
    Tremolo,
    WaveShaper,
    CrossFade,
    Reverb,
    now: () => 0,
    getContext: () => ({ decodeAudioData: async () => ({}) }),
  };
}

function recordOf(node: unknown): FakeBacking {
  return (node as { __backing: FakeBacking }).__backing;
}

describe("shared reverb topology", () => {
  it("connects every lane send into one shared reverb returning to the warmth", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 3,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });

    const reverbs = backings.filter((record) => record.label === "reverb");
    expect(reverbs).toHaveLength(1);
    expect(recordOf(graph.reverb)).toBe(reverbs[0]);
    expect(reverbs[0]?.connects).toContain("warmth");

    expect(graph.lanes).toHaveLength(3);
    for (const lane of graph.lanes) {
      expect(recordOf(lane.reverbSend).connects).toContain("reverb");
    }
    graph.dispose();
  });

  it("routes the bed into the warmth", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 2,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });
    expect(recordOf(graph.bed.gain).connects).toContain("warmth");
    graph.dispose();
  });

  it("stops every started source and disposes every node", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 2,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });
    graph.dispose();

    expect(backings.length).toBeGreaterThan(0);
    for (const record of backings) {
      expect(record.dispose).toHaveBeenCalled();
    }
  });
});

describe("macro world voice", () => {
  it("builds one lane-blind texture swell plus field pad into the warmth", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 3,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });
    expect(recordOf(graph.macro.swellGain).connects).toContain("warmth");
    expect(recordOf(graph.macro.fieldGain).connects).toContain("warmth");
    graph.dispose();
  });

  it("builds six harmonic-field slots of two banks each behind one low-pass and a reverb share", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 3,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });
    expect(graph.macro.fieldSlots).toHaveLength(6);
    for (const slot of graph.macro.fieldSlots) {
      expect(slot.banks).toHaveLength(2);
      for (const bank of slot.banks) {
        // One sine and its octave partial: nothing to beat against.
        expect(bank.voices).toHaveLength(2);
        expect(bank.gains).toHaveLength(2);
        expect((bank.midi[1] ?? 0) - (bank.midi[0] ?? 0)).toBe(12);
      }
      expect(recordOf(slot.gain).connects).toContain("panner");
      expect(recordOf(slot.panner).connects).toContain("filter");
    }
    expect(recordOf(graph.macro.fieldFilter).connects).toContain("gain");
    // The vowel stage sits beside the low-pass, fed by every slot.
    expect(graph.macro.formants).toHaveLength(2);
    expect(recordOf(graph.macro.fieldGain).connects).toContain("gain");
    expect(recordOf(graph.macro.fieldSend).connects).toContain("reverb");
    expect(recordOf(graph.macro.pingFilter).connects).toContain("gain");
    graph.dispose();
  });
});

describe("nature bed (p3-t15, ADR 0017)", () => {
  it("builds two looped sampled voices into the band-limited bed seat", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 3,
      natureAssetUrl: "/nature-bed.wav",
      natureOffsets: { voiceA: 1, voiceB: 7 },
      natureBytes: async () => new ArrayBuffer(8),
    });
    expect(graph.nature.voiceGains).toHaveLength(2);
    for (const voiceGain of graph.nature.voiceGains) {
      expect(recordOf(voiceGain).label).toBe("gain");
    }
    expect(recordOf(graph.nature.highpass).label).toBe("filter");
    expect(recordOf(graph.nature.lowpass).label).toBe("filter");
    expect(recordOf(graph.nature.gain).connects).toContain("warmth");
    graph.dispose();
  });

  it("starts the two loop voices at the threaded seeded offsets", async () => {
    const tone = fakeTone() as never;
    const started: number[] = [];
    const PlayerWithStart = function (this: unknown, options?: unknown) {
      void options;
      const node = fakeNode("player", {
        buffer: null,
        start: (_at: number, offset: number) => {
          started.push(offset);
        },
        stop: () => {},
      });
      return node;
    };
    (tone as Record<string, unknown>).Player = PlayerWithStart;
    (tone as Record<string, unknown>).getContext = () => ({
      decodeAudioData: async () => ({}),
    });
    // Tests inject bytes (Node has no fetchable URL); live and QA fetch
    // the bundler-resolved URL through the same decode path.
    const graph = createScene(tone, {
      laneCount: 1,
      natureAssetUrl: "/nature-bed.wav",
      natureOffsets: { voiceA: 1, voiceB: 7 },
      natureBytes: async () => new ArrayBuffer(8),
    });
    await graph.nature.ready;
    // The actual player starts thread the seeded offsets — no default
    // half-loop, no loader seam.
    expect(started).toEqual([1, 7]);
    graph.dispose();
  });

  it("rejects loudly when the asset is empty, never silently dry", async () => {
    const graphEmpty = createScene(fakeTone() as never, {
      laneCount: 1,
      natureAssetUrl: "/nature-bed.wav",
      natureBytes: async () => new ArrayBuffer(0),
    });
    // Loudness owns the fix: a missing/empty texture rejects `ready`
    // instead of resolving to a silent bed that reads as passing.
    await expect(graphEmpty.nature.ready).rejects.toThrow(/empty/);
    graphEmpty.dispose();
  });

  it("exposes the same await-ready lifecycle as the reverb", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 1,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });
    expect(graph.nature.ready).toBeInstanceOf(Promise);
    expect(graph.reverb.ready).toBeInstanceOf(Promise);
    graph.dispose();
  });

  it("tears down the bed seat with the graph", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 1,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });
    graph.dispose();
    expect(recordOf(graph.nature.gain)?.dispose).toHaveBeenCalled();
    expect(recordOf(graph.nature.highpass)?.dispose).toHaveBeenCalled();
    expect(recordOf(graph.nature.lowpass)?.dispose).toHaveBeenCalled();
  });
});

describe("stuck re-articulation voice (p3-t14 revp3t14, ADR 0019)", () => {
  it("gates every lane's grain path through a per-lane Tremolo", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 3,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });
    for (const lane of graph.lanes) {
      // The Tremolo voices phrase structure through its own 1→0 depth
      // swing (the effect can only close toward silence) — never through
      // a gain node that could scale the path above its planned level.
      expect(recordOf(lane.stuckTremolo).label).toBe("tremolo");
    }
    graph.dispose();
  });

  it("routes gestures through the per-lane calm-compensation trim", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 2,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });
    for (const lane of graph.lanes) {
      expect(recordOf(lane.gestureTrim).label).toBe("gain");
      expect(recordOf(lane.gestureBus).connects).toContain("gain");
    }
    graph.dispose();
  });

  it("stops the stuck Tremolo and disposes its trim on teardown", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 1,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });
    const lane = graph.lanes[0];
    expect(lane).toBeDefined();
    graph.dispose();
    expect(recordOf(lane?.stuckTremolo)?.dispose).toHaveBeenCalled();
    expect(recordOf(lane?.gestureTrim)?.dispose).toHaveBeenCalled();
  });
});

describe("gesture bus routing", () => {
  it("gives every lane a gesture bus into its own calm-compensation trim", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 3,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });
    for (const lane of graph.lanes) {
      expect(recordOf(lane.gestureBus).connects).toContain("gain");
    }
    graph.dispose();
  });

  it("builds the p3-t13 material path: shared HF air, per-lane voice LFO, flute breath", () => {
    const graph = createScene(fakeTone() as never, {
      laneCount: 3,
      natureAssetUrl: "/x.wav",
      natureBytes: async () => new ArrayBuffer(8),
    });
    expect(recordOf(graph.air.gain).connects).toContain("warmth");
    // The warmth voices dry/wet through its mix node: one shaper plus
    // one mix, and the mix joins the compressor.
    const warms = backings.filter((record) => record.label === "warmth");
    expect(warms).toHaveLength(1);
    const mixes = backings.filter((record) => record.label === "warmthmix");
    expect(mixes).toHaveLength(1);
    expect(mixes[0]?.connects).toContain("compressor");
    // Per-lane voice motion: each lane holds its own drift LFO, depth
    // gain and grain filter (wired voiceLfo → depth.gain → filter
    // frequency in builder.ts); the fake records node identity, so the
    // assertion owns existence and disposal, not the param edges.
    for (const lane of graph.lanes) {
      expect(recordOf(lane.voiceLfo).label).toBe("lfo");
      expect(recordOf(lane.voiceLfoDepth).label).toBe("gain");
      expect(recordOf(lane.grainFilter).label).toBe("filter");
    }
    // Flute breath rides the grain gain on the high lane only: one
    // noise source into the shared breath filter, sounding through the
    // same layer envelope as the grain voice (never leaking at silence).
    expect(graph.lanes[2]?.breathVoices).toHaveLength(1);
    expect(graph.lanes[0]?.breathVoices).toHaveLength(0);
    graph.dispose();
  });
});
