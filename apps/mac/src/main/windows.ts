// Creates isolated daemon windows; must not grant Node access or allow external navigation.
import { BrowserWindow, type Session } from "electron";
import { sameOrigin, windowOptions } from "./policy.js";

export function secureSession(session: Session, origin: string): void {
  const websocket = origin.replace(/^http/, "ws");
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onHeadersReceived((details, callback) => {
    if (!sameOrigin(details.url.replace(/^ws/, "http"), origin)) {
      callback({ cancel: true });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ${websocket}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
        ],
      },
    });
  });
}

export function createConsole(origin: string, preload: string): BrowserWindow {
  const window = new BrowserWindow(windowOptions(preload));
  secureNavigation(window, origin);
  window.on("close", (event) => {
    event.preventDefault();
    window.hide();
  });
  secureSession(window.webContents.session, origin);
  void window.loadURL(origin);
  return window;
}

export function secureNavigation(window: BrowserWindow, origin: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!sameOrigin(url, origin)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!sameOrigin(url, origin)) event.preventDefault();
  });
}
