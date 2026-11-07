// Focuses an existing session's verified local host; must never launch an agent or type into its terminal.
import { execFile } from "node:child_process";
import {
  type FocusProcess,
  type FocusTarget,
  FocusTargetSchema,
  readFocusProcesses,
} from "@hearable/daemon";
import { z } from "zod";
import { hostApplicationScript, itermFocusScript, terminalFocusScript } from "./focus-scripts.js";

export type FocusResult = { status: "focused" | "app-only" | "unavailable"; message: string };
export type SessionIdentity = { agent: string; sessionId: string };
const Host = z.object({
  name: z.string(),
  bundleId: z.string(),
  path: z.string(),
  activated: z.boolean(),
});
const UNAVAILABLE =
  "This session's window is no longer available. Wait for its next hook event, then try again.";

export function runFocusCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

function sameProcess(saved: FocusProcess, live: FocusProcess): boolean {
  return (
    saved.pid === live.pid &&
    saved.startedAt === live.startedAt &&
    saved.executable === live.executable &&
    saved.tty === live.tty
  );
}

export function focusPlan(target: FocusTarget, live: readonly FocusProcess[]) {
  if (target.origin.remote) return null;
  // Ignore a transient hook shell, but require the agent's process to still exist.
  // An old tty or app alone could now belong to a different session.
  const anchor = target.processes.find(
    (entry) => !/(?:^|\/)-?(?:ba|z|fi|da|k|c|tc)?sh$/.test(entry.executable),
  );
  if (!anchor || !live.some((entry) => sameProcess(anchor, entry))) return null;
  const hosts = target.processes.filter(
    (entry) =>
      /\.app\/Contents\/MacOS\/[^/]+$/.test(entry.executable) &&
      live.some((current) => sameProcess(entry, current)),
  );
  if (!hosts.length) return null;
  return { hosts };
}

export async function focusTarget(
  target: FocusTarget,
  identity: SessionIdentity,
  deps = { processes: readFocusProcesses, run: runFocusCommand },
): Promise<FocusResult> {
  if (target.origin.remote)
    return {
      status: "unavailable",
      message: "This agent is on a remote machine. Open its SSH terminal locally.",
    };
  const plan = focusPlan(target, await deps.processes());
  if (!plan) return { status: "unavailable", message: UNAVAILABLE };
  // A GUI app can itself have been launched by another app. Choose the nearest
  // actual running GUI host, skipping command-line/helper .app bundles.
  let host: z.infer<typeof Host> | undefined;
  let hostIndex = 0;
  for (const candidate of plan.hosts) {
    const result = Host.safeParse(
      JSON.parse(
        await deps.run("/usr/bin/osascript", [
          "-l",
          "JavaScript",
          "-e",
          hostApplicationScript,
          String(candidate.pid),
          candidate.executable,
        ]),
      ),
    );
    if (!result.success) continue;
    if (!result.data.activated) return { status: "unavailable", message: UNAVAILABLE };
    host = result.data;
    hostIndex = target.processes.indexOf(candidate);
    break;
  }
  if (!host) return { status: "unavailable", message: UNAVAILABLE };
  const { name, bundleId, path } = host;
  // Stop at this GUI host: a launcher above it may have an unrelated terminal.
  const inner = target.processes.slice(0, hostIndex);
  const device = [...inner].reverse().find((entry) => /^ttys?\w+$/.test(entry.tty))?.tty;
  const tty = device ? `/dev/${device}` : "";
  const multiplexed =
    new Set(inner.map((entry) => entry.tty).filter((tty) => tty !== "??")).size > 1;
  if (
    bundleId === "com.openai.codex" &&
    identity.agent === "codex" &&
    !tty &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(identity.sessionId)
  ) {
    await deps.run("/usr/bin/open", [
      "-a",
      path,
      `codex://threads/${encodeURIComponent(identity.sessionId)}`,
    ]);
    return { status: "focused", message: "" };
  }
  const script =
    bundleId === "com.apple.Terminal"
      ? terminalFocusScript
      : bundleId === "com.googlecode.iterm2"
        ? itermFocusScript
        : null;
  if (script && (tty || target.origin.itermSessionId)) {
    try {
      const focused = await deps.run("/usr/bin/osascript", [
        "-e",
        script,
        tty,
        target.origin.itermSessionId?.split(":").at(-1) ?? "",
      ]);
      if (focused === "focused" && !multiplexed) return { status: "focused", message: "" };
      if (focused !== "focused")
        return {
          status: "app-only",
          message: `Opened ${name}, but this session's terminal tab could not be found. Wait for its next hook event and try again.`,
        };
      if (focused === "focused")
        return {
          status: "app-only",
          message: `Opened the terminal tab in ${name}. Select this agent's pane in your terminal multiplexer.`,
        };
    } catch (error) {
      if (error instanceof Error && /-1743|not authorized|not permitted/i.test(error.message)) {
        return {
          status: "app-only",
          message: `Allow Hearable to control ${name} in System Settings → Privacy & Security → Automation, then try again.`,
        };
      }
      return {
        status: "app-only",
        message: `Opened ${name}, but could not select this terminal tab. Select it manually and try again after its next hook event.`,
      };
    }
  }
  return {
    status: "app-only",
    message: `Opened ${name}. This host does not expose a supported way to select this agent's tab. Select its tab or window in ${name}.`,
  };
}

export function sessionFocuser(origin: string) {
  let busy = false;
  return async (identity: SessionIdentity): Promise<FocusResult> => {
    if (busy)
      return {
        status: "unavailable",
        message: "Another window is opening. Try again in a moment.",
      };
    busy = true;
    try {
      const url = new URL("/session-focus", origin);
      url.search = new URLSearchParams(identity).toString();
      const lookup = () => fetch(url, { signal: AbortSignal.timeout(2000) });
      let response = await lookup();
      // A new hook may replace the capture while the lookup is awaiting ps.
      if (response.status === 409) response = await lookup();
      if (response.status === 404)
        return {
          status: "unavailable",
          message:
            "This session has no window information yet. Wait for its next hook event. If it persists, reinstall its Hearable hooks.",
        };
      if (!response.ok) throw new Error();
      if (!response.headers.get("content-type")?.includes("application/json"))
        return {
          status: "unavailable",
          message: "Restart Hearable and its daemon to enable opening agent windows.",
        };
      return await focusTarget(FocusTargetSchema.parse(await response.json()), identity);
    } catch {
      return {
        status: "unavailable",
        message:
          "Hearable could not open this agent's window. Check that its app is running, then try again.",
      };
    } finally {
      busy = false;
    }
  };
}
