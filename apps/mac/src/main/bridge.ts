// Validates named shell actions and their sender; must not expose general IPC or execute page code.
import { app, type BrowserWindow, ipcMain } from "electron";
import { z } from "zod";
import { sessionFocuser } from "./focus.js";
import type { loginSettings } from "./login.js";
import { audioMayAutostart, sameOrigin } from "./policy.js";
import type { preferences } from "./preferences.js";

const Audio = z.strictObject({
  enabled: z.boolean(),
  volume: z.number().min(0).max(1),
  status: z.string().max(200),
});
const Command = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("enabled"), enabled: z.boolean() }),
  z.strictObject({ type: z.literal("volume"), volume: z.number().min(0).max(1) }),
]);
const Action = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("login-state") }),
  z.strictObject({ type: z.literal("set-login"), enabled: z.boolean() }),
  z.strictObject({ type: z.literal("preferences") }),
  z.strictObject({ type: z.literal("remember-audio"), enabled: z.boolean() }),
  z.strictObject({
    type: z.literal("open-agent"),
    agent: z.string().min(1).max(100),
    sessionId: z.string().min(1).max(512),
  }),
  z.strictObject({ type: z.literal("quit") }),
  z.strictObject({ type: z.literal("audio-state") }),
  z.strictObject({ type: z.literal("report-audio"), audio: Audio }),
  z.strictObject({ type: z.literal("audio-command"), command: Command }),
  z.strictObject({ type: z.literal("resize"), height: z.number().int().min(100).max(2000) }),
]);

export function installBridge(options: {
  origin: string;
  console: BrowserWindow;
  popover: BrowserWindow;
  resize(height: number): void;
  prefs: ReturnType<typeof preferences>;
  login: ReturnType<typeof loginSettings>;
}) {
  const openAgent = sessionFocuser(options.origin);
  let audio = { enabled: false, volume: 1, status: "Audio is off" };
  ipcMain.handle("hearable", (event, value: unknown) => {
    const isConsole = event.sender === options.console.webContents;
    if (
      (!isConsole && event.sender !== options.popover.webContents) ||
      event.senderFrame !== event.sender.mainFrame ||
      !sameOrigin(event.senderFrame.url, options.origin)
    )
      throw new Error("This window cannot control Hearable.");
    const action = Action.parse(value);
    switch (action.type) {
      case "login-state":
        return options.login.get();
      case "set-login":
        return options.login.set(action.enabled);
      case "preferences":
        return { audioEnabled: audioMayAutostart(isConsole, options.prefs.get().audioEnabled) };
      case "remember-audio":
        if (isConsole) options.prefs.audio(action.enabled);
        return;
      case "open-agent":
        if (isConsole) throw new Error("Open agents from the popover.");
        return openAgent({ agent: action.agent, sessionId: action.sessionId }).then((result) => {
          if (result.status === "focused") options.popover.hide();
          else if (result.status === "app-only") {
            // Explain partial focus without taking keyboard focus back from the host.
            options.popover.showInactive();
            const notice = setTimeout(() => {
              if (!options.popover.isDestroyed() && !options.popover.isFocused())
                options.popover.hide();
            }, 5000);
            notice.unref();
          } else {
            options.popover.show();
            options.popover.focus();
          }
          return result;
        });
      case "quit":
        app.quit();
        return;
      case "audio-state":
        return audio;
      case "report-audio":
        if (!isConsole) throw new Error("Only the console can report audio.");
        audio = action.audio;
        options.popover.webContents.send("hearable:audio-state", audio);
        return;
      case "audio-command":
        options.console.webContents.send("hearable:audio-command", action.command);
        return;
      case "resize":
        if (!isConsole) options.resize(action.height);
        return;
    }
  });
}
