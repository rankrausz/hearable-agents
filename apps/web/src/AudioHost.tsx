// Owns the hidden Mac audio endpoint; must not expose developer views or infer agent state.
import { useEffect, useRef, useState } from "react";
import * as tone from "tone";
import { createLiveAudio } from "./audio.js";
import { connectFeed, defaultFeedUrl, type FeedState } from "./feed.js";
import { playbackWanted, readPlaybackMode } from "./playback-policy.js";
import { useShellPlayback } from "./shell.js";
import { usePlayback } from "./use-playback.js";

const INITIAL_STATE: FeedState = {
  connection: "connecting",
  lanes: [],
  queued: [],
  log: [],
  signals: [],
  signalFrames: [],
  calm: 0.6,
  audio: { endpointId: null, ownerId: null },
};

export function AudioHost(): React.ReactElement {
  const [state, setState] = useState<FeedState>(INITIAL_STATE);
  const [playbackMode] = useState(readPlaybackMode);
  const feedControls = useRef<ReturnType<typeof connectFeed> | null>(null);
  const wanted = playbackWanted(
    state.signals,
    playbackMode,
    state.connection === "live",
    state.signalFrames.at(-1)?.serverTime ?? 0,
  );
  const ownsAudio =
    state.audio.endpointId !== null && state.audio.endpointId === state.audio.ownerId;
  const playback = usePlayback(
    () => createLiveAudio(),
    (audio) => {
      const serverTime = state.signalFrames.at(-1)?.serverTime ?? 0;
      audio.apply(state.signals, state.calm, serverTime, {});
      audio.announceQueued(
        state.queued.map((session) => session.sessionId),
        serverTime,
      );
      audio.setAudible(wanted && ownsAudio);
    },
  );
  const audioState =
    playback.error ||
    (playback.phase === "off"
      ? "Audio is off"
      : playback.phase === "starting"
        ? "Starting audio"
        : state.connection !== "live"
          ? "Audio ready · waiting for connection"
          : state.audio.ownerId !== null && !ownsAudio
            ? "Audio is playing in another tab"
            : wanted
              ? "Audio is running"
              : "Audio ready · no active agents");
  useEffect(() => {
    const feed = connectFeed({
      url: defaultFeedUrl(),
      onState: setState,
    });
    feedControls.current = feed;
    const heartbeat = window.setInterval(() => feed.heartbeatAudio(), 500);
    return () => {
      window.clearInterval(heartbeat);
      feed.releaseAudio();
      feed.close();
      feedControls.current = null;
    };
  }, []);

  async function startAudio(takeover = false): Promise<void> {
    void tone.start().catch(() => {});
    feedControls.current?.claimAudio(takeover);
    if (await playback.start()) {
      void window.hearableShell?.rememberAudio(true).catch(() => {});
    }
  }

  useShellPlayback(
    state.connection === "live",
    startAudio,
    playback.phase,
    () => {
      playback.stop();
      feedControls.current?.releaseAudio();
      void window.hearableShell?.rememberAudio(false).catch(() => {});
    },
    audioState,
  );

  return (
    <main>
      <h1>Hearable</h1>
      <p role="status">{audioState}</p>
      <p>{state.connection}</p>
    </main>
  );
}
