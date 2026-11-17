// Verifies the lifetime of the context that plays an offline-rendered audition.
import { afterEach, expect, it, vi } from "vitest";
import { ensemblePlaybackPlan, playEnsemblePlan } from "../src/ensemble/playback.js";
import { RAMP_TIMES } from "../src/ramps.js";

vi.mock("../src/qa/render.js", () => ({
  renderQaScenario: vi.fn(async () => ({
    left: new Float32Array(1),
    right: new Float32Array(1),
    sampleRate: 48_000,
  })),
}));

class Source extends EventTarget {
  buffer: unknown = null;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

function stubAudioContext() {
  const source = new Source();
  const output = {
    gain: { value: 1, cancelAndHoldAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  };
  const close = vi.fn(async () => {});
  const currentTime = 3;
  let state = "running";
  class AudioContextStub {
    currentTime = currentTime;
    destination = {};
    get state() {
      return state;
    }
    resume = vi.fn(async () => {});
    close = close;
    createBuffer = vi.fn(() => ({ copyToChannel: vi.fn() }));
    createBufferSource = vi.fn(() => source);
    createGain = vi.fn(() => output);
  }
  vi.stubGlobal("AudioContext", AudioContextStub);
  return {
    close,
    currentTime,
    output,
    source,
    suspend() {
      state = "suspended";
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

it("closes the context after natural completion and ignores later controls", async () => {
  const { close, source, output } = stubAudioContext();
  const handle = await playEnsemblePlan(ensemblePlaybackPlan("hybrid", []), { volume: () => 0.5 });
  expect(output.gain.value).toBe(0.5);

  source.dispatchEvent(new Event("ended"));
  handle.setVolume(0.75);
  handle.stop();

  expect(close).toHaveBeenCalledOnce();
  expect(output.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
  expect(source.stop).not.toHaveBeenCalled();
});

it("uses the audio clock to stop and closes the context once the fade ends", async () => {
  const { close, currentTime, source, output } = stubAudioContext();
  const handle = await playEnsemblePlan(ensemblePlaybackPlan("hybrid", []));
  const end = currentTime + RAMP_TIMES.master.seconds;
  handle.setVolume(0.25);
  handle.stop();
  handle.stop();

  expect(output.gain.linearRampToValueAtTime.mock.calls).toEqual([
    [0.25, end],
    [0, end],
  ]);
  expect(source.stop).toHaveBeenCalledExactlyOnceWith(end);
  expect(close).not.toHaveBeenCalled();

  source.dispatchEvent(new Event("ended"));
  expect(close).toHaveBeenCalledOnce();
});

it("closes a suspended context immediately when stopped", async () => {
  const { close, source, suspend } = stubAudioContext();
  const handle = await playEnsemblePlan(ensemblePlaybackPlan("hybrid", []));
  suspend();

  handle.stop();

  expect(close).toHaveBeenCalledOnce();
  expect(source.stop).not.toHaveBeenCalled();
});
