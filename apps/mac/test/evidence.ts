// Summarizes observed endpoint traffic; must never fill gaps or turn a short run into an hour.
export type EvidenceEvent = {
  at: number;
  kind: "heartbeat" | "election" | "suspend" | "resume" | "visibility" | "claim" | "release";
  endpointId?: string;
  ownerId?: string | null;
  visible?: boolean;
};
export function summarizeEvidence(
  events: readonly EvidenceEvent[],
  startAt: number,
  endAt: number,
) {
  const measured = events.filter((event) => event.at >= startAt && event.at <= endAt);
  const beats = measured.filter((event) => event.kind === "heartbeat");
  const election = measured.filter((event) => event.kind === "election");
  let previousOwner: string | null =
    events.filter((event) => event.at < startAt && event.kind === "election").at(-1)?.ownerId ??
    null;
  const initialOwner = previousOwner;
  let lastHeldOwner = initialOwner;
  let lapsedOwner: string | null = null;
  let lapses = 0;
  let takebacks = 0;
  let ownerChanges = 0;
  for (const event of election) {
    const owner = event.ownerId ?? null;
    if (owner === null && previousOwner !== null) {
      lapses += 1;
      lapsedOwner = previousOwner;
    }
    if (owner !== null && previousOwner === null && lapsedOwner === owner) takebacks += 1;
    if (owner !== null) {
      if (lastHeldOwner !== null && owner !== lastHeldOwner) ownerChanges += 1;
      lastHeldOwner = owner;
    }
    previousOwner = owner;
  }
  let longestGapMs =
    beats.length > 0
      ? Math.max((beats[0]?.at ?? startAt) - startAt, endAt - (beats.at(-1)?.at ?? endAt))
      : endAt - startAt;
  for (let i = 1; i < beats.length; i++)
    longestGapMs = Math.max(longestGapMs, (beats[i]?.at ?? 0) - (beats[i - 1]?.at ?? 0));
  const suspendAt = measured.find((event) => event.kind === "suspend")?.at;
  const sleepWake =
    suspendAt !== undefined &&
    measured.some((event) => event.kind === "resume" && event.at > suspendAt);
  const visibleSamples = measured.filter((event) => event.kind === "visibility");
  const allWindowsHidden =
    visibleSamples.length > 0 && visibleSamples.every((event) => event.visible === false);
  const durationMs = endAt - startAt;
  return {
    initialOwner,
    finalOwner: previousOwner,
    durationMs,
    heartbeats: beats.length,
    claims: measured.filter((event) => event.kind === "claim").length,
    releases: measured.filter((event) => event.kind === "release").length,
    longestGapMs,
    lapses,
    takebacks,
    ownerChanges,
    sleepWake,
    allWindowsHidden,
    visibilitySamples: visibleSamples.length,
    qualifies:
      durationMs >= 3_600_000 &&
      sleepWake &&
      allWindowsHidden &&
      initialOwner !== null &&
      previousOwner === initialOwner &&
      beats.length > 0 &&
      lapses === 0 &&
      ownerChanges === 0,
  };
}
