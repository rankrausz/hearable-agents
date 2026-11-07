// Gates the complete mix after the scene fader, including reverb and shared air.
// It must not change composition, lane identity, or Calm compensation.
import type { ClearingGraph, ToneModule } from "./graph/builder.js";
import { RAMP_TIMES } from "./ramps.js";

export function createOutputGate(tone: ToneModule, graph: ClearingGraph) {
  const output = new tone.Gain(0).toDestination();
  graph.master.gain.disconnect();
  graph.master.gain.connect(output);
  let open = false;
  return {
    /** `fadeS` defaults to the one-second master ramp; automatic silence passes a longer one. */
    setOpen(next: boolean, at = tone.now(), fadeS: number = RAMP_TIMES.master.seconds): void {
      if (next === open) return;
      open = next;
      output.gain.cancelAndHoldAtTime(at);
      output.gain.linearRampTo(next ? 1 : 0, fadeS, at);
    },
    dispose(): void {
      output.dispose();
    },
  };
}
