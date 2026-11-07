// apps/web/src/protocol.ts — the daemon-to-browser wire shapes this console
// renders. What this is for: naming the snapshot and event frames from
// docs/ARCHITECTURE.md §Daemon wire protocol as local types, with runtime
// guards so a malformed frame never breaks the page. What it must not do:
// derive anything beyond the frames — the client is plain: full snapshot on
// connect, then apply event frames.

export type SessionRefView = {
  sessionId: string;
  agent: string;
  via?: string;
  parentSessionId?: string;
  name: string;
  firstSeenAt: number;
  lastActivityAt: number;
};

export type LaneViewState = {
  laneId: number;
  state: "active" | "free";
  sessions: SessionRefView[];
};

export type ConsoleEvent = {
  id: string;
  ts: number;
  receivedAt: number;
  agent: string;
  via?: string;
  sessionId: string;
  parentSessionId?: string;
  kind: string;
  tool?: { name: string; category?: string; fingerprint?: string; target?: string };
  lifecycle?: { reason: string; confidence?: string; message?: string };
  meta?: Record<string, string | number | boolean>;
};

export type LaneSignal = {
  laneId: number;
  sessionId: string;
  agent: string;
  via?: string;
  lifecycleConfidence: "observed" | "inferred";
  lifecycle: "idle" | "active" | "quiet" | "stale" | "waiting" | "turn_complete";
  waitingReason?: "question" | "permission" | "idle_prompt";
  fidelity: string | null;
  mode: { exploring: number; editing: number; testing: number; other: number };
  displayedMode: "exploring" | "editing" | "testing" | "other";
  activity: number;
  progress: number;
  struggle: number;
  lastEventAt: number;
  turnStartedAt?: number;
  reasons: readonly { at: number; signal: string; delta?: number; text: string }[];
  prominence: number;
  foreground: boolean;
  gestures: readonly { gesture: "arrive" | "question" | "resolve" | "attention"; at: number }[];
};

export type SignalFrame = { serverTime: number; signals: readonly LaneSignal[] };

export type AudioElection = { endpointId: string | null; ownerId: string | null };

export type ServerSnapshot = {
  type: "snapshot";
  lanes: LaneViewState[];
  queued: SessionRefView[];
  serverTime: number;
  signals: readonly LaneSignal[];
  calm: number;
  audio?: AudioElection;
};

export type ServerEvents = {
  type: "events";
  events: ConsoleEvent[];
  signals: readonly LaneSignal[];
  serverTime: number;
  calm: number;
  /**
   * Current lane occupancy. The daemon attaches it to every frame, because
   * lanes change without an event of their own (an idle lane is freed by a
   * timer). Optional so a frame from a daemon that does not send it leaves
   * the last known lanes in place rather than blanking the console.
   */
  lanes?: LaneViewState[];
  queued?: SessionRefView[];
};

export type ServerMessage = ServerSnapshot | ServerEvents;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionRef(value: unknown): value is SessionRefView {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.sessionId === "string" &&
    typeof value.agent === "string" &&
    typeof value.name === "string" &&
    typeof value.firstSeenAt === "number" &&
    typeof value.lastActivityAt === "number"
  );
}

function isLaneView(value: unknown): value is LaneViewState {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.laneId === "number" &&
    (value.state === "active" || value.state === "free") &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isSessionRef)
  );
}

function isConsoleEvent(value: unknown): value is ConsoleEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.ts === "number" &&
    typeof value.sessionId === "string" &&
    typeof value.kind === "string" &&
    typeof value.agent === "string"
  );
}

