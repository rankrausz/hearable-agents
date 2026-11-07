// Reads the shipped piano PCM for unit renders; never substitutes generated sound or modifies recordings.
import { readFileSync } from "node:fs";
import type { PianoPcm } from "../src/gestures/render.js";
export const pianoSamples: readonly PianoPcm[] = [
  [48, "C3"],
  [54, "Fs3"],
  [60, "C4"],
  [66, "Fs4"],
  [72, "C5"],
  [78, "Fs5"],
  [84, "C6"],
].map(([midi, name]) => {
  const bytes = readFileSync(
    new URL(`../src/scenes/clearing/assets/piano/${name}.wav`, import.meta.url),
  );
  let data = 0,
    length = 0,
    rate = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const kind = bytes.toString("ascii", at, at + 4),
      size = bytes.readUInt32LE(at + 4);
    if (kind === "fmt ") {
      if (
        bytes.readUInt16LE(at + 8) !== 1 ||
        bytes.readUInt16LE(at + 10) !== 1 ||
        bytes.readUInt16LE(at + 22) !== 16
      )
        throw new Error("Expected mono 16-bit PCM");
      rate = bytes.readUInt32LE(at + 12);
    }
    if (kind === "data") {
      data = at + 8;
      length = size;
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!data || !rate) throw new Error("Invalid piano WAV");
  return {
    midi: Number(midi),
    sampleRate: rate,
    samples: Float32Array.from(
      { length: length / 2 },
      (_, i) => bytes.readInt16LE(data + 2 * i) / 32768,
    ),
  };
});
