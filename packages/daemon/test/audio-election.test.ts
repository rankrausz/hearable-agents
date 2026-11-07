// Proves the daemon election keeps one owner, supports explicit takeover, and
// releases a silent owner within its heartbeat lease.

import { describe, expect, it } from "vitest";
import {
  AUDIO_HANDOFF_MS,
  AUDIO_HEARTBEAT_INTERVAL_MS,
  AUDIO_LEASE_TIMEOUT_MS,
  AudioElection,
  type AudioElectionMessage,
} from "../src/audio-election.js";
import type { Scheduler } from "../src/broadcast.js";

type FakeSocket = { id: string };

function setup() {
  let now = 0;
  const timers: (() => void)[] = [];
  const scheduler: Scheduler = {
    schedule(fn) {
      timers.push(fn);
      return () => {};
    },
  };
  const messages: { socket: FakeSocket; message: AudioElectionMessage }[] = [];
  const election = new AudioElection(
    () => now,
    scheduler,
    (socket, message) => messages.push({ socket: socket as unknown as FakeSocket, message }),
  );
  return {
    election,
    messages,
    socket(id: string) {
      return { id } as unknown as import("ws").WebSocket;
    },
    advance(ms: number) {
      now += ms;
      timers.shift()?.();
    },
  };
}

describe("audio endpoint election", () => {
  it("keeps the second claimant silent until it explicitly takes over", () => {
    const test = setup();
    const first = test.election.connect(test.socket("first"));
    const second = test.election.connect(test.socket("second"));

    test.election.claim(first, false);
    test.election.claim(second, false);
    expect(test.messages.at(-1)?.message.ownerId).toBe(first);
    test.election.claim(second, true);
    test.advance(AUDIO_HANDOFF_MS);
    test.advance(AUDIO_HANDOFF_MS);
    expect(test.messages.at(-1)?.message.ownerId).toBe(second);
  });

  it("releases an owner that misses the heartbeat lease", () => {
    const test = setup();
    const first = test.election.connect(test.socket("first"));
    const second = test.election.connect(test.socket("second"));
    test.election.claim(first, false);

    test.advance(AUDIO_LEASE_TIMEOUT_MS + 1);
    expect(test.messages.filter(({ message }) => message.ownerId === null)).not.toHaveLength(0);
    test.election.claim(second, false);
    expect(test.messages.at(-1)?.message.ownerId).toBe(second);
  });

  it("tolerates a late heartbeat inside the lease", () => {
    const test = setup();
    const first = test.election.connect(test.socket("first"));
    test.election.claim(first, false);

    // A beat later than the interval but inside the lease: building the audio
    // graph or a throttled tab delays beats, and that must not silence audio.
    test.advance(AUDIO_HEARTBEAT_INTERVAL_MS * 2);
    test.election.heartbeat(first);
    test.advance(AUDIO_HEARTBEAT_INTERVAL_MS * 2);
    expect(test.messages.at(-1)?.message.ownerId).toBe(first);
  });

  it("gives a lapsed owner its lease back on the next heartbeat", () => {
    const test = setup();
    const first = test.election.connect(test.socket("first"));
    test.election.claim(first, false);

    test.advance(AUDIO_LEASE_TIMEOUT_MS + 1);
    expect(test.messages.at(-1)?.message.ownerId).toBeNull();
    // The page never stopped playing; the beat that proves it is alive is
    // also its re-claim, so the listener does not have to touch the button.
    test.election.heartbeat(first);
    expect(test.messages.at(-1)?.message.ownerId).toBe(first);
  });

  it("does not give a released endpoint its lease back on a heartbeat", () => {
    const test = setup();
    const first = test.election.connect(test.socket("first"));
    test.election.claim(first, false);

    test.election.release(first);
    expect(test.messages.at(-1)?.message.ownerId).toBeNull();
    test.election.heartbeat(first);
    expect(test.messages.at(-1)?.message.ownerId).toBeNull();
  });

  it("does not let a lapsed owner steal the lease back from a new claimant", () => {
    const test = setup();
    const first = test.election.connect(test.socket("first"));
    const second = test.election.connect(test.socket("second"));
    test.election.claim(first, false);
    test.advance(AUDIO_LEASE_TIMEOUT_MS + 1);
    expect(test.messages.at(-1)?.message.ownerId).toBeNull();

    // No handoff wait: the lease was already free, so the new claimant is
    // audible at once and the old owner's next beat must not take it back.
    test.election.claim(second, false);
    expect(test.messages.at(-1)?.message.ownerId).toBe(second);
    test.election.heartbeat(first);
    expect(test.messages.at(-1)?.message.ownerId).toBe(second);
  });

  it("releases the owner immediately when its socket closes", () => {
    const test = setup();
    const firstSocket = test.socket("first");
    const first = test.election.connect(firstSocket);
    const second = test.election.connect(test.socket("second"));
    test.election.claim(first, false);

    test.election.disconnect(first);
    test.election.claim(second, false);
    expect(test.messages.at(-1)?.message.ownerId).toBe(second);
  });
});
