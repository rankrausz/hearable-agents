// Checks shell policy without launching Electron; must not require a desktop or touch sound.
import { describe, expect, it } from "vitest";
import {
  audioMayAutostart,
  daemonAction,
  popoverPosition,
  sameOrigin,
  traySummary,
  windowOptions,
} from "../src/main/policy.js";

describe("daemon ownership", () => {
  it("adopts a healthy daemon and waits for a live lock before starting", () => {
    expect(daemonAction(true, true)).toBe("adopt");
    expect(daemonAction(true, false)).toBe("adopt");
    expect(daemonAction(false, true)).toBe("wait");
    expect(daemonAction(false, false)).toBe("start");
  });
});
it("autostarts only a remembered shell choice", () => {
  expect(audioMayAutostart(true, true)).toBe(true);
  expect(audioMayAutostart(true, false)).toBe(false);
  expect(audioMayAutostart(false, true)).toBe(false);
});
it("limits navigation to the daemon origin", () => {
  expect(sameOrigin("http://127.0.0.1:4876/?view=popover", "http://127.0.0.1:4876")).toBe(true);
  expect(sameOrigin("https://example.com", "http://127.0.0.1:4876")).toBe(false);
  expect(sameOrigin("file:///etc/passwd", "http://127.0.0.1:4876")).toBe(false);
});

it("isolates every daemon window and keeps hidden timers running", () => {
  expect(windowOptions("/preload.cjs").webPreferences).toMatchObject({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    backgroundThrottling: false,
    autoplayPolicy: "no-user-gesture-required",
  });
});

it("anchors a popover under the tray and clamps it to screen edges", () => {
  const work = { x: 0, y: 25, width: 1440, height: 875 };
  expect(
    popoverPosition({ x: 700, y: 0, width: 20, height: 25 }, work, { width: 320, height: 360 }),
  ).toEqual({ x: 550, y: 30 });
  expect(
    popoverPosition({ x: 1420, y: 0, width: 20, height: 25 }, work, { width: 320, height: 360 }),
  ).toEqual({ x: 1120, y: 30 });
  expect(
    popoverPosition(
      { x: -1920, y: 0, width: 20, height: 25 },
      { x: -1920, y: 25, width: 1920, height: 1055 },
      { width: 320, height: 360 },
    ),
  ).toEqual({ x: -1920, y: 30 });
});

it("marks only live waiting lanes and names the tray state in words", () => {
  const snapshot = {
    signals: [
      { agent: "emit", sessionId: "a", lifecycle: "active" },
      { agent: "emit", sessionId: "b", lifecycle: "waiting" },
      { agent: "emit", sessionId: "old", lifecycle: "waiting" },
    ],
    lanes: [
      { sessions: [{ agent: "emit", sessionId: "a" }] },
      { sessions: [{ agent: "emit", sessionId: "b" }] },
    ],
    queued: [],
  };
  expect(traySummary(snapshot)).toEqual({
    icon: "waiting",
    tooltip: "2 agents, 1 waiting for you",
  });
  expect(traySummary({ ...snapshot, signals: [] })).toEqual({
    icon: "normal",
    tooltip: "2 agents",
  });
  expect(traySummary(snapshot, false)).toEqual({
    icon: "normal",
    tooltip: "Hearable is disconnected",
  });
});

it("keeps equal session IDs from different agents distinct", () => {
  expect(
    traySummary({
      signals: [{ agent: "codex", sessionId: "same", lifecycle: "waiting" }],
      lanes: [
        {
          sessions: [
            { agent: "codex", sessionId: "same" },
            { agent: "claude-code", sessionId: "same" },
          ],
        },
      ],
      queued: [],
    }),
  ).toEqual({ icon: "waiting", tooltip: "2 agents, 1 waiting for you" });
});
