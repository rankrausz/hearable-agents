// packages/adapter-kit — the contract every agent integration implements and
// the conformance suite that enforces it. This entry module is the public
// surface adapters build against: the Adapter interface and its supporting
// types, the shared claude-shaped hook parsing, the pending-tool-start
// bookkeeping, the capability honesty check and the pure conformance plan.
// It must stay free of test-framework imports so runtime consumers of the kit
// (the daemon, via adapters) never load Vitest; the Vitest registration layer
// is exported separately through the `@hearable/adapter-kit/conformance`
// subpath. Phase 1 adapters pin the contract they built against with
// ADAPTER_KIT_VERSION.

export type {
  Adapter,
  Diagnostic,
  InstallOptions,
  InstallResult,
  MapContext,
  PendingToolStart,
  PendingToolStarts,
} from "./adapter.js";
export type { CapabilityViolation } from "./capability-honesty.js";
export { findCapabilityViolations } from "./capability-honesty.js";
export type { ClaudeShapedHook } from "./claude-shaped-hooks.js";
export { parseClaudeShapedHook } from "./claude-shaped-hooks.js";
export type { ConformanceCase } from "./conformance/plan.js";
export { planConformance } from "./conformance/plan.js";
export {
  checkRedactionCase,
  recordedLinesFor,
  redactRecordedEvent,
} from "./conformance/redaction.js";
export type { RelayTimingMeasurement, RelayTimingOptions } from "./conformance/relay-timing.js";
export { measureRelayPayload } from "./conformance/relay-timing.js";
export type {
  ConformanceCategory,
  ConformanceSuites,
  FixtureCase,
  FixtureSuite,
  InstallerSuite,
  RedactionCase,
  RedactionSuite,
  RelayTimingPayload,
  RelayTimingSuite,
  UnknownEventCase,
  UnknownEventSuite,
} from "./conformance/suites.js";
export {
  CATEGORY_TITLES,
  CONFORMANCE_CATEGORIES,
  RELAY_TIMING_BUDGET_MS,
} from "./conformance/suites.js";
export type {
  LastToolContext,
  LastToolRecord,
  LastToolRecords,
} from "./last-tool.js";
export { LAST_TOOL_RECORD_BOUND, nextLastToolRecords, readLastToolName } from "./last-tool.js";
export { findToolStart, forgetToolStart, rememberToolStart } from "./tool-starts.js";

/** The version of this contract, so adapters can pin the surface they built against. */
export const ADAPTER_KIT_VERSION = 1 as const;
