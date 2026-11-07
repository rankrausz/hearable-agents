// apps/web/src/copy.ts — user-facing words for the bare console.
// What this is for: agent badges, lifecycle words and event lines in plain
// language, sentence case, per docs/UI.md. What it must not do: show anything
// the lanes must not show — lifecycle words come straight from events here.

import type { ConsoleEvent, LaneSignal, SessionRefView } from "./protocol.js";

/** Turns wire vocabulary into words suitable for the console. */
export function modeWord(mode: LaneSignal["displayedMode"]): string {
  switch (mode) {
    case "exploring":
      return "Exploring";
    case "editing":
      return "Editing";
    case "testing":
      return "Testing";
    case "other":
      return "Other";
  }
}

function waitingReasonWord(reason: NonNullable<LaneSignal["waitingReason"]>): string {
  switch (reason) {
    case "question":
      return "question";
    case "permission":
      return "permission";
    case "idle_prompt":
      return "idle prompt";
  }
}

/** Lifecycle text for a daemon-provided signal, without exposing wire ids. */
export function signalLifecycleWord(signal: LaneSignal): string {
  if (signal.lifecycle === "waiting") {
    return `Waiting for you${signal.waitingReason === undefined ? "" : `: ${waitingReasonWord(signal.waitingReason)}`}`;
  }
  if (signal.lifecycle === "active") return "Working";
  if (signal.lifecycle === "turn_complete") return "Done";
  if (signal.lifecycle === "stale") return "No recent events";
  return signal.lifecycle === "idle" || signal.lifecycle === "quiet" ? "Quiet" : signal.lifecycle;
}

/** Short badge text for the agent that owns a session. */
export function agentBadge(agent: string): string {
  switch (agent) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "cursor":
      return "Cursor";
    case "acp":
      return "ACP";
    case "emit":
      return "Script";
    case "replay":
      return "Replay";
    case "sandbox":
      return "Sandbox";
    default:
      return agent;
  }
}

/**
 * Lifecycle in plain words, derived from the latest event for the session
 * only — no inference from other sessions. Unknown sessions are quiet until seen.
 */
export function lifecycleWord(events: readonly ConsoleEvent[], sessionId: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.sessionId !== sessionId) {
      continue;
    }
    switch (event.kind) {
      case "session.start":
        return "started";
      case "session.end":
        return "done";
      case "turn.start":
        return "working";
      case "turn.end":
        if (event.lifecycle?.reason === "question") {
          return "waiting for you: question";
        }
        if (event.lifecycle?.reason === "permission") {
          return "waiting for you: permission";
        }
        if (event.lifecycle?.reason === "completed") {
          return "quiet";
        }
        return "quiet";
      case "tool.start":
        return "working";
      case "tool.end":
        return "working";
      case "tool.fail":
        return "working";
      case "permission.request":
        return "waiting for you: permission";
      case "question.asked":
        return "waiting for you: question";
      case "subagent.start":
        return "working";
      case "subagent.end":
        return "working";
      case "compaction":
        return "working";
      default:
        return "working";
    }
  }
  return "quiet";
}

/** One plain-language line per event for the scrolling log. */
export function eventLine(event: ConsoleEvent): string {
  switch (event.kind) {
    case "session.start":
      return "session started";
    case "session.end":
      return "session ended";
    case "turn.start":
      return "started working";
    case "turn.end":
      return "finished a turn";
    case "tool.start":
      return event.tool?.name !== undefined ? `running ${event.tool.name}` : "running a tool";
    case "tool.end":
      return event.tool?.name !== undefined ? `${event.tool.name} finished` : "tool finished";
    case "tool.fail":
      return event.tool?.name !== undefined ? `${event.tool.name} failed` : "tool failed";
    case "permission.request":
      return "waiting for you: permission";
    case "question.asked":
      return "waiting for you: question";
    case "subagent.start":
      return "started a helper session";
    case "subagent.end":
      return "helper session finished";
    case "compaction":
      return "summarised earlier work";
    case "notification":
      return typeof event.meta?.kind === "string" ? `${event.meta.kind}` : "note";
    case "agent.report":
      return "reported progress";
    default:
      return event.kind;
  }
}

/** Session title: cwd basename from the daemon, falling back to the id. */
export function sessionTitle(session: SessionRefView): string {
  return session.name !== "" ? session.name : session.sessionId;
}

/** Clock time (hours and minutes) for one event. */
export function eventTime(event: ConsoleEvent): string {
  const date = new Date(event.ts > 0 ? event.ts : event.receivedAt);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/**
 * Why sessions sit in the queue (p7b-t03, docs/UI.md §Console): every lane
 * is taken, so a queued agent is tracked but not heard until one frees.
 * Silence with no explanation is the defect this copy exists to prevent.
 */
export function queuedExplanation(laneCount: number, queuedCount: number): string {
  const lanes = COUNT_WORDS[laneCount] ?? String(laneCount);
  const lanesPhrase = laneCount === 1 ? "The one lane is" : `All ${lanes} lanes are`;
  const who = queuedCount === 1 ? "this agent is" : "these agents are";
  const takes = queuedCount === 1 ? "It takes" : "Each takes";
  return `${lanesPhrase} in use, so ${who} tracked but not heard. ${takes} the next lane that frees.`;
}
