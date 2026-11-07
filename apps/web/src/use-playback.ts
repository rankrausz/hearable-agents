// Owns one browser playback lifetime. Late starts must never escape Stop or unmount.
import { useEffect, useRef, useState } from "react";

type Disposable = { dispose(): void };
export function usePlayback<T extends Disposable>(
  create: () => Promise<T>,
  apply: (handle: T) => void,
  waitForSilence: () => Promise<void> = () => Promise.resolve(),
) {
  const handle = useRef<T | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const cooldown = useRef(Promise.resolve());
  const latestApply = useRef(apply);
  latestApply.current = apply;
  const [phase, setPhase] = useState<"off" | "starting" | "on">("off");
  const [error, setError] = useState("");

  useEffect(() => {
    if (handle.current !== null) apply(handle.current);
  }, [apply]);
  useEffect(
    () => () => {
      generation.current += 1;
      handle.current?.dispose();
      handle.current = null;
    },
    [],
  );

  function stop(): void {
    generation.current += 1;
    pending.current = false;
    if (handle.current !== null) {
      handle.current.dispose();
      // A rapid restart waits for the outgoing graph's fade and lookahead.
      cooldown.current = new Promise((resolve) => window.setTimeout(resolve, 1_300));
    }
    handle.current = null;
    setPhase("off");
    setError("");
  }
  async function start(): Promise<boolean> {
    if (pending.current || handle.current !== null) return false;
    const id = ++generation.current;
    pending.current = true;
    setPhase("starting");
    setError("");
    let created: T | null = null;
    try {
      await Promise.all([cooldown.current, waitForSilence()]);
      if (id !== generation.current) return false;
      created = await create();
      if (id !== generation.current) {
        created.dispose();
        return false;
      }
      latestApply.current(created);
      handle.current = created;
      setPhase("on");
      return true;
    } catch {
      created?.dispose();
      if (id !== generation.current) return false;
      setPhase("off");
      setError("Audio could not start. Check the browser audio permission and try again.");
      return false;
    } finally {
      if (id === generation.current) pending.current = false;
    }
  }
  return { phase, error, stop, start };
}
