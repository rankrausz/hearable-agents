// Exercises session targeting and failure messages; must never focus the owner's applications.
import type { FocusProcess, FocusTarget } from "@hearable/daemon";
import { describe, expect, it, vi } from "vitest";
import { focusPlan, focusTarget, sessionFocuser } from "../src/main/focus.js";
import {
  hostApplicationScript,
  itermFocusScript,
  terminalFocusScript,
} from "../src/main/focus-scripts.js";

const agent: FocusProcess = {
  pid: 30,
  ppid: 20,
  tty: "ttys003",
  startedAt: "Thu Oct 29 12:00:00 2026",
  executable: "/usr/local/bin/codex",
};
const login = { ...agent, pid: 20, ppid: 10, executable: "/usr/bin/login" };
const terminal = {
  ...agent,
  pid: 10,
  ppid: 1,
  tty: "??",
  executable: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
};
const target: FocusTarget = { origin: { pid: 30 }, processes: [agent, login, terminal] };
const identity = { agent: "codex", sessionId: "01a18895-105e-7932-9f6e-954b9bf6488b" };
function dependencies(bundleId = "com.apple.Terminal", result = "focused") {
  return {
    processes: vi.fn(async () => target.processes),
    run: vi.fn(async (_file: string, args: string[]) =>
      args.includes(hostApplicationScript)
        ? JSON.stringify({
            name: "Test host",
            bundleId,
            path: "/Applications/Test host.app",
            activated: true,
          })
        : result,
    ),
  };
}

describe("opening an agent", () => {
  it("selects the exact Terminal tab, including an agent launched through a transient shell", async () => {
    const transient = { ...agent, pid: 40, ppid: 30, executable: "/bin/zsh" };
    const deps = dependencies();
    expect(
      await focusTarget({ ...target, processes: [transient, ...target.processes] }, identity, deps),
    ).toEqual({ status: "focused", message: "" });
    expect(deps.run.mock.calls[1]).toEqual([
      "/usr/bin/osascript",
      ["-e", terminalFocusScript, "/dev/ttys003", ""],
    ]);
  });
  it("selects an iTerm2 pane and its containing tab and window", async () => {
    const deps = dependencies("com.googlecode.iterm2");
    await focusTarget(
      { ...target, origin: { pid: 30, itermSessionId: 'w0t1p0:session"id' } },
      identity,
      deps,
    );
    expect(deps.run.mock.calls[1]).toEqual([
      "/usr/bin/osascript",
      ["-e", itermFocusScript, "/dev/ttys003", 'session"id'],
    ]);
  });
  it("opens the native Codex thread only when Codex owns the process", async () => {
    const deps = dependencies("com.openai.codex");
    const native = {
      ...target,
      processes: target.processes.map((entry) => ({ ...entry, tty: "??" })),
    };
    deps.processes.mockResolvedValue(native.processes);
    expect((await focusTarget(native, identity, deps)).status).toBe("focused");
    expect(deps.run.mock.calls[1]).toEqual([
      "/usr/bin/open",
      ["-a", "/Applications/Test host.app", `codex://threads/${identity.sessionId}`],
    ]);
    const cli = dependencies("com.apple.Terminal");
    await focusTarget(target, identity, cli);
    expect(cli.run.mock.calls.some(([file]) => file === "/usr/bin/open")).toBe(false);
  });
  it("does not send invalid IDs or another harness's IDs to Codex", async () => {
    for (const change of [{ sessionId: "id/../../new?prompt=bad" }, { agent: "claude-code" }]) {
      const deps = dependencies("com.openai.codex");
      expect((await focusTarget(target, { ...identity, ...change }, deps)).status).toBe("app-only");
      expect(deps.run).toHaveBeenCalledTimes(1);
    }
  });
  it("refuses a closed or reused process even when its terminal still exists", async () => {
    for (const live of [
      target.processes.slice(1),
      [{ ...agent, startedAt: "new process" }, login, terminal],
    ]) {
      const deps = dependencies();
      deps.processes.mockResolvedValue(live);
      expect((await focusTarget(target, identity, deps)).status).toBe("unavailable");
      expect(deps.run).not.toHaveBeenCalled();
    }
  });
  it("refuses stale host identities and remote PID hints", async () => {
    expect(focusPlan(target, [agent, login, { ...terminal, startedAt: "reused" }])).toBeNull();
    const deps = dependencies();
    expect(
      (await focusTarget({ ...target, origin: { pid: 30, remote: true } }, identity, deps)).status,
    ).toBe("unavailable");
    expect(deps.run).not.toHaveBeenCalled();
  });
  it("explains the macOS permission needed to select a tab", async () => {
    const deps = dependencies();
    deps.run.mockImplementation(async (_file, args) => {
      if (args.includes(terminalFocusScript))
        throw new Error("Not authorized to send Apple events (-1743)");
      return JSON.stringify({
        name: "Terminal",
        bundleId: "com.apple.Terminal",
        path: "/Terminal.app",
        activated: true,
      });
    });
    expect(await focusTarget(target, identity, deps)).toMatchObject({
      status: "app-only",
      message: expect.stringContaining("Privacy & Security → Automation"),
    });
  });
  it("reports application-only focus for hosts without a tab API", async () => {
    expect(await focusTarget(target, identity, dependencies("com.microsoft.VSCode"))).toMatchObject(
      { status: "app-only", message: expect.stringContaining("Select its tab or window") },
    );
  });
  it("does not claim the exact pane when a multiplexer has a second tty", async () => {
    const deps = dependencies();
    expect(
      await focusTarget(
        { ...target, processes: [{ ...agent, tty: "ttys004" }, login, terminal] },
        identity,
        { ...deps, processes: async () => [{ ...agent, tty: "ttys004" }, login, terminal] },
      ),
    ).toMatchObject({ status: "app-only", message: expect.stringContaining("multiplexer") });
    expect(deps.run.mock.calls[1]?.[1][2]).toBe("/dev/ttys003");
  });
});