function isLaneSignal(value: unknown): value is LaneSignal {
  if (!isRecord(value) || typeof value.laneId !== "number" || typeof value.sessionId !== "string")
    return false;
  const mode = value.mode;
  const reasons = value.reasons;
  const lifecycle = value.lifecycle;
  const displayedMode = value.displayedMode;
  const gestures = value.gestures;
  const validLifecycle =
    lifecycle === "idle" ||
    lifecycle === "active" ||
    lifecycle === "quiet" ||
    lifecycle === "stale" ||
    lifecycle === "waiting" ||
    lifecycle === "turn_complete";
  const validDisplayedMode =
    displayedMode === "exploring" ||
    displayedMode === "editing" ||
    displayedMode === "testing" ||
    displayedMode === "other";
  const validWaitingReason =
    value.waitingReason === undefined ||
    value.waitingReason === "question" ||
    value.waitingReason === "permission" ||
    value.waitingReason === "idle_prompt";
  return (
    typeof value.agent === "string" &&
    (value.lifecycleConfidence === "observed" || value.lifecycleConfidence === "inferred") &&
    validLifecycle &&
    validWaitingReason &&
    isRecord(mode) &&
    ["exploring", "editing", "testing", "other"].every((key) => typeof mode[key] === "number") &&
    validDisplayedMode &&
    typeof value.activity === "number" &&
    typeof value.progress === "number" &&
    typeof value.struggle === "number" &&
    typeof value.lastEventAt === "number" &&
    (value.prominence === undefined || typeof value.prominence === "number") &&
    (value.foreground === undefined || typeof value.foreground === "boolean") &&
    (gestures === undefined || Array.isArray(gestures)) &&
    (gestures === undefined ||
      gestures.every(
        (gesture) =>
          isRecord(gesture) &&
          (gesture.gesture === "arrive" ||
            gesture.gesture === "question" ||
            gesture.gesture === "resolve" ||
            gesture.gesture === "attention") &&
          typeof gesture.at === "number",
      )) &&
    (value.fidelity === null || typeof value.fidelity === "string") &&
    Array.isArray(reasons) &&
    reasons.every(
      (reason) =>
        isRecord(reason) && typeof reason.at === "number" && typeof reason.text === "string",
    )
  );
}

function normalizeLaneSignal(signal: LaneSignal): LaneSignal {
  return {
    ...signal,
    prominence: signal.prominence ?? 0,
    foreground: signal.foreground ?? false,
    gestures: signal.gestures ?? [],
  };
}

/** True when an unknown value is a frame the console can render. */
export function parseServerMessage(value: unknown): ServerMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.type === "snapshot") {
    if (
      Array.isArray(value.lanes) &&
      value.lanes.every(isLaneView) &&
      Array.isArray(value.queued) &&
      value.queued.every(isSessionRef) &&
      typeof value.serverTime === "number" &&
      (value.calm === undefined || typeof value.calm === "number") &&
      (value.signals === undefined ||
        (Array.isArray(value.signals) && value.signals.every(isLaneSignal)))
    ) {
      return {
        ...value,
        calm: typeof value.calm === "number" ? value.calm : 0.6,
        signals: (value.signals ?? []).map(normalizeLaneSignal),
      } as unknown as ServerSnapshot;
    }
    return null;
  }
  if (value.type === "events") {
    if (
      Array.isArray(value.events) &&
      value.events.every(isConsoleEvent) &&
      typeof value.serverTime === "number" &&
      (value.calm === undefined || typeof value.calm === "number") &&
      (value.signals === undefined ||
        (Array.isArray(value.signals) && value.signals.every(isLaneSignal))) &&
      (value.lanes === undefined ||
        (Array.isArray(value.lanes) && value.lanes.every(isLaneView))) &&
      (value.queued === undefined ||
        (Array.isArray(value.queued) && value.queued.every(isSessionRef)))
    ) {
      return {
        ...value,
        calm: typeof value.calm === "number" ? value.calm : 0.6,
        signals: (value.signals ?? []).map(normalizeLaneSignal),
      } as unknown as ServerEvents;
    }
    return null;
  }
  return null;
}

export function parseAudioElection(value: unknown): AudioElection | null {
  if (!isRecord(value) || value.type !== "audio-election") return null;
  return typeof value.endpointId === "string" &&
    (value.ownerId === null || typeof value.ownerId === "string")
    ? { endpointId: value.endpointId, ownerId: value.ownerId }
    : null;
}
