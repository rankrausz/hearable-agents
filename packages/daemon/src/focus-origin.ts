// Captures local process identity for window focus; must never read argv, environment, or record it.
import { execFile } from "node:child_process";
import { z } from "zod";

const Hint = z
  .string()
  .max(256)
  .refine((value) =>
    [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
  );
export const FocusOriginSchema = z.strictObject({
  pid: z.number().int().positive().max(2_147_483_647),
  termProgram: Hint.optional(),
  termSessionId: Hint.optional(),
  itermSessionId: Hint.optional(),
  remote: z.boolean().optional(),
});
export const FocusProcessSchema = z.object({
  pid: z.number().int().positive(),
  ppid: z.number().int().nonnegative(),
  tty: z.string().max(100),
  startedAt: z.string().max(100),
  executable: z.string().max(4096),
});
export const FocusTargetSchema = z.object({
  origin: FocusOriginSchema,
  processes: z.array(FocusProcessSchema).max(32),
});
export type FocusOrigin = z.infer<typeof FocusOriginSchema>;
export type FocusProcess = z.infer<typeof FocusProcessSchema>;
export type FocusTarget = z.infer<typeof FocusTargetSchema>;

export function parseFocusOrigin(header: string | null): FocusOrigin | null {
  if (!header || header.length > 2048) return null;
  try {
    const result = FocusOriginSchema.safeParse(
      JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseFocusProcesses(text: string): FocusProcess[] {
  return text.split("\n").flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+?)\s*$/,
    );
    if (!match) return [];
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        tty: match[3] ?? "??",
        startedAt: (match[4] ?? "").replace(/\s+/g, " "),
        executable: match[5] ?? "",
      },
    ];
  });
}

export function processAncestry(pid: number, processes: readonly FocusProcess[]): FocusProcess[] {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const chain: FocusProcess[] = [];
  const seen = new Set<number>();
  let current = byPid.get(pid);
  while (current && current.pid > 1 && !seen.has(current.pid) && chain.length < 32) {
    chain.push(current);
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return chain;
}

export function readFocusProcesses(): Promise<FocusProcess[]> {
  if (process.platform !== "darwin") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid=,tty=,lstart=,comm="],
      {
        timeout: 1000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => resolve(error ? [] : parseFocusProcesses(stdout)),
    );
  });
}

// One in-flight snapshot bounds bursts without retaining a stale process table.
export function focusCapture() {
  let pending: Promise<FocusProcess[]> | undefined;
  return async (origin: FocusOrigin): Promise<FocusTarget> => {
    if (origin.remote) return { origin, processes: [] };
    pending ??= readFocusProcesses().finally(() => {
      pending = undefined;
    });
    return { origin, processes: processAncestry(origin.pid, await pending) };
  };
}