it("chooses the nearest GUI app, skipping CLI app bundles before considering a parent app", async () => {
  const cli = {
    ...agent,
    executable: "/Applications/Codex.app/Contents/Resources/CodexCLI.app/Contents/MacOS/codex",
  };
  const outer = {
    ...terminal,
    pid: 5,
    executable: "/Applications/Launcher.app/Contents/MacOS/Launcher",
  };
  const nested = { ...target, processes: [cli, login, terminal, outer] };
  const deps = dependencies();
  deps.processes.mockResolvedValue(nested.processes);
  const original = deps.run.getMockImplementation();
  deps.run.mockImplementation(async (file, args) =>
    args.includes(String(cli.pid)) ? "{}" : (original?.(file, args) ?? ""),
  );
  expect((await focusTarget(nested, identity, deps)).status).toBe("focused");
  expect(deps.run.mock.calls[0]?.[1]).toContain(String(cli.pid));
  expect(deps.run.mock.calls[1]?.[1]).toContain(String(terminal.pid));
  expect(deps.run.mock.calls.some(([, args]) => args.includes(String(outer.pid)))).toBe(false);
});

it("serializes native requests and encodes session identity only", async () => {
  let respond: ((response: Response) => void) | undefined;
  const fetch = vi.fn(
    (_url: URL, _options: unknown) =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  try {
    const open = sessionFocuser("http://127.0.0.1:4876");
    const request = open({ agent: "codex", sessionId: "id&agent=other" });
    expect(await open(identity)).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("Another window"),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/session-focus");
    expect(url.searchParams.get("sessionId")).toBe("id&agent=other");
    if (!respond) throw new Error("No pending lookup");
    respond(Response.json({ origin: { pid: 30, remote: true }, processes: [] }));
    expect((await request).message).toContain("remote machine");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("ignores terminal devices belonging to a launcher above the actual host", async () => {
  const outer = {
    ...terminal,
    pid: 5,
    tty: "ttys099",
    executable: "/Applications/Launcher.app/Contents/MacOS/Launcher",
  };
  const nested = { ...target, processes: [...target.processes, outer] };
  const deps = dependencies();
  deps.processes.mockResolvedValue(nested.processes);
  expect((await focusTarget(nested, identity, deps)).status).toBe("focused");
  expect(deps.run.mock.calls[1]?.[1][2]).toBe("/dev/ttys003");
});

it("retries once when a new hook replaces the target during lookup", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ origin: { pid: 30, remote: true }, processes: [] }));
  vi.stubGlobal("fetch", fetch);
  try {
    expect((await sessionFocuser("http://127.0.0.1:4876")(identity)).message).toContain(
      "remote machine",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
