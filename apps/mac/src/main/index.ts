// Composes the menu bar shell; must not contain engine, adapter mapping, or sound logic.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@hearable/daemon";
import { app, dialog, nativeImage, Tray } from "electron";
import { installBridge } from "./bridge.js";
import { agentConnector } from "./connect-agent.js";
import { hostDaemon } from "./daemon-host.js";
import { loginSettings } from "./login.js";
import { createPopover } from "./popover.js";
import { preferences } from "./preferences.js";
import { observeTray } from "./tray-state.js";
import { createConsole } from "./windows.js";

const directory = dirname(fileURLToPath(import.meta.url));
app.setPath(
  "userData",
  process.env.HEARABLE_MAC_DATA_DIR ?? join(app.getPath("appData"), "Hearable"),
);
app.setName("Hearable");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("window-all-closed", () => {});
  void app
    .whenReady()
    .then(async () => {
      app.setActivationPolicy("accessory");
      const profile = app.getPath("userData");
      mkdirSync(profile, { recursive: true });
      const prefs = preferences(join(profile, "preferences.json"));
      const profileConfig = join(profile, "daemon.json");
      const config = loadConfig({
        configFile:
          process.env.HEARABLE_MAC_CONFIG ??
          (existsSync(profileConfig) ? profileConfig : undefined),
      });
      const daemon = await hostDaemon(config, join(directory, "../web"));
      const origin = new URL(daemon.url).origin;
      const consoleWindow = createConsole(origin, join(directory, "../preload/index.cjs"));
      const image = nativeImage.createFromPath(join(directory, "../assets/trayTemplate.png"));
      image.setTemplateImage(true);
      const tray = new Tray(image);
      if (process.env.HEARABLE_MAC_TEST === "1") Object.assign(globalThis, { hearableTray: tray });
      const stopTray = observeTray(tray, origin, join(directory, "../assets"));
      const popover = createPopover(origin, join(directory, "../preload/index.cjs"), tray);
      installBridge({
        origin,
        console: consoleWindow,
        popover: popover.window,
        resize: popover.resize,
        prefs,
        login: loginSettings(app, app.isPackaged),
        connectAgent: app.isPackaged && config.port !== 0 ? agentConnector(origin) : undefined,
      });
      let stopping = false;
      app.on("before-quit", (event) => {
        if (stopping) return;
        event.preventDefault();
        stopping = true;
        stopTray();
        void daemon.stop().finally(() => {
          popover.window.destroy();
          consoleWindow.destroy();
          tray?.destroy();
          app.quit();
        });
      });
      process.on("SIGTERM", () => app.quit());
      process.on("SIGINT", () => app.quit());
    })
    .catch((error: unknown) => {
      dialog.showErrorBox(
        "Hearable could not start",
        `${error instanceof Error ? error.message : String(error)} Reopen Hearable after fixing the problem.`,
      );
      app.exit(1);
    });
}
