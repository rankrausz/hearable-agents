// Proves decoded piano ownership, loading and fast pre-emption; must not judge acoustic realism.
import { describe, expect, it, vi } from "vitest";
import { createPianoBank } from "../src/piano/bank.js";

function instrument(offline = false) {
  let loading: { onload: () => void; onerror: (error: Error) => void } | undefined;
  const disposeBuffers = vi.fn();
  class Buffers {
    loaded = true;
    constructor(options: { onload: () => void; onerror: (error: Error) => void }) {
      loading = options;
    }
    get(midi: number) {
      return { midi };
    }
    dispose = disposeBuffers;
  }
  const sources: Source[] = [];
  class Source {
    fadeOut: number;
    connect = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    dispose = vi.fn();
    onended = () => {};
    constructor(readonly options: { fadeOut: number }) {
      this.fadeOut = options.fadeOut;
      sources.push(this);
    }
  }
  return {
    tone: {
      getContext: () => ({ isOffline: offline }),
      ToneAudioBuffers: Buffers,
      ToneBufferSource: Source,
    },
    sources,
    disposeBuffers,
    loading: () => {
      if (!loading) throw new Error("No loader");
      return loading;
    },
  };
}

describe("recorded piano ownership", () => {
  it("waits for the shared recordings and owns every voice and buffer", async () => {
    const fake = instrument();
    const bank = createPianoBank(
      fake.tone as never,
      { 48: "local-C3.wav" },
      [{}] as never,
      {} as never,
    );
    let ready = false;
    void bank.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    fake.loading().onload();
    await bank.ready;
    expect(ready).toBe(true);
    bank.lanes[0]?.triggerAttackRelease(440 * 2 ** ((50 - 69) / 12), 2.6, 100, 0.2);
    const source = fake.sources[0];
    if (!source) throw new Error("Piano note was dropped");
    expect(source.options).toMatchObject({
      fadeIn: 0.005,
      fadeOut: 0.65,
      curve: "linear",
      url: { midi: 48 },
    });
    expect(source.start).toHaveBeenCalledWith(100, 0, undefined, 0.2);
    expect(source.stop).toHaveBeenCalledWith(102.6);
    bank.dispose();
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(fake.disposeBuffers).toHaveBeenCalledOnce();
  });
  it("shortens existing and pending releases before another roll opens the shared bus", () => {
    const fake = instrument();
    const bank = createPianoBank(
      fake.tone as never,
      { 48: "local.wav" },
      [{}] as never,
      {} as never,
    );
    const lane = bank.lanes[0];
    if (!lane) throw new Error("No lane");
    lane.triggerAttackRelease(130.8, 2.6, 100, 0.2);
    lane.triggerAttackRelease(130.8, 2.6, 100.4, 0.2);
    lane.releaseAll(100.2, 0.05);
    for (const source of fake.sources) {
      expect(source.fadeOut).toBe(0.05);
      expect(source.stop).toHaveBeenLastCalledWith(100.2);
    }
    bank.dispose();
  });
  it("keeps offline sources connected until native rendering has completed", () => {
    const fake = instrument(true);
    const bank = createPianoBank(
      fake.tone as never,
      { 48: "local.wav" },
      [{}] as never,
      {} as never,
    );
    bank.lanes[0]?.triggerAttackRelease(130.8, 2.6, 4, 0.2);
    const source = fake.sources[0];
    if (!source) throw new Error("No piano source");
    source.onended();
    expect(source.dispose).not.toHaveBeenCalled();
    bank.dispose();
    expect(source.dispose).toHaveBeenCalledOnce();
  });
  it("rejects missing recordings with actionable text rather than synthesizing a substitute", async () => {
    const fake = instrument();
    const bank = createPianoBank(fake.tone as never, { 48: "missing.wav" }, [], {} as never);
    const rejected = expect(bank.ready).rejects.toThrow("Restart audio to try again");
    fake.loading().onerror(new Error("404"));
    await rejected;
    bank.dispose();
  });
});
