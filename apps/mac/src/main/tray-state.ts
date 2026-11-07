// Reads observed daemon frames for the tray; must not infer lifecycle or claim an audio endpoint.
import { nativeImage, type Tray } from "electron";
import WebSocket from "ws";
import { z } from "zod";
import { traySummary } from "./policy.js";

const Session = z.object({ agent: z.string(), sessionId: z.string() });
const Frame = z.object({
  type: z.enum(["snapshot", "events"]),
  signals: z.array(z.object({ agent: z.string(), sessionId: z.string(), lifecycle: z.string() })),
  lanes: z.array(z.object({ sessions: z.array(Session) })).optional(),
  queued: z.array(Session).optional(),
});

export function observeTray(tray: Tray, origin: string, assets: string) {
  const images = {
    normal: nativeImage.createFromPath(`${assets}/trayTemplate.png`),
    waiting: nativeImage.createFromPath(`${assets}/trayWaitingTemplate.png`),
  };
  images.normal.setTemplateImage(true);
  images.waiting.setTemplateImage(true);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket | undefined;
  let snapshot = {
    signals: [] as { agent: string; sessionId: string; lifecycle: string }[],
    lanes: [] as { sessions: { agent: string; sessionId: string }[] }[],
    queued: [] as { agent: string; sessionId: string }[],
  };
  let previous = "";
  function render(connected: boolean) {
    const next = traySummary(snapshot, connected);
    if (next.icon !== previous) {
      tray.setImage(images[next.icon]);
      previous = next.icon;
    }
    tray.setToolTip(next.tooltip);
  }
  function connect() {
    socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws`);
    socket.on("message", (bytes) => {
      try {
        const parsed = Frame.safeParse(JSON.parse(String(bytes)));
        if (!parsed.success) return;
        snapshot = {
          signals: parsed.data.signals,
          lanes: parsed.data.lanes ?? snapshot.lanes,
          queued: parsed.data.queued ?? snapshot.queued,
        };
        render(true);
      } catch {
        /* Invalid frames cannot manufacture a waiting indication. */
      }
    });
    socket.on("error", () => socket?.close());
    socket.on("close", () => {
      if (closed) return;
      render(false);
      timer = setTimeout(connect, 1000);
    });
  }
  render(false);
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    socket?.close();
  };
}
