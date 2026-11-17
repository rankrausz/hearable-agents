// Opt-in installer for the agent's user hooks. The renderer never supplies paths or commands.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeCodeAdapter } from "@hearable/claude-code";
import { codexAdapter } from "@hearable/codex";
import { dialog } from "electron";

const run = promisify(execFile);

export function agentConnector(origin: string) {
  const relayDirectory = join(process.resourcesPath, "hook-runtime");
  const relayPath = join(relayDirectory, "hearable-hook");
  let connecting = false;

  return async function connectAgent(): Promise<void> {
    if (connecting) return;
    connecting = true;
    try {
      const { response } = await dialog.showMessageBox({
        type: "question",
        message: "Connect an agent",
        detail:
          "Choose where Hearable should install user-level hooks. They send agent activity to Hearable on this Mac.",
        buttons: ["Cancel", "Claude Code", "Codex"],
        defaultId: 0,
        cancelId: 0,
      });
      if (response !== 1 && response !== 2) return;

      const claude = response === 1;
      const name = claude ? "Claude Code" : "Codex";
      const adapter = claude ? claudeCodeAdapter : codexAdapter;
      const configDir = claude
        ? join(homedir(), ".claude")
        : (process.env.CODEX_HOME ?? join(homedir(), ".codex"));

      if (relayPath.startsWith("/Volumes/") || relayPath.includes("/AppTranslocation/")) {
        await dialog.showMessageBox({
          type: "warning",
          message: "Move Hearable to Applications first",
          detail:
            "Quit Hearable, copy it to Applications, reopen it from there, and connect again.",
        });
        return;
      }

      try {
        // Exercise the exact installed command without sending an event.
        const probe = run(relayPath, [], { env: { PATH: "/usr/bin:/bin" }, timeout: 5000 });
        probe.child.stdin?.end();
        await probe;
      } catch {
        await dialog.showMessageBox({
          type: "error",
          message: "Hearable’s hook relay is missing or unusable",
          detail: "Replace this copy from the disk image and try again.",
        });
        return;
      }

      try {
        await adapter.install({ configDir, daemonUrl: origin, relayPath });
      } catch {
        await dialog.showMessageBox({
          type: "error",
          message: `Could not install ${name} hooks`,
          detail: `Check that ${join(configDir, claude ? "settings.json" : "hooks.json")} is valid JSON and that you can write to its folder. Then try again.`,
        });
        return;
      }
      await dialog.showMessageBox({
        type: "info",
        message: `${name} hooks are installed`,
        detail: claude
          ? "Start a new Claude Code session to see it in Hearable."
          : "Start a new Codex session and review the Hearable hooks in /hooks if Codex asks you to trust them.",
      });
    } finally {
      connecting = false;
    }
  };
}
