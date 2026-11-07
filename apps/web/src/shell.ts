// Optional hosting seam; must not import Electron or change browser permission policy.
import { useEffect, useRef, useState } from "react";
import { setShellVolume } from "./popover/volume.js";
export type ShellAudio = { enabled: boolean; volume: number; status: string };
export type AudioCommand =
  | { type: "enabled"; enabled: boolean }
  | { type: "volume"; volume: number };
export type LoginState = { available: boolean; enabled: boolean; status: string };
export type ShellBridge = {
  loginState(): Promise<LoginState>;
  setOpenAtLogin(enabled: boolean): Promise<LoginState>;
  preferences(): Promise<{ audioEnabled: boolean }>;
  rememberAudio(enabled: boolean): Promise<void>;
  openAgent?(
    agent: string,
    sessionId: string,
  ): Promise<{ status: "focused" | "app-only" | "unavailable"; message: string }>;
  quit(): Promise<void>;
  audioState(): Promise<ShellAudio>;
  reportAudio(audio: ShellAudio): Promise<void>;
  commandAudio(command: AudioCommand): Promise<void>;
  onAudioCommand(callback: (command: AudioCommand) => void): () => void;
  onAudioState(callback: (audio: ShellAudio) => void): () => void;
  resize(height: number): Promise<void>;
};
declare global {
  interface Window {
    hearableShell?: ShellBridge;
  }
}

export function useShellPlayback(
  connected: boolean,
  start: (takeover?: boolean) => Promise<void>,
  phase: string,
  stop: () => void,
  status: string,
): void {
  const attempted = useRef(false);
  const latest = useRef({ start, stop, phase });
  const [volume, setVolume] = useState(1);
  latest.current = { start, stop, phase };
  useEffect(() => {
    if (!connected || attempted.current || !window.hearableShell) return;
    attempted.current = true;
    void window.hearableShell
      .preferences()
      .then((choice) => {
        if (choice.audioEnabled && latest.current.phase === "off") void latest.current.start();
      })
      .catch(() => {});
  }, [connected]);
  useEffect(
    () =>
      window.hearableShell?.onAudioCommand((command) => {
        if (command.type === "volume") {
          setShellVolume(command.volume);
          setVolume(command.volume);
        } else if (command.enabled) void latest.current.start(true);
        else latest.current.stop();
      }),
    [],
  );
  useEffect(() => {
    void window.hearableShell
      ?.reportAudio({ enabled: phase !== "off", volume, status })
      .catch(() => {});
  }, [phase, volume, status]);
}
