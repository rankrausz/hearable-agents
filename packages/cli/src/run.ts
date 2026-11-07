// packages/cli/src/run.ts — the command dispatcher behind the `hearable`
// binary. What this is for: turning the parsed argv into calls into the
// daemon (startDaemon, loadConfig, createRecorder, createReplayClock,
// replayRecordingFiles) plus plain-language output, per task p1-t11. It is
// deliberately thin: no mapping, redaction, lane or protocol logic lives
// here — those all belong to `@hearable/daemon` and the adapters. What it
// must not do: re-implement any daemon behaviour or let an error propagate as
// a raw exception.

import { execFile } from "node:child_process";
import { accessSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { Adapter, Diagnostic } from "@hearable/adapter-kit";
import { claudeCodeAdapter, doctorClaudeCode } from "@hearable/claude-code";
import { codexAdapter, doctorCodex } from "@hearable/codex";
import {
  ConfigError,
  createRecorder,
  createReplayClock,
  DaemonAlreadyRunningError,
  type DaemonRuntime,
  loadConfig,
  RecordingReadError,
  replayRecordingFiles,
  startDaemon,
} from "@hearable/daemon";
import { deferredVerbMessage, type InstallAgent, parseArgv, type RecordFlags } from "./parse.js";
import { manageService, realServiceDeps, type ServiceDeps } from "./service.js";

/** The Phase 1 adapters the daemon maps raw payloads with (docs/ARCHITECTURE
 * §packages/cli: the composition root injects the adapters). */
const LIVE_ADAPTERS: readonly Adapter[] = [claudeCodeAdapter, codexAdapter];

export type Io = {
  out(line: string): void;
  err(line: string): void;
};

/** The daemon and recorder functions this phase's command surface needs,
 * injectable so tests can assert the passthrough without real servers. */
export type CliDeps = {
  loadConfig: typeof loadConfig;
  startDaemon: typeof startDaemon;
  createRecorder: typeof createRecorder;
  createReplayClock: typeof createReplayClock;
  replayRecordingFiles: typeof replayRecordingFiles;
  /** The gitignored recordings folder (`fixtures-local/` at the repo root). */
  localRecordingsDir: () => string;
  /** An optional config file override, for tests and non-default installs. */
  configFile: () => string | undefined;
  /**
   * An optional audio renderer root override, test-scoped so the live drill can
   * point the spawned daemon at a throwaway directory (p4-t08). Absent, the
   * daemon serves its defaultWebRoot(); no user-visible behaviour depends on
   * this seam.
   */
  webRoot: () => string | undefined;
  /** Adapter checks are injected so doctor tests never inspect the real machine. */
  doctorAdapters: () => readonly Adapter[];
  /** Adapters used by install; injectable so tests never touch user config. */
  installAdapters: () => readonly Adapter[];
  /** Resolves user-scope install options for an agent. */
  installOptions: (
    agent: InstallAgent,
    daemonUrl: string,
  ) => { configDir: string; daemonUrl: string };
  /** Detects supported agent commands without touching their config. */
  detectAgents: () => Promise<readonly InstallAgent[]>;
  /** Asks one yes/no question for interactive install. */
  confirmInstall: (agent: InstallAgent) => Promise<boolean>;
  /** Platform seam keeps the Windows Codex message deterministic in tests. */
  platform: () => NodeJS.Platform;
  /** Verifies the exact user-scope config changed by install. */
  verifyInstall: (
    agent: InstallAgent,
    configDir: string,
    adapter: Adapter,
  ) => Promise<readonly Diagnostic[]>;
  /** The browser owns the user gesture; this check verifies the console can be reached. */
  audioCheck: (config: ReturnType<typeof loadConfig>) => Promise<DoctorFinding>;
  service: ServiceDeps;
};

/** The default composition: the real daemon functions and the repo layout. */
export function realDeps(): CliDeps {
  return {
    loadConfig,
    startDaemon,
    createRecorder,
    createReplayClock,
    replayRecordingFiles,
    localRecordingsDir: defaultLocalRecordingsDir,
    configFile: () => readConfigFileOverride(),
    webRoot: () => readWebRootOverride(),
    doctorAdapters: () => LIVE_ADAPTERS,
    installAdapters: () => LIVE_ADAPTERS,
    installOptions: defaultInstallOptions,
    detectAgents: detectInstalledAgents,
    confirmInstall: confirmInstallWithTerminal,
    platform: () => process.platform,
    verifyInstall: verifyInstall,
    audioCheck: defaultAudioCheck,
    service: realServiceDeps(),
  };
}

/** Resolves the package's repo location without reading cwd, so the recordings
 * folder is stable no matter where the CLI is invoked from (like the daemon's
 * defaultWebRoot). */
const CLI_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function defaultLocalRecordingsDir(): string {
  return resolve(CLI_PACKAGE_ROOT, "../../fixtures-local");
}

function readConfigFileOverride(): string | undefined {
  const value = process.env.HEARABLE_CONFIG_FILE;
  return value === undefined || value === "" ? undefined : value;
}

/** Test-scoped audio renderer root override (p4-t08): lets the live drill spawn
 * the real binary pointing at a throwaway web root, so its console assertions
 * hold whether or not apps/web/dist exists. Not a user-facing setting. */
function readWebRootOverride(): string | undefined {
  const value = process.env.HEARABLE_WEB_ROOT;
  return value === undefined || value === "" ? undefined : value;
}

/** Parses strictly enough that the config file can point at a throwaway path;
 * the daemon's own strict zod build rejects unknown keys. */
export async function runHearable(
  argv: readonly string[],
  deps: CliDeps = realDeps(),
  io: Io = { out: console.log, err: console.error },
): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.kind === "usage-error") {
    io.err(parsed.message);
    return 2;
  }
  if (parsed.kind === "deferred") {
    io.err(deferredVerbMessage(parsed.verb, parsed.phase, parsed.note));
    return 1;
  }
  try {
    switch (parsed.kind) {
      case "start":
        return await startCommand(deps, io);
      case "service":
        return await serviceCommand(parsed.action, deps, io);
      case "doctor":
        return await doctorCommand(deps, io);
      case "install":
        return await installCommand(parsed.agent, deps, io);
      case "record":
        return parsed.flags.stop
          ? await stopRecording(parsed.flags, deps, io)
          : await startRecording(parsed.flags, deps, io);
      case "replay":
        return await replayCommand(parsed.files, parsed.speed, deps, io);
    }
  } catch (error) {
    io.err(plainErrorMessage(error));
    return 1;
  }
}

