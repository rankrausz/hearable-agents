// Logs actual hidden-console heartbeats/elections and OS power events; must not sleep the owner's Mac itself.
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { type EvidenceEvent, summarizeEvidence } from "./evidence.js";
import { consolePage } from "./windows.js";

test("records hidden audio across a real sleep and wake for at least one hour", async () => {
  const diagnostic = process.env.HEARABLE_MAC_DIAGNOSTIC === "1";
  const duration = Number(process.env.HEARABLE_MAC_DURATION_MS ?? 3_600_000);
  if (!Number.isFinite(duration) || duration < 1000 || (!diagnostic && duration < 3_600_000))
    throw new Error(
      "An endurance run needs at least 60 minutes; use explicit diagnostic mode for a short harness check.",
    );
  const executable = process.env.HEARABLE_MAC_EXECUTABLE;
  if (!executable) throw new Error("Set HEARABLE_MAC_EXECUTABLE to the installed Hearable binary.");
  const output = resolve(process.env.HEARABLE_MAC_EVIDENCE_DIR ?? "artifacts/mac-endurance");
  await mkdir(output, { recursive: true });
  const prefix = `${diagnostic ? "diagnostic" : "hour"}-${new Date().toISOString().replaceAll(":", "-")}`;
  const log = join(output, `${prefix}.jsonl`);
  const events: EvidenceEvent[] = [];
  const record = (event: EvidenceEvent) => {
    events.push(event);
    appendFileSync(log, `${JSON.stringify(event)}\n`);
  };
  const dir = await mkdtemp(join(tmpdir(), "hearable-endurance-"));
  const config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({ port: 0, dataDir: dir }));
  const shell = await electron.launch({
    executablePath: executable,
    args: process.env.HEARABLE_MAC_AUDIBLE === "1" ? [] : ["--mute-audio"],
    cwd: dir,
    env: { ...process.env, HEARABLE_MAC_CONFIG: config, HEARABLE_MAC_DATA_DIR: join(dir, "app") },
  });
  let startAt = 0;
  let monitor: ReturnType<typeof setInterval> | undefined;
  try {
    const page = await consolePage(shell);
    await expect(page.getByText("live", { exact: true })).toBeVisible();
    await shell.evaluate(({ powerMonitor, BrowserWindow }) => {
      const events: EvidenceEvent[] = [];
      Object.assign(globalThis, { hearablePowerEvents: events });
      for (const window of BrowserWindow.getAllWindows()) {
        window.on("show", () => events.push({ at: Date.now(), kind: "visibility", visible: true }));
        window.on("hide", () =>
          events.push({
            at: Date.now(),
            kind: "visibility",
            visible: BrowserWindow.getAllWindows().some((item) => item.isVisible()),
          }),
        );
      }
      powerMonitor.on("suspend", () => events.push({ at: Date.now(), kind: "suspend" }));
      powerMonitor.on("resume", () => events.push({ at: Date.now(), kind: "resume" }));
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketFrameSent", ({ response }) => {
      try {
        const type = JSON.parse(response.payloadData).type;
        if (type === "audio-heartbeat") record({ at: Date.now(), kind: "heartbeat" });
        else if (type === "audio-claim") record({ at: Date.now(), kind: "claim" });
        else if (type === "audio-release") record({ at: Date.now(), kind: "release" });
      } catch {
        /* Only protocol control frames are recorded. */
      }
    });
    cdp.on("Network.webSocketFrameReceived", ({ response }) => {
      try {
        const message = JSON.parse(response.payloadData);
        const state =
          message.type === "snapshot"
            ? message.audio
            : message.type === "audio-election"
              ? message
              : null;
        if (state)
          record({
            at: Date.now(),
            kind: "election",
            endpointId: state.endpointId,
            ownerId: state.ownerId,
          });
      } catch {
        /* Agent frames and payloads are never recorded by this harness. */
      }
    });
    await page.evaluate(() =>
      (
        window as unknown as {
          hearableShell: {
            commandAudio(command: { type: "enabled"; enabled: boolean }): Promise<void>;
          };
        }
      ).hearableShell.commandAudio({ type: "enabled", enabled: true }),
    );
    await expect(page.getByText("Audio is running", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    startAt = Date.now();
    let powerIndex = 0;
    async function observe() {
      const observation = await shell.evaluate(({ BrowserWindow }) => ({
        visible: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
        power: (
          globalThis as unknown as {
            hearablePowerEvents: EvidenceEvent[];
          }
        ).hearablePowerEvents,
      }));
      record({ at: Date.now(), kind: "visibility", visible: observation.visible });
      for (const event of observation.power.slice(powerIndex)) record(event);
      powerIndex = observation.power.length;
    }
    await observe();
    monitor = setInterval(() => {
      void observe().catch(() => record({ at: Date.now(), kind: "visibility", visible: true }));
    }, 1000);
    console.log(
      `Ready for owner sleep/wake; all windows hidden. Log: ${log}. ${diagnostic ? "DIAGNOSTIC ONLY" : "60-minute evidence run"}`,
    );
    while (Date.now() - startAt < duration)
      await new Promise((done) =>
        setTimeout(done, Math.min(10_000, duration - (Date.now() - startAt))),
      );
    clearInterval(monitor);
    monitor = undefined;
    await observe();
    const endAt = Date.now();
    const summary = {
      ...summarizeEvidence(events, startAt, endAt),
      diagnostic,
      muted: process.env.HEARABLE_MAC_AUDIBLE !== "1",
      startAt,
      endAt,
    };
    await writeFile(
      join(output, `${prefix}-summary.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(JSON.stringify(summary));
    await expect(page.getByText("Audio is running", { exact: true })).toBeVisible();
    if (!diagnostic)
      expect(
        summary.qualifies,
        "The hour, real sleep/wake, hidden windows and uninterrupted lease all need evidence",
      ).toBe(true);
  } finally {
    clearInterval(monitor);
    await shell.close();
    await rm(dir, { recursive: true, force: true });
  }
});
