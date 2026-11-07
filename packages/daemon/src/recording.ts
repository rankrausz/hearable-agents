// packages/daemon/src/recording.ts — the recording file envelope shared by
// the recorder (writer) and the replayer (reader). What this is for: keeping
// header writing and version checks in one place (docs/EVENTS.md §Wire
// format, task p1-t06 notes) so the recorder, the replayer and the later
// Phase 2 golden tests all agree on what a recording file is. What it must
// not do: redact events (recorder.ts), rescale time or namespace sessions
// (replayer.ts), or guess at files it cannot read — an unsupported version is
// a loud plain-language error, never a silent reinterpretation.

import { SCHEMA_VERSION } from "@hearable/core";
import { z } from "zod";

/** The recording file version; it tracks the normalized event schema version. */
export const RECORDING_SCHEMA_VERSION = SCHEMA_VERSION;

/** Recording schema versions this hearable version knows how to read. */
export const SUPPORTED_RECORDING_VERSIONS: readonly number[] = [RECORDING_SCHEMA_VERSION];

/**
 * The first line of every recording file, per docs/EVENTS.md §Wire format:
 * schema version, agent identity, when it was recorded, and a pointer to the
 * human-written annotations file (owned by p1-t08 promotion).
 */
export const RecordingHeaderSchema = z.strictObject({
  hearable: z.literal("session"),
  v: z.number(),
  recordedAt: z.number(),
  agent: z.string(),
  annotations: z.string(),
});
export type RecordingHeader = z.infer<typeof RecordingHeaderSchema>;

/** A recording file problem, phrased for the person who ran the command. */
export class RecordingReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingReadError";
  }
}

/** Renders the header line the recorder writes first. */
export function formatRecordingHeader(args: {
  agent: string;
  recordedAt: number;
  annotations: string;
}): string {
  const header: RecordingHeader = {
    hearable: "session",
    v: RECORDING_SCHEMA_VERSION,
    recordedAt: args.recordedAt,
    agent: args.agent,
    annotations: args.annotations,
  };
  return JSON.stringify(header);
}

/**
 * Parses and version-checks the first line of a recording file. Throws a
 * RecordingReadError with a plain-language message when the line is not a
 * header at all or carries a schema version this hearable cannot read.
 */
export function parseRecordingHeader(
  firstLine: string | undefined,
  fileLabel: string,
): RecordingHeader {
  if (firstLine === undefined || firstLine.trim() === "") {
    throw new RecordingReadError(
      `Cannot replay ${fileLabel}: the file is empty, so there is no recording header to read. ` +
        `Record a session first, then replay the file that was written.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine) as unknown;
  } catch {
    throw new RecordingReadError(
      `Cannot replay ${fileLabel}: the first line is not a recording header. ` +
        `Use a file written by hearable record, not an arbitrary JSONL file.`,
    );
  }
  const header = RecordingHeaderSchema.safeParse(parsed);
  if (!header.success) {
    throw new RecordingReadError(
      `Cannot replay ${fileLabel}: the first line is not a recording header. ` +
        `Use a file written by hearable record, not an arbitrary JSONL file.`,
    );
  }
  if (!SUPPORTED_RECORDING_VERSIONS.includes(header.data.v)) {
    throw new RecordingReadError(
      `Cannot replay ${fileLabel}: it was recorded with schema version ${header.data.v}, ` +
        `which this hearable version cannot read (it reads version ${RECORDING_SCHEMA_VERSION}). ` +
        `Re-record the session with this hearable version and try again.`,
    );
  }
  return header.data;
}
