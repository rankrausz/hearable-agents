// packages/daemon — the local hearable daemon: accepts events, assigns
// sessions to lanes, broadcasts to browsers and reports its own health
// (docs/ARCHITECTURE.md Phase 1 "Daemon", docs/ARCHITECTURE.md §packages/daemon). This
// entry module is the public surface the CLI (p1-t11), recorder and replayer
// (p1-t06) and everything else later builds on: starting and stopping the
// daemon, loading its config, and the types others program against. It must
// not bundle audio code — the daemon owns the engine and attention projection,
// while ingest keeps its named engine seam.

export type { AdapterRegistry } from "./adapters.js";
export { createAdapterRegistry } from "./adapters.js";
export type { BroadcastTarget, Scheduler, ServerMessage } from "./broadcast.js";
export { BROADCAST_INTERVAL_MS, Broadcaster, defaultScheduler } from "./broadcast.js";
export { CalmError, CalmSchema, createCalmStore, DEFAULT_CALM } from "./calm.js";
export { type Clock, wallClock } from "./clock.js";
export {
  ConfigError,
  type DaemonConfig,
  type DaemonConfigOverrides,
  DaemonConfigSchema,
  DEFAULT_CONFIG_FILE,
  DEFAULT_PORT,
  defaultDataDir,
  loadConfig,
} from "./config.js";
export type { EngineOwner, LaneRender, LaneSignal } from "./engine.js";
export { createEngineOwner } from "./engine.js";
export {
  type FocusProcess,
  type FocusTarget,
  FocusTargetSchema,
  parseFocusProcesses,
  processAncestry,
  readFocusProcesses,
} from "./focus-origin.js";
export type { HealthReport } from "./health.js";
export type {
  ApplyToEngine,
  Ingest,
  IngestOptions,
  RecordEvents,
  RecordRawEvents,
} from "./ingest.js";
export { createIngest } from "./ingest.js";
export type { LaneSnapshot, LaneState, LaneView } from "./lanes.js";
export { LaneManager, laneKeyOf } from "./lanes.js";
export {
  acquireDaemonLock,
  DaemonAlreadyRunningError,
  type DaemonLock,
  lockFilePath,
} from "./lock.js";
export type { QuarantineEntry, QuarantineStore } from "./quarantine.js";
export { createQuarantine, quarantineDirectory } from "./quarantine.js";
export {
  createRecorder,
  defaultAnnotationsPath,
  hashPath,
  RECORDED_META_KEYS,
  type Recorder,
  type RecorderOptions,
  type RedactMode,
  rawSidecarPath,
  redactEvent,
  SessionRekey,
} from "./recorder.js";
export {
  formatRecordingHeader,
  parseRecordingHeader,
  RECORDING_SCHEMA_VERSION,
  type RecordingHeader,
  RecordingHeaderSchema,
  RecordingReadError,
  SUPPORTED_RECORDING_VERSIONS,
} from "./recording.js";
export {
  createNamespaceScope,
  createReplayClock,
  type MutableClock,
  type NamespaceScope,
  namespacesFor,
  type ReplayerDeps,
  type ReplayOptions,
  type ReplayRequest,
  type ReplaySummary,
  replayRecordingFile,
  replayRecordingFiles,
  replayRecordings,
} from "./replayer.js";
export {
  type DaemonRuntime,
  defaultWebRoot,
  LANE_ADVANCE_INTERVAL_MS,
  MAX_BODY_BYTES,
  type StartOptions,
  startDaemon,
  WS_PATH,
} from "./server.js";
export type { SessionRecord, SessionRef } from "./sessions.js";
export { basenameOf, Sessions, toSessionRef } from "./sessions.js";
