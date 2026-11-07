// Exercises portrait identity and connection honesty; must not touch real agent sessions or audio.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDaemon } from "@hearable/daemon";
import { expect, test, type WebSocketRoute } from "@playwright/test";

function session(agent: string, sessionId: string, name: string) {
  return { agent, sessionId, name, firstSeenAt: 1, lastActivityAt: 1 };
}

function signal(ref: ReturnType<typeof session>, laneId: number, change: object = {}) {
  return {
    agent: ref.agent,
    sessionId: ref.sessionId,
    laneId,
    lifecycle: "active",
    lifecycleConfidence: "observed",
    displayedMode: "editing",
    mode: { exploring: 0, editing: 1, testing: 0, other: 0 },
    activity: 0.8,
    progress: 0.4,
    struggle: 0,
    fidelity: null,
    lastEventAt: 1,
    prominence: 0,
    foreground: false,
    gestures: [],
    reasons: [],
    ...change,
  };
}

test("distinguishes working portraits while preserving identity through state changes and reconnecting", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "hearable-portraits-"));
  const daemon = await startDaemon({
    config: { host: "127.0.0.1", port: 0, lanes: 4, laneReleaseAfterMs: 300_000, dataDir: dir },
    adapters: [],
    webRoot: resolve("apps/mac/dist/web"),
  });
  const claude = session(
    "claude-code",
    "shared-id",
    "a-long-project-name-that-needs-full-session-details",
  );
  const codex = session("codex", "shared-id", "web-client");
  const otherClaude = session("claude-code", "another-id", "docs");
  const cursor = session("cursor", "cursor-id", "mobile");
  let sessions = [claude, codex, otherClaude, cursor];
  let signals = sessions.map((item, index) => signal(item, index));
  let queued: ReturnType<typeof session>[] = [];
  let socket: WebSocketRoute | undefined;
  function snapshot(route = socket) {
    if (!route) throw new Error("The browser did not connect");
    route.send(
      JSON.stringify({
        type: "snapshot",
        serverTime: 1,
        calm: 0.6,
        lanes: sessions.map((session, laneId) => ({
          laneId,
          state: "active",
          sessions: [session],
        })),
        signals,
        queued,
      }),
    );
  }
  try {
    await page.routeWebSocket("**/ws", (route) => {
      socket = route;
      snapshot(route);
    });
    await page.goto(`${daemon.url}/?view=popover`);
    const portraits = page.locator(".popover-portrait");
    const first = page.getByRole("article", { name: new RegExp(`Claude Code, ${claude.name},`) });
    await expect(portraits).toHaveCount(4);
    await expect(page.getByRole("button")).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("slider", { name: "Calm", exact: true })).toBeFocused();
    await expect(first.locator(".popover-session")).toHaveText(claude.name);
    const heads = await portraits.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).getPropertyValue("--portrait-head")),
    );
    expect(new Set(heads).size).toBe(4);
    const identity = await first.evaluate((element) => ({
      color: element.getAttribute("data-color"),
      accessory: element.getAttribute("data-accessory"),
      head: getComputedStyle(element).getPropertyValue("--portrait-head"),
    }));
    const mascot = first.locator(".portrait-mascot");
    await expect(first).toHaveAttribute("data-active", "true");
    await expect(mascot).toHaveCSS("animation-name", "portrait-working");
    const initialPose = await mascot.evaluate((element) => getComputedStyle(element).transform);
    await expect
      .poll(() => mascot.evaluate((element) => getComputedStyle(element).transform))
      .not.toBe(initialPose);
    sessions = [cursor, otherClaude, codex, claude];
    signals = sessions.map((item, index) => signal(item, index));
    snapshot();
    await expect(portraits.first()).toHaveAccessibleName(/^Cursor,/);
    await first.click();
    expect(await first.getAttribute("aria-pressed")).toBeNull();
    await expect(page.getByRole("region", { name: "Session details" })).toHaveCount(0);
    for (const [change, expression, label] of [
      [{ displayedMode: "other", activity: 0 }, "working", "Working"],
      [{ displayedMode: "exploring" }, "exploring", "Working"],
      [{ displayedMode: "testing", struggle: 0.8 }, "testing", "Working"],
      [
        { lifecycle: "waiting", waitingReason: "question", lifecycleConfidence: "inferred" },
        "waiting",
        "Waiting for you: question",
      ],
      [{ lifecycle: "turn_complete" }, "done", "Done"],
      [{ lifecycle: "quiet" }, "quiet", "Quiet"],
      [{ lifecycle: "stale" }, "stale", "No recent events"],
    ] as const) {
      signals = sessions.map((item, index) => signal(item, index, item === claude ? change : {}));
      snapshot();
      await expect(first).toHaveAttribute("data-expression", expression);
      const active = ["working", "exploring", "testing"].includes(expression);
      await expect(first).toHaveAttribute("data-active", String(active));
      await expect(mascot).toHaveCSS("animation-name", active ? "portrait-working" : "none");
      await expect(first.locator(".popover-lifecycle")).toHaveText(label);
      await expect(first.locator(".portrait-inferred")).toHaveCount(
        expression === "waiting" ? 1 : 0,
      );
      expect(
        await first.evaluate((element) => ({
          color: element.getAttribute("data-color"),
          accessory: element.getAttribute("data-accessory"),
          head: getComputedStyle(element).getPropertyValue("--portrait-head"),
        })),
      ).toEqual(identity);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await first
        .locator(".portrait-face")
        .evaluate((element) => getComputedStyle(element).transitionDuration),
    ).toBe("0s");
    // Compare the three meanings together at the real popover width, with audio absent.
    sessions = [
      { ...claude, name: "project1" },
      { ...codex, name: "project2" },
      { ...otherClaude, name: "project3" },
    ];
    signals = [
      signal(claude, 0),
      signal(codex, 1, { lifecycle: "quiet" }),
      signal(otherClaude, 2, { lifecycle: "waiting", waitingReason: "question" }),
    ];
    snapshot();
    await expect(portraits.locator(".popover-session")).toHaveText([
      "project1",
      "project2",
      "project3",
    ]);
    await expect(portraits.first()).toHaveAttribute("data-active", "true");
    const working = portraits.first().locator(".portrait-mascot");
    const quiet = page.locator('[data-expression="quiet"] .portrait-mascot');
    const waiting = page.locator('[data-expression="waiting"] .portrait-mascot');
    await page.setViewportSize({ width: 320, height: 700 });
    const screenshots = resolve("test-results/mac-captures");
    await mkdir(screenshots, { recursive: true });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
      await expect(working).toHaveCSS("animation-name", "portrait-working");
      await expect(working).toHaveCSS("filter", "saturate(1.5)");
      await expect(quiet).toHaveCSS("filter", "grayscale(0.85)");
      await expect(waiting).toHaveCSS("filter", "none");
      await expect(waiting).toHaveCSS("animation-name", "none");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(working).toHaveCSS("animation-name", "none");
      await expect(working).toHaveCSS("transition-duration", "0s");
      expect(
        await working.evaluate((element) => getComputedStyle(element, "::before").opacity),
      ).toBe("0.28");
      await page.locator(".popover").screenshot({
        path: join(screenshots, `active-portraits-mixed-${colorScheme}.png`),
        // The native window rounds its corners outside the browser renderer.
        omitBackground: true,
        style: ".popover { border-radius: 16px; overflow: hidden; }",
      });
    }
    await page.emulateMedia({ reducedMotion: "no-preference" });
    sessions = [cursor, otherClaude, codex, claude];
    signals = sessions.map((item, index) => signal(item, index));
    queued = [session("codex", "queued-id", "queued-project")];
    snapshot();
    const queuedPortrait = page.getByRole("article", { name: /^Codex, queued-project,/ });
    await expect(queuedPortrait).toHaveAttribute("data-expression", "queued");
    await expect(queuedPortrait).toHaveAttribute("data-active", "false");
    await expect(queuedPortrait.locator(".portrait-mascot")).toHaveCSS("animation-name", "none");
    await expect(page.getByText(/Tracked but not heard until a lane is free/)).toBeVisible();
    queued = Array.from({ length: 5 }, (_, index) =>
      session("claude-code", `queued-${index}`, `queued-project-${index}`),
    );
    snapshot();
    await expect(portraits).toHaveCount(9);
    const queuedHeads = await portraits.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).getPropertyValue("--portrait-head")),
    );
    expect(new Set(queuedHeads).size).toBe(9);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 320, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      const boxes = await portraits.evaluateAll((elements) =>
        elements.map((e) => e.getBoundingClientRect().toJSON()),
      );
      expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
      expect(boxes[2].x).toBeGreaterThan(boxes[1].x);
      expect(boxes[3].y).toBeGreaterThan(boxes[0].y);
    }
    await socket?.close();
    await expect(page.getByText("Reconnecting", { exact: true })).toBeVisible();
    await expect(page.locator('[data-expression="unavailable"]')).toHaveCount(9);
    await expect(page.locator('.popover-portrait[data-active="true"]')).toHaveCount(0);
    const resting = await page
      .locator(".portrait-mascot")
      .evaluateAll((elements) =>
        elements.every((element) => getComputedStyle(element).animationName === "none"),
      );
    expect(resting).toBe(true);
    await expect(page.locator('.portrait-activity[data-active="true"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open console" })).toHaveCount(0);
  } finally {
    await daemon.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
