// Owns decoded piano recordings and note sources; must fail on missing assets and fade interrupted notes.
import type * as Tone from "tone";

export type PianoVoice = {
  triggerAttackRelease(frequency: number, duration: number, at: number, gain: number): void;
  releaseAll(at: number, fadeS: number): void;
};
export type PianoBank = {
  readonly ready: Promise<void>;
  readonly lanes: readonly PianoVoice[];
  readonly overflow: PianoVoice;
  dispose(): void;
};

/** Share decoded recordings; own individual sources so pre-emption can shorten an existing release. */
export function createPianoBank(
  tone: typeof Tone,
  urls: Readonly<Record<number, string>>,
  laneBuses: readonly Tone.Gain[],
  overflowBus: Tone.Gain,
): PianoBank {
  const context = tone.getContext();
  let loaded = () => {};
  let failed = (_error: Error) => {};
  const ready = new Promise<void>((resolve, reject) => {
    loaded = resolve;
    failed = reject;
  });
  const buffers = new tone.ToneAudioBuffers({
    urls,
    onload: loaded,
    onerror: (error) =>
      failed(
        new Error(`Piano samples could not load. Restart audio to try again: ${String(error)}`),
      ),
  });
  const keys = Object.keys(urls).map(Number);
  const sources = new Set<Tone.ToneBufferSource>();
  const voice = (bus: Tone.Gain): PianoVoice => {
    const active = new Set<Tone.ToneBufferSource>();
    return {
      triggerAttackRelease(frequency, duration, at, gain) {
        if (!buffers.loaded)
          throw new Error("Piano samples are not ready. Restart audio to try again.");
        const midi = 69 + 12 * Math.log2(frequency / 440);
        const key = [...keys].sort((a, b) => Math.abs(a - midi) - Math.abs(b - midi) || b - a)[0];
        if (key === undefined)
          throw new Error("Piano has no recordings. Restart audio to try again.");
        const source = new tone.ToneBufferSource({
          context,
          url: buffers.get(key),
          playbackRate: 2 ** ((midi - key) / 12),
          fadeIn: 0.005,
          fadeOut: 0.65,
          curve: "linear",
        });
        source.connect(bus);
        active.add(source);
        sources.add(source);
        source.onended = () => {
          active.delete(source);
          // Offline transport callbacks run before native rendering. Disconnecting
          // here would erase the recorded note from the entire render.
          if (!context.isOffline) {
            sources.delete(source);
            source.dispose();
          }
        };
        source.start(at, 0, undefined, gain);
        source.stop(at + duration);
      },
      releaseAll(at, fadeS) {
        for (const source of active) {
          source.fadeOut = fadeS;
          source.stop(at);
        }
      },
    };
  };
  return {
    ready,
    lanes: laneBuses.map(voice),
    overflow: voice(overflowBus),
    dispose() {
      for (const source of sources) source.dispose();
      sources.clear();
      buffers.dispose();
    },
  };
}
