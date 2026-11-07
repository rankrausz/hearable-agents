// packages/daemon/src/quarantine.ts — the quarantine store for malformed
// ingest input. What this is for: persisting bad payloads (raw text plus what
// went wrong) to a gitignored JSONL file under the data directory and counting
// them for /health, so nothing the daemon cannot make sense of is lost or
// crashes the pipeline (docs/ARCHITECTURE.md §Failure behaviour). What it must
// not do: throw from the ingest path, buffer unboundedly, or write where it
// could be committed — the data directory default (~/.hearable) is covered by
// the repository's `.hearable/` gitignore rule.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.js";

export type QuarantineEntry = {
  receivedAt: number;
  /** The `x-hearable-agent` header value, when the request carried one. */
  agent: string | null;
  normalized: boolean;
  reason: string;
  /** First N characters of the raw body, so secrets in huge payloads stay mostly off the disk. */
  bodySnippet: string;
};

export type QuarantineStore = {
  /** Records a quarantine entry and increments the running count. Never throws. */
  add(entry: Omit<QuarantineEntry, "receivedAt">): void;
  /** How many payloads have been quarantined since the daemon started. */
  count(): number;
};

const BODY_SNIPPET_CHARS = 100_000;

/** Builds the quarantine store writing under `dataDir/quarantine/`. */
export function createQuarantine(dataDir: string, clock: Clock): QuarantineStore {
  const directory = join(dataDir, "quarantine");
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, "quarantine.jsonl");
  let count = 0;

  return {
    add(entry) {
      count += 1;
      const line = `${JSON.stringify({
        ...entry,
        bodySnippet: entry.bodySnippet.slice(0, BODY_SNIPPET_CHARS),
        receivedAt: clock(),
      })}\n`;
      try {
        appendFileSync(filePath, line, "utf8");
      } catch {
        // The payload is still counted as quarantined; losing the file copy is
        // better than failing a hook that already got its 204.
      }
    },
    count() {
      return count;
    },
  };
}

/** The quarantine directory path, for callers that want to point users at it. */
export function quarantineDirectory(dataDir: string): string {
  return join(dataDir, "quarantine");
}
