// packages/cli/src/service.ts — user-service registration for the foreground
// daemon. What this is for: generating and installing the small platform service
// definition that runs `hearable start`, with logs in the daemon data directory.
// What it must not do: start a second daemon implementation or change daemon
// locking, HTTP, or event behaviour.

import { execFile as nodeExecFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { DaemonConfig } from "@hearable/daemon";

const execFile = promisify(nodeExecFile);
const SERVICE_LABEL = "com.hearable.daemon";
const SERVICE_UNIT = "hearable.service";

export type ServicePlatform = "darwin" | "linux" | "win32" | "unsupported";
export type ServiceAction = "install" | "uninstall" | "status";

export type ServiceDeps = {
  platform: () => NodeJS.Platform;
  homeDir: () => string;
  executable: () => { command: string; args: string[] };
  run: (command: string, args: readonly string[]) => Promise<void>;
  configFile?: () => string | undefined;
};

export type ServiceResult = {
  message: string;
  installed: boolean;
  running?: boolean;
};

export function realServiceDeps(): ServiceDeps {
  return {
    platform: () => process.platform,
    homeDir: homedir,
    executable: serviceExecutable,
    run: async (command, args) => {
      await execFile(command, [...args]);
    },
    configFile: () => process.env.HEARABLE_CONFIG_FILE,
  };
}

export function servicePlatform(platform: NodeJS.Platform): ServicePlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  return "unsupported";
}

export function servicePath(platform: ServicePlatform, homeDir: string): string | null {
  if (platform === "darwin")
    return join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  if (platform === "linux") return join(homeDir, ".config", "systemd", "user", SERVICE_UNIT);
  return null;
}

export function serviceDefinition(
  platform: ServicePlatform,
  config: DaemonConfig,
  executable: { command: string; args: string[] },
  configFile?: string,
): string | null {
  const logDir = config.dataDir;
  if (platform === "darwin") {
    const args = [executable.command, ...executable.args, "start"];
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${SERVICE_LABEL}</string>`,
      `  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xmlEscape(arg)}</string>`).join("")}</array>`,
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      ...(configFile === undefined
        ? []
        : [
            `  <key>EnvironmentVariables</key><dict><key>HEARABLE_CONFIG_FILE</key><string>${xmlEscape(configFile)}</string></dict>`,
          ]),
      `  <key>StandardOutPath</key><string>${xmlEscape(join(logDir, "service.stdout.log"))}</string>`,
      `  <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, "service.stderr.log"))}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
  }
  if (platform === "linux") {
    const command = [executable.command, ...executable.args, "start"].map(shellQuote).join(" ");
    return [
      "[Unit]",
      "Description=Hearable daemon",
      "",
      "[Service]",
      `ExecStart=${command}`,
      `WorkingDirectory=${shellQuote(config.dataDir)}`,
      ...(configFile === undefined
        ? []
        : [`Environment=HEARABLE_CONFIG_FILE=${shellQuote(configFile)}`]),
      `StandardOutput=append:${join(logDir, "service.stdout.log")}`,
      `StandardError=append:${join(logDir, "service.stderr.log")}`,
      "Restart=on-failure",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }
  return null;
}

export async function manageService(
  action: ServiceAction,
  config: DaemonConfig,
  deps: ServiceDeps = realServiceDeps(),
): Promise<ServiceResult> {
  const platform = servicePlatform(deps.platform());
  if (platform === "win32") {
    return {
      installed: false,
      message:
        action === "status"
          ? "User-service management is manual on Windows in this build; no startup entry is managed."
          : `User-service ${action} is manual on Windows in this build; run hearable start yourself.`,
    };
  }
  if (platform === "unsupported") {
    return {
      installed: false,
      message: "User-service management is not supported on this platform.",
    };
  }

  const home = deps.homeDir();
  const path = servicePath(platform, home);
  if (path === null) throw new Error("Could not determine the user-service path.");
  const serviceUser = platform === "darwin" ? `gui/${process.getuid?.() ?? ""}` : null;
  if (action === "install") {
    const definition = serviceDefinition(platform, config, deps.executable(), deps.configFile?.());
    if (definition === null) throw new Error("Could not generate the user-service definition.");
    mkdirSync(config.dataDir, { recursive: true });
    mkdirSync(join(path, ".."), { recursive: true });
    if (platform === "darwin") {
      await runIgnoringAbsentService(deps, platform, "launchctl", [
        "bootout",
        serviceUser ?? "",
        path,
      ]);
    }
    writeFileSync(path, definition, "utf8");
    if (platform === "darwin") {
      await deps.run("launchctl", ["bootstrap", serviceUser ?? "", path]);
    } else {
      await deps.run("systemctl", ["--user", "daemon-reload"]);
      await deps.run("systemctl", ["--user", "enable", "--now", SERVICE_UNIT]);
    }
    return {
      installed: true,
      running: true,
      message: `The hearable daemon user service is installed at ${path}.`,
    };
  }
  if (action === "uninstall") {
    if (platform === "darwin") {
      await runIgnoringAbsentService(deps, platform, "launchctl", [
        "bootout",
        serviceUser ?? "",
        path,
      ]);
    } else {
      await runIgnoringAbsentService(deps, platform, "systemctl", [
        "--user",
        "disable",
        "--now",
        SERVICE_UNIT,
      ]);
      await deps.run("systemctl", ["--user", "daemon-reload"]);
    }
    rmSync(path, { force: true });
    return { installed: false, message: "The hearable daemon user service was removed." };
  }

  if (!existsSync(path)) {
    return {
      installed: false,
      running: false,
      message: "The hearable daemon user service is not installed.",
    };
  }
  const running = await daemonIsHealthy(config);
  return {
    installed: true,
    running,
    message: running
      ? "The hearable daemon user service is installed and running."
      : "The hearable daemon user service is installed but stopped.",
  };
}

async function daemonIsHealthy(config: DaemonConfig): Promise<boolean> {
  try {
    const response = await fetch(`http://${config.host}:${config.port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function runIgnoringAbsentService(
  deps: ServiceDeps,
  platform: ServicePlatform,
  command: string,
  args: readonly string[],
): Promise<void> {
  try {
    await deps.run(command, args);
  } catch (error) {
    if (!isAbsentServiceError(platform, error)) throw error;
  }
}

function isAbsentServiceError(platform: ServicePlatform, error: unknown): boolean {
  if (!(error instanceof Error) || !("stderr" in error)) return false;
  const stderr = String(error.stderr).toLowerCase();
  if (platform === "darwin") {
    return stderr.includes("could not find service") || stderr.includes("service is not loaded");
  }
  return (
    stderr.includes("unit hearable.service does not exist") ||
    stderr.includes("unit hearable.service not loaded") ||
    stderr.includes("unit file hearable.service does not exist")
  );
}

function serviceExecutable(): { command: string; args: string[] } {
  const args = process.execArgv.map((arg) =>
    arg.startsWith("./") && !isAbsolute(arg) ? resolve(arg) : arg,
  );
  return { command: process.execPath, args: [...args, resolve(process.argv[1] ?? "")] };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