async function serviceCommand(
  action: "install" | "uninstall" | "status",
  deps: CliDeps,
  io: Io,
): Promise<number> {
  const config = deps.loadConfig({ configFile: deps.configFile() });
  const result = await manageService(action, config, deps.service);
  (result.running === false ? io.err : io.out)(result.message);
  return result.running === false ? 1 : 0;
}

export type DoctorFinding = {
  severity: "ok" | "info" | "warn" | "fail";
  message: string;
  fix?: string;
};

async function doctorCommand(deps: CliDeps, io: Io): Promise<number> {
  const findings: DoctorFinding[] = [];
  let config: ReturnType<typeof loadConfig>;
  try {
    config = deps.loadConfig({ configFile: deps.configFile() });
    findings.push({ severity: "ok", message: "Hearable configuration is valid." });
  } catch (error) {
    findings.push({
      severity: "fail",
      message: plainErrorMessage(error),
      fix: "Fix the config file, or remove it and run hearable doctor again.",
    });
    printDoctorFindings(findings, io);
    return 1;
  }

  const daemonUrl = `http://${config.host}:${config.port}`;
  try {
    const response = await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) {
      findings.push({
        severity: "fail",
        message: `The daemon at ${daemonUrl} returned HTTP ${response.status}.`,
        fix: "Start the daemon with hearable start, then run hearable doctor again.",
      });
    } else {
      findings.push({ severity: "ok", message: `The daemon is reachable at ${daemonUrl}.` });
    }
  } catch {
    const available = await isPortAvailable(config.host, config.port);
    findings.push({
      severity: "fail",
      message: available
        ? `Nothing is listening on daemon port ${config.port}.`
        : `The daemon port ${config.port} is occupied, but the Hearable health endpoint did not answer.`,
      fix: "Start the daemon with hearable start, or stop the process using that port and try again.",
    });
  }

  for (const adapter of deps.doctorAdapters()) {
    try {
      findings.push(...(await adapter.doctor()));
    } catch {
      findings.push({
        severity: "fail",
        message: `The ${adapter.id} adapter checks could not run.`,
        fix: "Run hearable install again, then run hearable doctor.",
      });
    }
  }
  findings.push(
    {
      severity: "info",
      message: "OpenCode, Cursor and ACP are not installed in this build.",
      fix: "Use the Phase 1b adapter installer when those adapters are available.",
    },
    await deps.audioCheck(config),
  );
  printDoctorFindings(findings, io);
  return findings.some((finding) => finding.severity === "fail") ? 1 : 0;
}

