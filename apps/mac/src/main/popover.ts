// Anchors the compact daemon view to the tray; must not own product state or audio.
import { BrowserWindow, screen, type Tray } from "electron";
import { popoverPosition, windowOptions } from "./policy.js";

import { secureNavigation } from "./windows.js";

export function createPopover(origin: string, preload: string, tray: Tray) {
  const window = new BrowserWindow({
    ...windowOptions(preload),
    width: 320,
    height: 360,
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
  });
  secureNavigation(window, origin);
  window.on("blur", () => window.hide());
  window.on("close", (event) => {
    event.preventDefault();
    window.hide();
  });
  const position = () => {
    const bounds = tray.getBounds();
    const work = screen.getDisplayMatching(bounds).workArea;
    const size = window.getBounds();
    const point = popoverPosition(bounds, work, size);
    window.setPosition(point.x, point.y);
  };
  tray.on("click", () => {
    if (window.isVisible()) window.hide();
    else {
      position();
      window.show();
      window.focus();
    }
  });
  void window.loadURL(`${origin}/?view=popover`);
  return {
    window,
    resize(height: number) {
      const work = screen.getDisplayMatching(tray.getBounds()).workArea;
      window.setSize(320, Math.min(height, work.height));
      position();
    },
  };
}
