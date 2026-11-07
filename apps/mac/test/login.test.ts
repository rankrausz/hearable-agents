// Checks OS login calls without changing owner settings; must not register Electron during tests.
import { expect, it, vi } from "vitest";
import { loginSettings } from "../src/main/login.js";

it("sets the packaged app login item and reports required OS approval", () => {
  const setLoginItemSettings = vi.fn();
  const settings = loginSettings(
    {
      getLoginItemSettings: () => ({ openAtLogin: true, status: "requires-approval" }),
      setLoginItemSettings,
    },
    true,
  );
  expect(settings.set(true)).toMatchObject({
    available: true,
    enabled: true,
    status: expect.stringContaining("System Settings"),
  });
  expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  settings.set(false);
  expect(setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
});
it("keeps the development Electron binary out of login items", () => {
  const setLoginItemSettings = vi.fn();
  const settings = loginSettings(
    {
      getLoginItemSettings: () => ({ openAtLogin: false, status: "not-registered" }),
      setLoginItemSettings,
    },
    false,
  );
  expect(settings.get()).toMatchObject({ available: false, enabled: false });
  expect(() => settings.set(true)).toThrow("Install Hearable.app");
  expect(setLoginItemSettings).not.toHaveBeenCalled();
});
