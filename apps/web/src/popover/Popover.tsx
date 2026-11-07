// Compact daemon view; must not create an audio context, infer state, or depend on Electron.
import { useEffect, useRef, useState } from "react";
import { connectFeed, defaultFeedUrl, type FeedState } from "../feed.js";
import type { LoginState, ShellAudio } from "../shell.js";
import { AgentPortrait } from "./AgentPortrait.js";
import {
  isDismissible,
  portraitColors,
  portraitKey,
  portraitState,
  pruneDismissed,
} from "./portrait.js";
import "./popover.css";

const INITIAL: FeedState = {
  connection: "connecting",
  lanes: [],
  queued: [],
  log: [],
  signals: [],
  signalFrames: [],
  calm: 0.6,
  audio: { endpointId: null, ownerId: null },
};

export function Popover() {
  const [state, setState] = useState(INITIAL);
  const [audio, setAudio] = useState<ShellAudio>({
    enabled: false,
    volume: 1,
    status: "Audio is off",
  });
  const [requestedVolume, setRequestedVolume] = useState<{ volume: number }>();
  const [login, setLogin] = useState<LoginState>({ available: false, enabled: false, status: "" });
  const [opening, setOpening] = useState(false);
  const [focusMessage, setFocusMessage] = useState("");
  const [error, setError] = useState("");
  const [colors, setColors] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const root = useRef<HTMLElement>(null);
  const shell = window.hearableShell;
  useEffect(() => {
    const feed = connectFeed({
      url: defaultFeedUrl(),
      onState: (next) => {
        setColors((previous) =>
          portraitColors(
            [...next.lanes.flatMap((lane) => lane.sessions), ...next.queued],
            previous,
          ),
        );
        setDismissed((previous) =>
          pruneDismissed(
            previous,
            next.lanes
              .flatMap((lane) => lane.sessions)
              .map((session) => ({
                key: portraitKey(session),
                expression: portraitState(
                  next.signals.find(
                    (signal) =>
                      signal.sessionId === session.sessionId && signal.agent === session.agent,
                  ),
                  next.connection === "live",
                  false,
                ).expression,
              })),
          ),
        );
        setState(next);
      },
    });
    return () => feed.close();
  }, []);
  useEffect(() => {
    if (!shell) return;
    void shell
      .audioState()
      .then(setAudio)
      .catch(() => setError("Audio controls are unavailable. Reopen Hearable."));
    void shell
      .loginState()
      .then(setLogin)
      .catch(() => setError("The login setting is unavailable. Reopen Hearable."));
    return shell.onAudioState(setAudio);
  }, []);
  useEffect(() => {
    if (!shell || !root.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        void shell.resize(Math.ceil(entry.target.getBoundingClientRect().height)).catch(() => {});
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  async function calm(value: number) {
    setError("");
    try {
      const response = await fetch("/calm", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ calm: value }),
      });
      if (!response.ok) throw new Error();
    } catch {
      setError("Calm could not be saved. Try again.");
    }
  }
  const control = (action: Promise<unknown>, onFailure?: () => void) => {
    void action.catch(() => {
      onFailure?.();
      setError("Hearable could not apply that change. Try again.");
    });
  };
  // Playback reports can arrive after a newer input. The popover owns the slider once edited.
  const volume = requestedVolume?.volume ?? audio.volume;
  const sessions = [
    ...state.lanes.flatMap((lane) =>
      lane.sessions.map((session) => ({
        session,
        queued: false,
        signal: state.signals.find(
          (signal) => signal.sessionId === session.sessionId && signal.agent === session.agent,
        ),
      })),
    ),
    ...state.queued.map((session) => ({ session, queued: true, signal: undefined })),
  ];
  const visible = sessions.filter(({ session }) => !dismissed.has(portraitKey(session)));
  return (
    <main className="popover" ref={root}>
      <header>
        <h1>Hearable</h1>
        <span className="popover-connection">
          {state.connection === "live"
            ? "Connected"
            : state.connection === "connecting"
              ? "Connecting"
              : "Reconnecting"}
        </span>
      </header>
      <section className="popover-lanes" aria-label="Agent sessions">
        {visible.length === 0 ? (
          <p className="popover-empty">
            {sessions.length > 0
              ? "Idle agents are hidden"
              : state.connection === "live"
                ? "No agents connected"
                : "Waiting for a connection"}
          </p>
        ) : (
          <div
            className="popover-portraits"
            style={{
              gridTemplateColumns: `repeat(${Math.min(visible.length, 3)}, minmax(0, 1fr))`,
            }}
          >
            {visible.map(({ session, signal, queued }) => (
              <AgentPortrait
                key={portraitKey(session)}
                session={session}
                signal={signal}
                connected={state.connection === "live"}
                queued={queued}
                color={colors.get(portraitKey(session)) ?? 0}
                opening={opening}
                onOpen={
                  shell?.openAgent && state.connection === "live"
                    ? async () => {
                        if (opening) return;
                        setOpening(true);
                        setFocusMessage("");
                        try {
                          const result = await shell.openAgent?.(session.agent, session.sessionId);
                          setFocusMessage(result?.message ?? "");
                        } catch {
                          setFocusMessage(
                            "Hearable could not open this agent's window. Try again.",
                          );
                        } finally {
                          setOpening(false);
                        }
                      }
                    : undefined
                }
                onDismiss={
                  isDismissible(
                    portraitState(signal, state.connection === "live", queued).expression,
                  )
                    ? () => setDismissed((previous) => new Set(previous).add(portraitKey(session)))
                    : undefined
                }
              />
            ))}
          </div>
        )}
        {state.queued.length > 0 && (
          <p className="popover-empty">
            {state.queued.length} waiting for an audio lane. Tracked but not heard until a lane is
            free.
          </p>
        )}
      </section>
      <section className="popover-controls" aria-label="Controls">
        <label>
          <span>
            Calm <output>{Math.round(state.calm * 100)}%</output>
          </span>
          <input
            aria-label="Calm"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={state.calm}
            onChange={(event) => {
              const value = Number(event.target.value);
              setState((current) => ({ ...current, calm: value }));
              void calm(value);
            }}
          />
        </label>
        {shell && (
          <>
            <button
              type="button"
              className="popover-audio"
              onClick={() =>
                control(shell.commandAudio({ type: "enabled", enabled: !audio.enabled }))
              }
            >
              <span>Audio</span>
              <strong>{audio.enabled ? "On" : "Off"}</strong>
            </button>
            <p className="popover-audio-status" role="status">
              {audio.status}
            </p>
            <label>
              <span>
                Volume <output>{Math.round(volume * 100)}%</output>
              </span>
              <input
                aria-label="Volume"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(event) => {
                  const request = { volume: event.currentTarget.valueAsNumber };
                  setRequestedVolume(request);
                  control(shell.commandAudio({ type: "volume", ...request }), () => {
                    setRequestedVolume((current) => (current === request ? undefined : current));
                  });
                }}
              />
            </label>
          </>
        )}
      </section>
      {shell && (
        <section className="popover-login">
          <label>
            <span>Open at login</span>
            <input
              type="checkbox"
              aria-label="Open at login"
              checked={login.enabled}
              disabled={!login.available}
              onChange={(event) =>
                control(shell.setOpenAtLogin(event.target.checked).then(setLogin))
              }
            />
          </label>
          {login.status && <p>{login.status}</p>}
        </section>
      )}
      {focusMessage && (
        <p className="popover-error" role="status">
          {focusMessage}
        </p>
      )}
      {error && (
        <p className="popover-error" role="alert">
          {error}
        </p>
      )}
      {shell && (
        <footer>
          <button type="button" onClick={() => control(shell.quit())}>
            Quit Hearable
          </button>
        </footer>
      )}
    </main>
  );
}
