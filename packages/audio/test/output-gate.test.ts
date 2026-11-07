// Output ownership regression checks; offline QA verifies the resulting PCM.
import { describe, expect, it, vi } from "vitest";
import type { ClearingGraph, ToneModule } from "../src/graph/builder.js";
import { createOutputGate } from "../src/output-gate.js";

describe("complete-mix output gate", () => {
  it("starts closed, ignores repeated targets and anchors a reversed fade without a step", () => {
    const gain = { cancelAndHoldAtTime: vi.fn(), linearRampTo: vi.fn() };
    const initial: number[] = [];
    const dispose = vi.fn();
    class Gain {
      gain = gain;
      constructor(value: number) {
        initial.push(value);
      }
      toDestination() {
        return this;
      }
      dispose = dispose;
    }
    const graph = { master: { gain: { disconnect: vi.fn(), connect: vi.fn() } } };
    const gate = createOutputGate(
      { Gain, now: () => 10 } as unknown as ToneModule,
      graph as unknown as ClearingGraph,
    );
    expect(initial).toEqual([0]);
    expect(graph.master.gain.disconnect).toHaveBeenCalledOnce();
    expect(graph.master.gain.connect).toHaveBeenCalledOnce();
    gate.setOpen(false);
    expect(gain.linearRampTo).not.toHaveBeenCalled();
    gate.setOpen(true);
    gate.setOpen(true, 10.2);
    gate.setOpen(false, 10.4);
    expect(gain.cancelAndHoldAtTime.mock.calls).toEqual([[10], [10.4]]);
    expect(gain.linearRampTo.mock.calls).toEqual([
      [1, 1, 10],
      [0, 1, 10.4],
    ]);
    gate.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
