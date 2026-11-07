// Pure shell decisions; must not probe processes, touch audio, or infer agent work.
import type { BrowserWindowConstructorOptions, Rectangle } from "electron";

export function windowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    show: false,
    width: 1100,
    height: 760,
    title: "Hearable",
    backgroundColor: "#171b21",
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
      webSecurity: true,
    },
  };
}

export function daemonAction(healthy: boolean, liveLock: boolean): "adopt" | "start" | "wait" {
  return healthy ? "adopt" : liveLock ? "wait" : "start";
}

export function audioMayAutostart(shell: boolean, remembered: boolean): boolean {
  return shell && remembered;
}

export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export function popoverPosition(
  tray: Rectangle,
  work: Rectangle,
  size: { width: number; height: number },
) {
  return {
    x: Math.round(
      Math.max(
        work.x,
        Math.min(tray.x + tray.width / 2 - size.width / 2, work.x + work.width - size.width),
      ),
    ),
    y: Math.round(
      Math.max(work.y, Math.min(tray.y + tray.height + 5, work.y + work.height - size.height)),
    ),
  };
}

export function traySummary(
  snapshot: {
    signals: readonly { agent: string; sessionId: string; lifecycle: string }[];
    lanes: readonly { sessions: readonly { agent: string; sessionId: string }[] }[];
    queued: readonly unknown[];
  },
  connected = true,
): { icon: "normal" | "waiting"; tooltip: string } {
  if (!connected) return { icon: "normal", tooltip: "Hearable is disconnected" };
  const key = (session: { agent: string; sessionId: string }) =>
    JSON.stringify([session.agent, session.sessionId]);
  const sessions = new Set(snapshot.lanes.flatMap((lane) => lane.sessions.map(key)));
  const waiting = new Set(
    snapshot.signals
      .filter((signal) => sessions.has(key(signal)) && signal.lifecycle === "waiting")
      .map(key),
  ).size;
  const count = sessions.size;
  return {
    icon: waiting > 0 ? "waiting" : "normal",
    tooltip: `${count} ${count === 1 ? "agent" : "agents"}${waiting > 0 ? `, ${waiting} waiting for you` : ""}${snapshot.queued.length > 0 ? `, ${snapshot.queued.length} waiting for an audio lane` : ""}`,
  };
}
