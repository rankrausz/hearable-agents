// Wraps the OS login setting; must not register a development Electron executable or open a window.
import type { LoginItemSettings, Settings } from "electron";

type LoginApi = {
  getLoginItemSettings(): Pick<LoginItemSettings, "openAtLogin" | "status">;
  setLoginItemSettings(settings: Settings): void;
};
export function loginSettings(api: LoginApi, packaged: boolean) {
  function get() {
    if (!packaged)
      return { available: false, enabled: false, status: "Install Hearable.app to open at login." };
    const state = api.getLoginItemSettings();
    return {
      available: true,
      enabled: state.openAtLogin,
      status:
        state.status === "requires-approval"
          ? "Allow Hearable in System Settings → General → Login Items."
          : "",
    };
  }
  return {
    get,
    set(enabled: boolean) {
      if (!packaged) throw new Error("Install Hearable.app before enabling open at login.");
      api.setLoginItemSettings({ openAtLogin: enabled });
      const next = get();
      if (enabled && !next.enabled && !next.status)
        return {
          ...next,
          status:
            "macOS could not enable open at login. Move Hearable to /Applications and reopen it.",
        };
      return next;
    },
  };
}
