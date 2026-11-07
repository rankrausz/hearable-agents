// scripts/owner-listen-copies.mjs — `pnpm owner:listen` (p5-t05): matched-level
// owner listening copies of the two ensemble A/B renders. What this is for:
// preparing the p5-t06 working listen — the two named QA renders
// (`artifacts/audio-qa/ensemble-ab-hybrid.wav` and
// `ensemble-ab-independent.wav`, seed 161, calm 0.6, full 150 s mix) gain
// matched to the SAME peak so the owner compares scheduling, never loudness.
// What it must not do: touch production levels, thresholds, fixtures, or the
// QA WAVs themselves — the copies are separate files, the gain is a single
// uniform scalar per file (no compression, no EQ, no trimming), and the
// offset in dB is printed so the listen note can record it.

import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "..");
const QA_DIR = join(REPO_ROOT, "artifacts", "audio-qa");
const OUT_DIR = join(REPO_ROOT, "artifacts", "owner-listen");

const COPIES = [
  { src: "ensemble-ab-hybrid.wav", dst: "ensemble-ab-hybrid-matched.wav" },
  { src: "ensemble-ab-independent.wav", dst: "ensemble-ab-independent-matched.wav" },
];

async function peakDb(path) {
  // volumedetect reports on stderr, not stdout.
  const child = await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-i",
    path,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]).catch((error) => error);
  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  const match = output.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  if (match === null) {
    throw new Error(`could not read peak volume of ${path} (ffmpeg volumedetect output missing)`);
  }
  return Number(match[1]);
}

const [hybrid, independent] = await Promise.all(
  COPIES.map((copy) => stat(join(QA_DIR, copy.src)).then(() => copy)),
).catch((error) => {
  console.error(
    `owner listening copies need the QA renders first: run pnpm audio:qa, then retry. (${error.message})`,
  );
  process.exit(1);
});
void hybrid;
void independent;

const peaks = [];
for (const copy of COPIES) {
  peaks.push({ ...copy, peak: await peakDb(join(QA_DIR, copy.src)) });
}
const target = Math.max(...peaks.map((entry) => entry.peak));
await mkdir(OUT_DIR, { recursive: true });
for (const entry of peaks) {
  const gainDb = target - entry.peak;
  await execFileAsync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    join(QA_DIR, entry.src),
    "-af",
    `volume=${gainDb.toFixed(2)}dB`,
    "-c:a",
    "pcm_f32le",
    join(OUT_DIR, entry.dst),
  ]);
  console.log(
    `owner-listen ${entry.dst}: source peak ${entry.peak.toFixed(1)} dBFS, gain ${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(2)} dB to matched peak ${target.toFixed(1)} dBFS (uniform scalar only — production levels untouched)`,
  );
}
console.log(
  `owner-listen: matched-level copies in ${OUT_DIR}/ — listen to these for p5-t06, never the raw QA WAVs for comparison.`,
);
