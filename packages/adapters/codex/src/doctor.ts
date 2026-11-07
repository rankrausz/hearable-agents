// packages/adapters/codex/src/doctor.ts — the Codex reality check. What
// this is for: probing the installed Codex version for the four things the
// capabilities depend on — platform support, the hooks feature flag, the
// /hooks trust step, and whether edit events are visible — and reporting
// each check as a plain-language diagnostic with a fix. What it must not
// do: downgrade or upgrade capabilities itself (the daemon attaches the
// declared set; doctor reports what is unverified), or guess at versions
// it cannot observe: an unparsable version is a `warn` with a fix, never
// a silent pass.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "@hearable/adapter-kit";

function ok(message: string): Diagnostic {
  return { severity: "ok", message };
}

function warn(message: string, fix: string): Diagnostic {
  return { severity: "warn", message, fix };
}

function fail(message: string, fix: string): Diagnostic {
  return { severity: "fail", message, fix };
}

function runCodexVersion(codexBin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(codexBin, ["--version"], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout.trim() || stderr.trim());
    });
  });
}

function parseVersion(text: string): { major: number; minor: number } | null {
  const match = /(\d+)\.(\d+)\.\d+/.exec(text);
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function readConfigToml(codexHome: string): Promise<string | null> {
  return readFile(join(codexHome, "config.toml"), "utf8").catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
}

function readHooksJson(codexHome: string): Promise<string | null> {
  return readFile(join(codexHome, "hooks.json"), "utf8").catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
}

function hooksFlagDisabled(configToml: string | null): boolean {
  if (configToml === null) {
    return false;
  }
  return /^\s*hooks\s*=\s*false/m.test(configToml);
}

function hooksFlagEnabled(configToml: string | null): boolean {
  if (configToml === null) {
    return false;
  }
  return /^\s*hooks\s*=\s*true/m.test(configToml);
}

/**
 * Checks the installed Codex reality: version, platform, hooks feature
 * flag, hooks file presence, and edit-event visibility. One diagnostic per
 * check, including the checks that pass. Unverifiable capabilities default
 * to the honest value with a `warn` explaining how to verify.
 */
export async function doctorCodex(options?: {
  codexHome?: string;
  codexBin?: string;
  platform?: NodeJS.Platform;
}): Promise<readonly Diagnostic[]> {
  const codexHome = options?.codexHome ?? process.env.CODEX_HOME ?? join("/tmp", "codex-home");
  const codexBin = options?.codexBin ?? process.env.CODEX_BIN ?? "codex";
  const platform = options?.platform ?? process.platform;
  const findings: Diagnostic[] = [];

  if (platform === "win32") {
    findings.push(
      fail(
        "Codex hooks are disabled on Windows in this Codex version, so no Codex events can be observed there.",
        "Run Codex on macOS or Linux to use Hearable with Codex.",
      ),
    );
  } else {
    findings.push(ok(`This platform (${platform}) supports Codex hooks.`));
  }

  let versionText: string | null = null;
  try {
    versionText = await runCodexVersion(codexBin);
  } catch {
    versionText = null;
  }
  const version = versionText === null ? null : parseVersion(versionText);
  if (versionText === null) {
    findings.push(
      warn(
        "Could not run codex --version, so the installed Codex version is unknown.",
        "Install Codex and make sure codex is on PATH, or set CODEX_BIN to the Codex binary, then run hearable doctor again.",
      ),
    );
  } else if (version === null) {
    findings.push(
      warn(
        `Codex reported a version that could not be read (${versionText}), so hook support is unverified.`,
        "Update Codex to the latest version, then run hearable doctor again.",
      ),
    );
  } else {
    findings.push(ok(`Codex version ${versionText} is installed.`));
    if (version.major === 0 && version.minor < 150) {
      findings.push(
        warn(
          `Codex ${versionText} predates the Interrupt hook (v0.150), so interruptions arrive as nothing instead of turn.end cancelled.`,
          "Update Codex to v0.150 or later to observe interruptions.",
        ),
      );
    }
  }

  let configToml: string | null = null;
  try {
    configToml = await readConfigToml(codexHome);
  } catch {
    findings.push(
      warn(
        "Could not read the Codex config file, so the hooks feature flag is unverified.",
        `Make sure ${join(codexHome, "config.toml")} is readable, then run hearable doctor again.`,
      ),
    );
  }
  if (configToml !== null) {
    if (hooksFlagDisabled(configToml)) {
      findings.push(
        fail(
          "Codex hooks are turned off ([features] hooks = false in config.toml).",
          `Set [features] hooks = true in ${join(codexHome, "config.toml")}, then run hearable doctor again.`,
        ),
      );
    } else if (hooksFlagEnabled(configToml)) {
      findings.push(ok("Codex hooks are enabled in config.toml."));
    } else {
      findings.push(ok("Codex hooks are enabled (the default; no flag turns them off)."));
    }
  }

  let hooksJson: string | null = null;
  try {
    hooksJson = await readHooksJson(codexHome);
  } catch {
    findings.push(
      warn(
        "Could not read the Codex hooks file, so hook installation is unverified.",
        `Make sure ${join(codexHome, "hooks.json")} is readable, then run hearable doctor again.`,
      ),
    );
  }
  if (hooksJson !== null) {
    let hooksObject: unknown;
    try {
      hooksObject = JSON.parse(hooksJson);
    } catch {
      findings.push(
        fail(
          "The Codex hooks file is not valid JSON, so Codex cannot load the Hearable hooks.",
          `Fix or remove ${join(codexHome, "hooks.json")}, then run hearable install codex again.`,
        ),
      );
      hooksObject = null;
    }
    if (hooksObject !== null && hooksJson.includes("hearable-hook --agent codex")) {
      findings.push(ok("The Hearable Codex hooks are installed."));
    } else if (hooksObject !== null) {
      findings.push({
        severity: "fail",
        message: "The Hearable Codex hooks are not installed, so no Codex events reach the daemon.",
        fix: "Run hearable install codex, then open /hooks in Codex to review and trust the new hooks.",
      });
    }
  } else {
    findings.push(
      fail(
        "The Codex hooks file is missing, so no Codex events reach the daemon.",
        `Run hearable install codex, then open /hooks in Codex to review and trust the new hooks at ${join(codexHome, "hooks.json")}.`,
      ),
    );
  }

  // Edit-event visibility is unverified on every version so far: no live
  // session on the build machine has produced apply_patch hook traffic,
  // only the documented shape. The adapter stays honest by declaring
  // editEvents false until that traffic is observed.

  // Assumption labels for the p1-t10 schema review (ADR 0015): the live
  // probe captured SessionStart, UserPromptSubmit and SessionEnd only, so
  // the tool-failure signal, the Stop reason heuristic, subagents and
  // compaction rest on documented shapes. Owner for verification: the
  // first live Codex session with tool traffic (Phase 1b).

  findings.push(
    warn(
      "Tool events, exit-code failure detection, Stop reasons, subagents and compaction follow the documented hook shapes but no live payload of those kinds has been observed on this machine, so they are assumed until live Codex tool traffic verifies them.",
      "Run a live Codex session with tool calls and a Stop on this machine; if the traffic matches the documented shapes, the assumption is verified.",
    ),
  );

  findings.push(
    warn(
      "New or changed Codex hooks need a trust review before they run; untrusted hooks are skipped silently. Open /hooks in Codex to review and trust them.",
      "Open /hooks in Codex, review the Hearable hooks, and trust them.",
    ),
  );

  findings.push({
    severity: "ok",
    message:
      "Codex SessionEnd is advisory and ignored by the adapter: no session.end is emitted, and Codex lanes release by idle timeout instead.",
  });

  findings.push(
    warn(
      "Observed capability: editEvents=false because this installation has produced no file-edit hook events; file-edit visibility remains unverified.",
      "If Codex emits apply_patch PreToolUse/PostToolUse events on this machine, report them so the capability can be verified.",
    ),
  );

  return findings;
}
