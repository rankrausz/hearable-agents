// packages/cli/test/run.test.ts — the dispatcher with the daemon functions
// stubbed in, so option passthrough, the already-running refusal, the
// deferred verbs and replay error surfacing are asserted without real ports
// or processes. The real end-to-end behaviour (record→file, replay→WS feed,
// second `start` refusal) belongs to live-drill.test.ts, which spawns the
// actual binary.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  type createRecorder,
  DaemonAlreadyRunningError,
  type DaemonConfig,
  type DaemonRuntime,
  RecordingReadError,
  type replayRecordingFiles,
  type startDaemon,
} from "@hearable/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../../adapters/claude-code/src/index.js";
import { installClaudeCode, uninstallClaudeCode } from "../../adapters/claude-code/src/install.js";
import type { CliDeps } from "../src/run.js";
import { defaultLocalRecordingsDir, realDeps, runHearable } from "../src/run.js";

function runtime(url = "http://127.0.0.1:4876"): DaemonRuntime {
  return {
    port: 0,
    url,
    ingest: { handlePostEvents: () => null },
    stop: async () => {},
  };
}

function config(dataDir: string): DaemonConfig {
  return { host: "127.0.0.1", port: 0, lanes: 3, laneReleaseAfterMs: 60_000, dataDir };
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearable-cli-run-"));
  tmpDirs.push(dir);
  return dir;
}

type Harness = {
  deps: CliDeps;
  io: { out(line: string): void; err(line: string): void };
  seen: {
    startOptions?: Parameters<typeof startDaemon>[0];
    ingests: unknown[];
    recorderOptions?: Parameters<typeof createRecorder>[0];
    replayFiles: string[];
    replayOptions?: Parameters<typeof replayRecordingFiles>[2];
    replayerDeps?: Parameters<typeof replayRecordingFiles>[1];
  };
  out: string[];
  err: string[];
};

function harness(overrides?: Partial<CliDeps>): Harness {
  const dataDir = freshDataDir();
  const seen: Harness["seen"] = {
    ingests: [],
    replayFiles: [],
  };
  const deps: CliDeps = {
    loadConfig: (_options) => config(dataDir),
    startDaemon: async (options) => {
      seen.startOptions = options;
      const daemonRuntime = runtime();
      seen.ingests.push(daemonRuntime.ingest);
      return daemonRuntime;
    },
    createRecorder: (options) => {
      seen.recorderOptions = options;
      return {
        filePath: options.filePath,
        rawFilePath: null,
        record: () => {},
        recordRaw: () => {},
      };
    },
    createReplayClock: () => {
      let current = 1;
      return {
        now: () => current,
        set: (now: number) => {
          current = now;
        },
        resumeLive: () => {
          current = 2;
        },
      };
    },
    replayRecordingFiles: (files, replayDeps, replayOptions) => {
      seen.replayFiles = [...files];
      seen.replayerDeps = replayDeps;
      seen.replayOptions = replayOptions;
      return Promise.resolve([
        {
          label: files[0] ?? "x.jsonl",
          namespace: "replay-1",
          agent: "claude-code",
          eventCount: 3,
          firstTs: 1,
          lastTs: 2,
        },
      ]);
    },
    localRecordingsDir: () => join(dataDir, "fixtures-local"),
    configFile: () => undefined,
    webRoot: () => undefined,
    doctorAdapters: () => [],
    installAdapters: () => [],
    installOptions: (agent, daemonUrl) => ({ configDir: join(dataDir, agent), daemonUrl }),
    detectAgents: async () => [],
    confirmInstall: async () => false,
    platform: () => "darwin",
    verifyInstall: async (_agent, _configDir, adapter) => adapter.doctor(),
    audioCheck: async () => ({
      severity: "ok",
      message: "The local audio renderer path is ready; enable playback from the Mac popover.",
    }),
    service: {
      platform: () => "darwin",
      homeDir: () => dataDir,
      executable: () => ({ command: "node", args: ["hearable"] }),
      run: async () => {},
    },
    ...overrides,
  };
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    seen,
    out,
    err,
  };
}

