// Persists shell-only choices; must not store agent payloads or alter browser preferences.
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const Preferences = z.object({ audioEnabled: z.boolean().default(false) });
export function preferences(path: string) {
  let value = Preferences.parse({});
  try {
    value = Preferences.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    /* First launch stays silent. */
  }
  return {
    get: () => value,
    audio(enabled: boolean) {
      const next = { ...value, audioEnabled: enabled };
      writeFileSync(path, JSON.stringify(next), { mode: 0o600 });
      value = next;
    },
  };
}