async function installCommand(
  requestedAgent: InstallAgent | undefined,
  deps: CliDeps,
  io: Io,
): Promise<number> {
  const detected = requestedAgent === undefined ? await deps.detectAgents() : [requestedAgent];
  if (detected.length === 0) {
    io.out(
      "No supported coding agents were detected. Install Claude Code or Codex, then run hearable install again.",
    );
    return 0;
  }

  const selected: InstallAgent[] = [];
  for (const agent of detected) {
    if (requestedAgent !== undefined || (await deps.confirmInstall(agent))) {
      selected.push(agent);
    } else {
      io.out(`Skipped ${agent}.`);
    }
  }
  if (selected.length === 0) {
    io.out("No agent hooks were installed.");
    return 0;
  }

  const config = deps.loadConfig({ configFile: deps.configFile() });
  const daemonUrl = `http://${config.host}:${config.port}`;
  let failed = false;
  for (const agent of selected) {
    if (agent === "codex" && deps.platform() === "win32") {
      io.err(
        "Codex hooks are unsupported on Windows in this Codex version; no Codex hooks were installed.",
      );
      failed = true;
      continue;
    }
    const adapter = deps.installAdapters().find((candidate) => candidate.id === agent);
    if (adapter === undefined) {
      io.err(`No installer is available for ${agent}.`);
      failed = true;
      continue;
    }
    try {
      const options = deps.installOptions(agent, daemonUrl);
      const result = await adapter.install(options);
      io.out(`${agent}: ${result.summary}`);
      if (!(await printInstallDoctor(agent, options.configDir, adapter, deps, io))) {
        failed = true;
      }
    } catch (error) {
      io.err(`${agent}: ${plainErrorMessage(error)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

function defaultInstallOptions(
  agent: InstallAgent,
  daemonUrl: string,
): { configDir: string; daemonUrl: string } {
  const home = homedir();
  return {
    configDir:
      agent === "claude-code"
        ? join(home, ".claude")
        : (process.env.CODEX_HOME ?? join(home, ".codex")),
    daemonUrl,
  };
}

async function printInstallDoctor(
  agent: InstallAgent,
  configDir: string,
  adapter: Adapter,
  deps: CliDeps,
  io: Io,
): Promise<boolean> {
  try {
    const findings = await deps.verifyInstall(agent, configDir, adapter);
    for (const finding of findings) {
      const label =
        finding.severity === "ok" ? "OK" : finding.severity === "warn" ? "WARN" : "FAIL";
      (finding.severity === "fail" ? io.err : io.out)(
        `${agent}: ${label}: ${finding.message}${finding.fix === undefined ? "" : ` Fix: ${finding.fix}`}`,
      );
    }
    // A fresh-machine install normally precedes `hearable start`. Keep that
    // delivery diagnostic visible, but do not make a correctly written config
    // look like an install failure just because the daemon is not running yet.
    return !findings.some(
      (finding) =>
        finding.severity === "fail" &&
        !finding.message.includes("did not answer") &&
        !finding.message.includes("did not respond"),
    );
  } catch {
    io.err(
      `${agent}: install completed, but doctor could not verify the result. Run hearable doctor.`,
    );
    return false;
  }
}

async function verifyInstall(
  agent: InstallAgent,
  configDir: string,
): Promise<readonly Diagnostic[]> {
  if (agent === "claude-code") {
    return doctorClaudeCode(configDir);
  }
  return doctorCodex({ codexHome: configDir });
}

async function detectInstalledAgents(): Promise<readonly InstallAgent[]> {
  const found: InstallAgent[] = [];
  for (const [agent, command] of [
    ["claude-code", "claude"],
    ["codex", "codex"],
  ] as const) {
    if (await commandExists(command)) {
      found.push(agent);
    }
  }
  return found;
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 2000 }, (error) => resolve(error === null));
  });
}

async function confirmInstallWithTerminal(agent: InstallAgent): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Install Hearable hooks for ${agent}? [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function printDoctorFindings(findings: readonly DoctorFinding[], io: Io): void {
  for (const finding of findings) {
    const label =
      finding.severity === "ok"
        ? "OK"
        : finding.severity === "info"
          ? "INFO"
          : finding.severity === "warn"
            ? "WARN"
            : "FAIL";
    const line = `${label}: ${finding.message}${finding.fix === undefined ? "" : ` Fix: ${finding.fix}`}`;
    (finding.severity === "fail" ? io.err : io.out)(line);
  }
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createConnection({ host, port });
    const timer = setTimeout(() => {
      server.destroy();
      resolve(false);
    }, 2000);
    server.once("connect", () => {
      clearTimeout(timer);
      server.destroy();
      resolve(false);
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code === "ECONNREFUSED");
    });
  });
}

async function defaultAudioCheck(): Promise<DoctorFinding> {
  const webRoot = process.env.HEARABLE_WEB_ROOT;
  if (webRoot !== undefined && webRoot !== "") {
    try {
      accessSync(webRoot);
    } catch {
      return {
        severity: "fail",
        message: `The configured audio renderer path ${webRoot} is not readable.`,
        fix: "Build the audio renderer, or unset HEARABLE_WEB_ROOT and run hearable doctor again.",
      };
    }
  }
  return {
    severity: "ok",
    message: "The local audio renderer path is ready; enable playback from the Mac popover.",
  };
}

async function startCommand(deps: CliDeps, io: Io): Promise<number> {
  const config = deps.loadConfig({ configFile: deps.configFile() });
  const runtime = await deps.startDaemon({
    config,
    adapters: LIVE_ADAPTERS,
    webRoot: deps.webRoot(),
  });
  keepAlive(runtime);
  io.out(`The hearable daemon is running at ${runtime.url}. Press Ctrl-C to stop.`);
  return 0;
}

async function startRecording(flags: RecordFlags, deps: CliDeps, io: Io): Promise<number> {
  const config = deps.loadConfig({ configFile: deps.configFile() });
  const filePath = join(deps.localRecordingsDir(), `${flags.name}.jsonl`);
  const pidPath = recordingPidPath(config.dataDir, flags.name);
  if (!claimRecordingControl(pidPath, flags.name, io)) {
    return 1;
  }
  const recorder = deps.createRecorder({
    filePath,
    // The header agent is written before any event arrives, so a recording
    // cannot name its agent up front; per-event `agent` fields keep identity.
    agent: "unknown",
    redact: flags.redact,
    raw: flags.raw,
  });
  let runtime: DaemonRuntime;
  try {
    runtime = await deps.startDaemon({
      config,
      adapters: LIVE_ADAPTERS,
      webRoot: deps.webRoot(),
      record: (events) => recorder.record(events),
      recordRaw: (text) => recorder.recordRaw(text),
    });
  } catch (error) {
    releaseRecordingControl(pidPath);
    throw error;
  }
  keepAlive(runtime, () => releaseRecordingControl(pidPath));
  io.out(
    `Recording "${flags.name}" to ${filePath}. The daemon is listening at ${runtime.url}; stop it with: hearable record --name ${flags.name} --stop.`,
  );
  return 0;
}

async function stopRecording(flags: RecordFlags, deps: CliDeps, io: Io): Promise<number> {
  const config = deps.loadConfig({ configFile: deps.configFile() });
  const pidPath = recordingPidPath(config.dataDir, flags.name);
  const pid = readRecordingPid(pidPath);
  if (pid === null) {
    io.err(
      `No recording named "${flags.name}" is running. Start one with: hearable record --name ${flags.name}.`,
    );
    return 1;
  }
  if (!processIsAlive(pid)) {
    releaseRecordingControl(pidPath);
    io.out(
      `Recording "${flags.name}" is not running anymore, so there is nothing to stop. Its stale control file was removed.`,
    );
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Raced with the recording process exiting on its own.
  }
  if (!(await waitForExit(pid, 4000))) {
    io.err(
      `Recording "${flags.name}" is stopping but has not exited yet. The recording file is complete; try --stop again shortly.`,
    );
    return 1;
  }
  releaseRecordingControl(pidPath);
  io.out(
    `Recording "${flags.name}" stopped. Wrote ${join(deps.localRecordingsDir(), `${flags.name}.jsonl`)}.`,
  );
  return 0;
}

async function replayCommand(
  files: readonly string[],
  speed: number,
  deps: CliDeps,
  io: Io,
): Promise<number> {
  const config = deps.loadConfig({ configFile: deps.configFile() });
  // One shared mutable clock: the daemon reads `now()` for receivedAt (via a
  // plain `Clock` wrapper) while the replayer drives `set`/`resumeLive` to
  // each batch's rescaled time (docs/ARCHITECTURE.md §Time).
  const clock = deps.createReplayClock();
  const daemonClock = () => clock.now();
  let runtime: DaemonRuntime | null = null;
  try {
    runtime = await deps.startDaemon({
      config,
      adapters: LIVE_ADAPTERS,
      webRoot: deps.webRoot(),
      clock: daemonClock,
    });
    // Printed before any file is fed, so a browser (or the live drill's WS
    // client) can connect and watch the frames land instead of missing the
    // burst that completes within a broadcast interval.
    io.out(
      `Replaying ${files.length} file${files.length === 1 ? "" : "s"} into the daemon at ${runtime.url}.`,
    );
    const summaries = await deps.replayRecordingFiles(
      files,
      { ingest: runtime.ingest, clock },
      { speed },
    );
    for (const summary of summaries) {
      io.out(
        `Replayed ${summary.label}: ${summary.eventCount} events from ${summary.agent} as ${summary.namespace}.`,
      );
    }
    const total = summaries.reduce((sum, summary) => sum + summary.eventCount, 0);
    io.out(
      `Replay finished: ${total} events across ${summaries.length} file${summaries.length === 1 ? "" : "s"} at ${speed}x speed. The daemon stays running at ${runtime.url} for the audio renderer.`,
    );
    keepAlive(runtime);
    return 0;
  } catch (error) {
    // A failed replay must not leave a locked daemon behind: stop and release
    // so the caller can fix the file and retry.
    if (runtime !== null) {
      await runtime.stop().catch(() => {});
    }
    throw error;
  }
}

function plainErrorMessage(error: unknown): string {
  if (
    error instanceof DaemonAlreadyRunningError ||
    error instanceof ConfigError ||
    error instanceof RecordingReadError
  ) {
    return error.message;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Something went wrong: ${detail}.`;
}

/** Keeps a foreground daemon alive until SIGINT/SIGTERM, stopping it cleanly
 * so it releases its lock. The CLI never exits a foreground daemon on its own. */
function keepAlive(runtime: DaemonRuntime, cleanup?: () => void): void {
  const shutdown = () => {
    void (async () => {
      if (cleanup !== undefined) {
        try {
          cleanup();
        } catch {
          // Losing the control file to the OS is not worth aborting shutdown.
        }
      }
      try {
        await runtime.stop();
      } catch {
        // The socket already closed; the important part is exiting.
      }
      process.exit(0);
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/** One control file per recording in the config data dir: `record-<name>.pid`. */
function recordingPidPath(dataDir: string, name: string): string {
  return join(dataDir, `record-${name}.pid`);
}

/** Claims the recording control file; refuses plainly when another live
 * recording owns the same name. A control file left behind by a dead process
 * is stale: it is removed first so the same name can start again without an
 * explicit --stop. */
function claimRecordingControl(pidPath: string, name: string, io: Io): boolean {
  const existing = readRecordingPid(pidPath);
  if (existing !== null && processIsAlive(existing)) {
    io.err(
      `A recording named "${name}" is already running. Stop it first with: hearable record --name ${name} --stop.`,
    );
    return false;
  }
  if (existing !== null) {
    // The owner process is gone; drop the stale file before the wx claim,
    // otherwise the retry below always fails on the leftover file.
    releaseRecordingControl(pidPath);
  }
  try {
    writeFileSync(pidPath, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch {
    const raced = readRecordingPid(pidPath);
    if (raced !== null && processIsAlive(raced)) {
      io.err(
        `A recording named "${name}" just started in another process. Stop it first with: hearable record --name ${name} --stop.`,
      );
      return false;
    }

    // The claim failed for an unknown reason; surface it plainly.
    io.err(
      `Could not claim the recording control file at ${pidPath}. Another recording may be running; try --stop first.`,
    );
    return false;
  }
}

function readRecordingPid(pidPath: string): number | null {
  try {
    const value = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function releaseRecordingControl(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch {
    // Already gone; a double cleanup is not an error.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH means no such process; EPERM means it exists but is not ours.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return false;
}