describe("runHearable command dispatch", () => {
  it("reports service install, stopped status and uninstall in plain language", async () => {
    const fx = harness({
      service: {
        platform: () => "win32",
        homeDir: () => "/tmp",
        executable: () => ({ command: "node", args: ["hearable"] }),
        run: async () => {},
      },
    });
    expect(await runHearable(["service", "install"], fx.deps, fx.io)).toBe(0);
    expect(fx.out.at(-1)).toContain("manual on Windows");
    expect(await runHearable(["service", "status"], fx.deps, fx.io)).toBe(0);
    expect(await runHearable(["service", "uninstall"], fx.deps, fx.io)).toBe(0);
  });

  it("start launches the daemon with the Phase 1 adapters and prints the URL", async () => {
    const fx = harness();
    const code = await runHearable(["start"], fx.deps, fx.io);
    expect(code).toBe(0);
    expect(fx.seen.startOptions?.adapters.map((adapter) => adapter.id)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(fx.seen.startOptions?.config.port).toBe(0);
    expect(fx.out.join("\n")).toContain("The hearable daemon is running at http://127.0.0.1:4876.");
  });

  it("doctor exits successfully and prints all-green checks", async () => {
    const fx = harness({
      loadConfig: () => config(freshDataDir()),
      doctorAdapters: () => [
        {
          id: "claude-code",
          doctor: async () => [{ severity: "ok", message: "Claude is ready." }],
        } as never,
      ],
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      expect(await runHearable(["doctor"], fx.deps, fx.io)).toBe(0);
      expect(fx.out.join("\n")).toContain("OK: The daemon is reachable");
      expect(fx.out.join("\n")).toContain("OK: The local audio renderer path is ready");
      expect(fx.out.join("\n")).toContain("INFO: OpenCode, Cursor and ACP are not installed");
      expect(fx.out.join("\n")).not.toContain("WARN:");
      expect(fx.err).toEqual([]);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("doctor reports a daemon-down failure with an exact fix", async () => {
    const fx = harness();
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("down");
    };
    try {
      expect(await runHearable(["doctor"], fx.deps, fx.io)).toBe(1);
      expect(fx.err.join("\n")).toContain("Start the daemon with hearable start");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("detects both agents and offers each, installing only the accepted agent", async () => {
    const installed: string[] = [];
    const adapters = [
      {
        id: "claude-code",
        install: async () => {
          installed.push("claude-code");
          return { changed: true, summary: "installed" };
        },
        doctor: async () => [{ severity: "ok", message: "Claude is ready." }],
      },
      {
        id: "codex",
        install: async () => {
          installed.push("codex");
          return { changed: true, summary: "installed" };
        },
        doctor: async () => [{ severity: "ok", message: "Codex is ready." }],
      },
    ] as never;
    const fx = harness({
      detectAgents: async () => ["claude-code", "codex"],
      confirmInstall: async (agent) => agent === "claude-code",
      installAdapters: () => adapters,
    });
    expect(await runHearable(["install"], fx.deps, fx.io)).toBe(0);
    expect(installed).toEqual(["claude-code"]);
    expect(fx.out.join("\n")).toContain("Skipped codex.");
    expect(fx.out.join("\n")).toContain("claude-code: installed");
  });

  it("can accept Codex while declining Claude Code", async () => {
    const installed: string[] = [];
    const fx = harness({
      detectAgents: async () => ["claude-code", "codex"],
      confirmInstall: async (agent) => agent === "codex",
      installAdapters: () =>
        [
          {
            id: "claude-code",
            install: async () => {
              installed.push("claude-code");
              return { changed: true, summary: "installed" };
            },
            doctor: async () => [],
          },
          {
            id: "codex",
            install: async () => {
              installed.push("codex");
              return { changed: true, summary: "installed" };
            },
            doctor: async () => [],
          },
        ] as never,
    });
    expect(await runHearable(["install"], fx.deps, fx.io)).toBe(0);
    expect(installed).toEqual(["codex"]);
    expect(fx.out.join("\n")).toContain("Skipped claude-code.");
  });

  it("reports no installed agents without prompting", async () => {
    const fx = harness({ detectAgents: async () => [] });
    expect(await runHearable(["install"], fx.deps, fx.io)).toBe(0);
    expect(fx.out.join("\n")).toContain("No supported coding agents were detected");
  });

  it("installs an explicit agent non-interactively and reports Windows Codex support plainly", async () => {
    const installed: string[] = [];
    const fx = harness({
      installAdapters: () => [
        {
          id: "codex",
          install: async () => {
            installed.push("codex");
            return { changed: false, summary: "already installed" };
          },
          doctor: async () => [],
        } as never,
      ],
      platform: () => "win32",
    });
    expect(await runHearable(["install", "codex"], fx.deps, fx.io)).toBe(1);
    expect(installed).toEqual([]);
    expect(fx.err.join("\n")).toContain("unsupported on Windows");
  });

  it("reruns an explicit install without prompting and preserves the adapter result", async () => {
    let calls = 0;
    const fx = harness({
      installAdapters: () => [
        {
          id: "claude-code",
          install: async () => {
            calls += 1;
            return {
              changed: calls === 1,
              summary: calls === 1 ? "installed" : "already installed",
            };
          },
          doctor: async () => [],
        } as never,
      ],
    });
    expect(await runHearable(["install", "claude-code"], fx.deps, fx.io)).toBe(0);
    expect(await runHearable(["install", "claude-code"], fx.deps, fx.io)).toBe(0);
    expect(calls).toBe(2);
    expect(fx.out.join("\n")).toContain("claude-code: already installed");
  });

  it("keeps daemon-unavailable verification visible without failing the install", async () => {
    const fx = harness({
      installAdapters: () => [
        {
          id: "claude-code",
          install: async () => ({ changed: true, summary: "installed" }),
          doctor: async () => [],
        } as never,
      ],
      verifyInstall: async () => [
        {
          severity: "fail",
          message:
            "The daemon at http://127.0.0.1:4876 did not answer, so hook events are dropped for now.",
          fix: "Start the daemon with hearable start, then run hearable doctor again.",
        },
      ],
    });
    expect(await runHearable(["install", "claude-code"], fx.deps, fx.io)).toBe(0);
    expect(fx.err.join("\n")).toContain("did not answer");
  });

  it("preserves bytes when the CLI install is followed by adapter uninstall", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "hearable-cli-install-"));
    tmpDirs.push(configDir);
    const pristine =
      '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"user"}]}]}}  \n';
    writeFileSync(join(configDir, "settings.json"), pristine, "utf8");
    const installer = {
      id: "claude-code",
      install: (options: { configDir: string; daemonUrl: string }) =>
        installClaudeCode({ ...options, relayPath: "hearable-hook" }),
      uninstall: uninstallClaudeCode,
      doctor: async () => [],
    } as never;
    const fx = harness({
      installAdapters: () => [installer],
      installOptions: () => ({ configDir, daemonUrl: "http://127.0.0.1:4876" }),
      verifyInstall: async () => [],
    });
    expect(await runHearable(["install", "claude-code"], fx.deps, fx.io)).toBe(0);
    await uninstallClaudeCode({ configDir, daemonUrl: "http://127.0.0.1:4876" });
    expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe(pristine);
  });

  it("installs through the real Claude adapter and restores the original bytes", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "hearable-cli-real-install-"));
    tmpDirs.push(configDir);
    const pristine = '{"hooks":{},"model":"sonnet"}\n';
    writeFileSync(join(configDir, "settings.json"), pristine, "utf8");
    const fx = harness({
      installAdapters: () => [claudeCodeAdapter],
      installOptions: () => ({ configDir, daemonUrl: "http://127.0.0.1:4876" }),
      verifyInstall: async () => [],
    });

    expect(await runHearable(["install", "claude-code"], fx.deps, fx.io)).toBe(0);
    expect(readFileSync(join(configDir, "settings.json"), "utf8")).toContain(
      "hearable:claude-code",
    );
    await claudeCodeAdapter.uninstall({ configDir, daemonUrl: "http://127.0.0.1:4876" });
    expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe(pristine);
  });

  it("doctor reports missing hooks as a failure", async () => {
    const fx = harness({
      doctorAdapters: () => [
        {
          id: "codex",
          doctor: async () => [
            {
              severity: "fail",
              message: "Codex hooks are missing.",
              fix: "Run hearable install codex.",
            },
          ],
        } as never,
      ],
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      expect(await runHearable(["doctor"], fx.deps, fx.io)).toBe(1);
      expect(fx.err.join("\n")).toContain("Run hearable install codex.");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("doctor reports invalid config without throwing", async () => {
    const fx = harness({
      loadConfig: () => {
        throw new ConfigError("The config is invalid.");
      },
    });
    expect(await runHearable(["doctor"], fx.deps, fx.io)).toBe(1);
    expect(fx.err.join("\n")).toContain("The config is invalid.");
  });

  it("audio readiness is green when the local console path is available", async () => {
    const previous = process.env.HEARABLE_WEB_ROOT;
    delete process.env.HEARABLE_WEB_ROOT;
    try {
      await expect(realDeps().audioCheck(config(freshDataDir()))).resolves.toMatchObject({
        severity: "ok",
        message: expect.stringContaining("enable playback from the Mac popover"),
      });
    } finally {
      if (previous === undefined) delete process.env.HEARABLE_WEB_ROOT;
      else process.env.HEARABLE_WEB_ROOT = previous;
    }
  });

  it("audio readiness fails when the configured console path is unreadable", async () => {
    const previous = process.env.HEARABLE_WEB_ROOT;
    process.env.HEARABLE_WEB_ROOT = "/definitely/missing/hearable-console";
    try {
      await expect(realDeps().audioCheck(config(freshDataDir()))).resolves.toMatchObject({
        severity: "fail",
        fix: expect.stringContaining("Build the audio renderer"),
      });
    } finally {
      if (previous === undefined) delete process.env.HEARABLE_WEB_ROOT;
      else process.env.HEARABLE_WEB_ROOT = previous;
    }
  });

  it("start passes an injected web root through to the daemon", async () => {
    const fx = harness({ webRoot: () => "/tmp/webroot" });
    const code = await runHearable(["start"], fx.deps, fx.io);
    expect(code).toBe(0);
    expect(fx.seen.startOptions?.webRoot).toBe("/tmp/webroot");
  });

  it("refuses plainly when a daemon is already running", async () => {
    const fx = harness({
      startDaemon: async () => {
        throw new DaemonAlreadyRunningError(
          "Another hearable daemon is already running (pid 42 on port 4876). Stop that one first, or configure a different port in ~/.config/hearable/config.json.",
        );
      },
    });
    const code = await runHearable(["start"], fx.deps, fx.io);
    expect(code).toBe(1);
    expect(fx.err.join("\n")).toContain("already running");
  });

  it("surfaces a config error when the config file is invalid", async () => {
    const fx = harness({
      loadConfig: () => {
        throw new ConfigError(
          'The config file at /tmp/nope.json is not valid: the daemon runs on loopback only in this phase; use 127.0.0.1, localhost or ::1 (field "host"). Fix or remove the file, and try again.',
        );
      },
    });
    const code = await runHearable(["start"], fx.deps, fx.io);
    expect(code).toBe(1);
    expect(fx.err.join("\n")).toContain("loopback only in this phase");
  });

  it("record passes --name, --redact=paths and --raw one-for-one to the recorder", async () => {
    const fx = harness();
    const code = await runHearable(
      ["record", "--name", "stuck-auth", "--redact=paths", "--raw"],
      fx.deps,
      fx.io,
    );
    expect(code).toBe(0);
    expect(fx.seen.recorderOptions).toMatchObject({
      filePath: join(fx.deps.localRecordingsDir(), "stuck-auth.jsonl"),
      agent: "unknown",
      redact: "paths",
      raw: true,
    });
    // The recorder's record/recordRaw seams are wired into the daemon verbatim.
    expect(typeof fx.seen.startOptions?.record).toBe("function");
    expect(typeof fx.seen.startOptions?.recordRaw).toBe("function");
    expect(fx.out.join("\n")).toContain('Recording "stuck-auth" to');
  });

  it("record refuses a name that another live recording owns", async () => {
    const dataDir = freshDataDir();
    // A fake running recording: same pid as this process, so it counts as live.
    writeFileSync(join(dataDir, "record-taken.pid"), `${process.pid}\n`, "utf8");
    const fx = harness({ loadConfig: () => config(dataDir) });
    const code = await runHearable(["record", "--name", "taken"], fx.deps, fx.io);
    expect(code).toBe(1);
    expect(fx.err.join("\n")).toContain('A recording named "taken" is already running.');
  });

  it("reclaims a stale recording-control file left by a dead process", async () => {
    const dataDir = freshDataDir();
    // Simulate a crashed recording: spawn a short-lived child so its pid is a
    // real pid that has since exited.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(dead.status).toBe(0);
    expect(dead.pid).toBeGreaterThan(0);
    const pidPath = join(dataDir, "record-stale.pid");
    writeFileSync(pidPath, `${dead.pid}\n`, "utf8");
    const fx = harness({ loadConfig: () => config(dataDir) });
    const code = await runHearable(["record", "--name", "stale"], fx.deps, fx.io);
    expect(code).toBe(0);
    // The stale file was removed, then claimed afresh with this process's pid.
    expect(readFileSync(pidPath, "utf8").trim()).toBe(String(process.pid));
    expect(fx.err.join("\n")).toBe("");
  });

  it("record --stop with no control file reports plainly", async () => {
    const fx = harness();
    const code = await runHearable(["record", "--name", "ghost", "--stop"], fx.deps, fx.io);
    expect(code).toBe(1);
    expect(fx.err.join("\n")).toContain('No recording named "ghost" is running.');
  });

  it("replay passes files, speed and the live ingest to the replayer and prints summaries", async () => {
    const fx = harness();
    const code = await runHearable(
      ["replay", "a.jsonl", "b.jsonl", "--speed", "10"],
      fx.deps,
      fx.io,
    );
    expect(code).toBe(0);
    expect(fx.seen.replayFiles).toEqual(["a.jsonl", "b.jsonl"]);
    expect(fx.seen.replayOptions).toEqual({ speed: 10 });
    // The replayer feeds the daemon's live ingest handle, not a parallel path.
    expect(fx.seen.replayerDeps?.ingest).toBe(fx.seen.ingests[0]);
    expect(fx.out.join("\n")).toContain("Replayed a.jsonl: 3 events from claude-code as replay-1.");
    expect(fx.out.join("\n")).toContain("at 10x speed");
  });

  it("replay clears the daemon lock and surfaces an unreadable schema version plainly", async () => {
    let stopped = 0;
    const fx = harness({
      replayRecordingFiles: () => {
        return Promise.reject(
          new RecordingReadError(
            "Cannot replay old.jsonl: it was recorded with schema version 999, which this hearable version cannot read (it reads version 1). Re-record the session with this hearable version and try again.",
          ),
        );
      },
      startDaemon: async () => ({
        port: 0,
        url: "http://127.0.0.1:4876",
        ingest: { handlePostEvents: () => null },
        stop: async () => {
          stopped += 1;
        },
      }),
    });
    const code = await runHearable(["replay", "old.jsonl"], fx.deps, fx.io);
    expect(code).toBe(1);
    expect(fx.err.join("\n")).toContain("schema version 999");
    expect(stopped).toBe(1);
  });

  it("replay rejects a bad --speed at parse time before the daemon starts", async () => {
    const fx = harness();
    const code = await runHearable(["replay", "a.jsonl", "--speed", "banana"], fx.deps, fx.io);
    expect(code).toBe(2);
    expect(fx.seen.startOptions).toBeUndefined();
    expect(fx.err.join("\n")).toMatch(/--speed needs a number greater than zero/);
  });

  it("deferred verbs exit 1 with a message naming their owning phase", async () => {
    for (const [verb, phase] of [
      ["uninstall", "1b"],
      ["emit", "1b"],
      ["acp", "1b"],
    ] as const) {
      const fx = harness();
      const code = await runHearable([verb], fx.deps, fx.io);
      expect(code).toBe(1);
      expect(fx.err.join("\n")).toContain(`Phase ${phase}`);
      expect(fx.err.join("\n")).toContain("not in this phase");
    }
  });

  it("usage errors exit 2 without touching the daemon", async () => {
    const fx = harness();
    const code = await runHearable(["frobnicate"], fx.deps, fx.io);
    expect(code).toBe(2);
    expect(fx.seen.startOptions).toBeUndefined();
    expect(fx.err.join("\n")).toContain("Unknown command");
  });

  it("default local recordings dir anchors to the repository, not the cwd", () => {
    const dir = defaultLocalRecordingsDir();
    expect(dir.endsWith("fixtures-local")).toBe(true);
    expect(dir.includes("packages/cli")).toBe(false);
  });
});
