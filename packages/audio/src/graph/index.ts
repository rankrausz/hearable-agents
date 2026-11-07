// packages/audio/src/graph/index.ts — the graph barrel.
// What this is for: the single import surface for graph construction
// (builder), the pure SceneParams planner (plan) and the framework-free
// descriptor (types) that p3-t03 and p3-t06 consume. What it must not do:
// import Tone itself — only builder.ts takes the Tone module, so planners
// and tests stay import-safe in Node.

export {
  type AirNodes,
  type BedNodes,
  type ClearingGraph,
  type CreateSceneOptions,
  createScene,
  driveCurve,
  type FieldSlotNodes,
  type LaneNodes,
  type MacroNodes,
  type MasterNodes,
  midiToFrequency,
  type NatureNodes,
  panForRegister,
  recipeForLane,
  type ToneModule,
} from "./builder.js";
export {
  type NatureOffsets,
  natureCrossfadeParity,
  natureOffsets,
  natureVoiceGains,
} from "./nature.js";
export {
  AIR_BASE_CUTOFF_HZ,
  dbToGain,
  GRAIN_DENSITY_RANGE,
  gestureCalmCompensation,
  panForLane,
  planGraph,
  rateForPeriodS,
  registerForLane,
} from "./plan.js";
export {
  allParameters,
  type FieldPingDescriptor,
  type FieldVoiceDescriptor,
  type GraphDescriptor,
  type LaneDescriptor,
  type RampedParameter,
} from "./types.js";
