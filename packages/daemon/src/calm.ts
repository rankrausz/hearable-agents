// packages/daemon/src/calm.ts — the daemon-owned Calm preference. What this is
// for: validating and persisting the one global attention control without
// exposing arbitrary config writes. What it must not do: compute attention or
// hold browser state.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_CALM = 0.6;
export const CalmSchema = z.number().min(0).max(1);
const CalmFileSchema = z.strictObject({ calm: CalmSchema });

export class CalmError extends Error {}

export type CalmStore = {
  get(): number;
  warning(): string | null;
  set(calm: number): void;
};

export function createCalmStore(dataDir: string): CalmStore {
  const filePath = join(dataDir, "calm.json");
  const loaded = readCalm(filePath);
  let current = loaded.value;
  let warning = loaded.warning;
  return {
    get: () => current,
    warning: () => warning,
    set(next) {
      const parsed = CalmSchema.safeParse(next);
      if (!parsed.success) {
        throw new CalmError("Calm must be a number from 0 to 1.");
      }
      current = parsed.data;
      warning = null;
      writeFileSync(filePath, `${JSON.stringify({ calm: current })}\n`, "utf8");
    },
  };
}

function readCalm(filePath: string): { value: number; warning: string | null } {
  if (!existsSync(filePath)) return { value: DEFAULT_CALM, warning: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    const result = CalmFileSchema.safeParse(parsed);
    if (!result.success) {
      return invalidCalmFile();
    }
    return { value: result.data.calm, warning: null };
  } catch {
    return invalidCalmFile();
  }
}

function invalidCalmFile(): { value: number; warning: string } {
  return {
    value: DEFAULT_CALM,
    warning:
      "The persisted Calm value could not be used, so the daemon is using default Calm 0.6. Fix or remove calm.json.",
  };
}
