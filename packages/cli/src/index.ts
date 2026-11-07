// packages/cli — the `hearable` command (Phase 1 slice: `start`, `record`,
// `replay`). This entry module is the public surface tests and the bin build
// on: the argv parser, the command dispatcher and the real-function
// composition. It must stay thin — argument parsing plus calls into the
// daemon package and the adapters; no mapping, redaction, lane or protocol
// logic (docs/ARCHITECTURE.md §packages/cli, task p1-t11).

export type { Parsed, RecordFlags, ServiceAction } from "./parse.js";
export { DEFERRED_VERBS, deferredVerbMessage, parseArgv } from "./parse.js";
export type { CliDeps, DoctorFinding, Io } from "./run.js";
export { defaultLocalRecordingsDir, realDeps, runHearable } from "./run.js";
export { manageService, serviceDefinition, servicePath, servicePlatform } from "./service.js";
