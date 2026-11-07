// packages/adapter-kit/src/last-tool.ts — the bounded last-tool record the
// caller threads in MapContext alongside pendingToolStarts. What this is for:
// letting a Stop-style mapping apply a "last tool was X" rule after that tool
// already completed: the caller forgets a pending start on tool.end/fail, so
// pending starts alone cannot answer what ran last, while this record
// (most-recent tool name per session, from tool.start/end/fail in order,
// capped) survives the tool's own end. What it must not do: keep state (the
// caller owns the list and passes it back on the context object), or name any
// agent — the record is tool names and session ids only, so every adapter
// family shares it. NOTE (p1-t03, pre-p1-t07): this module is the one
// post-p1-t02 addition to the kit; p1-t07 owns the kit next and should treat
// this file as settled contract, not scaffolding.

import type { NormalizedEvent } from "@hearable/core";
import type { MapContext } from "./adapter.js";

/** The most recent tool observed for one session. */
export type LastToolRecord = {
  /** The session (a subagent id for subagent calls), matching PendingToolStart. */
  readonly sessionId: string;

  /** The agent's tool name, exactly as the payload carried it. */
  readonly toolName: string;

  /** Event time of the tool event the name was observed on. */
  readonly at: number;
};

export type LastToolRecords = readonly LastToolRecord[];

/** Cap on retained records; one entry per session, oldest sessions dropped first. */
export const LAST_TOOL_RECORD_BOUND = 32;

/**
 * The caller-threading contract: MapContext plus the optional bounded
 * last-tool list. The daemon threads one of these per session; tests build
 * it by hand with nextLastToolRecords.
 */
export type LastToolContext = MapContext & {
  readonly lastToolRecords?: LastToolRecords;
};

/**
 * Folds mapped events into the threaded record: every tool.start/end/fail
 * (in order) refreshes its session's entry to that tool name; other kinds
 * are ignored. Most-recent-wins per session, capped at LAST_TOOL_RECORD_BOUND
 * entries. Pure: returns a new list, never mutates.
 */
export function nextLastToolRecords(
  prev: LastToolRecords | undefined,
  events: readonly NormalizedEvent[],
): LastToolRecords {
  const merged: LastToolRecord[] = [...(prev ?? [])];
  for (const event of events) {
    if (event.kind !== "tool.start" && event.kind !== "tool.end" && event.kind !== "tool.fail") {
      continue;
    }
    const record: LastToolRecord = {
      sessionId: event.sessionId,
      toolName: event.tool.name,
      at: event.ts,
    };
    const index = merged.findIndex((entry) => entry.sessionId === event.sessionId);
    if (index === -1) {
      merged.push(record);
    } else {
      merged[index] = record;
    }
  }
  return merged.slice(Math.max(0, merged.length - LAST_TOOL_RECORD_BOUND));
}

/**
 * The last tool name observed for a session, or null when the caller threads
 * no record for it. Reads only the optional extension field — never throws
 * on a plain MapContext.
 */
export function readLastToolName(ctx: MapContext, sessionId: string): string | null {
  const records = (ctx as LastToolContext).lastToolRecords;
  if (records === undefined) {
    return null;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const entry = records[index];
    if (entry !== undefined && entry.sessionId === sessionId) {
      return entry.toolName;
    }
  }
  return null;
}
