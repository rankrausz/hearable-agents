// e2e/audio-qa.spec.ts — the automated audio QA: every SOUND_DESIGN.md
// §Automated QA scenario renders headless in Chromium via Tone.Offline with
// the fixed seed, analyses in the page, and asserts numeric bounds. One test
// per scenario, so a failure names itself and the matrix spreads across
// workers. Runs under e2e/audio-qa.config.ts (`pnpm audio:qa`), which needs
// no web preview server. What this is for: proving every night that the
// Clearing stays within the fatigue rules, with WAV artifacts. What it must
// not do: judge sound (agents cannot), change mapping/voices/gestures/drift
// constants to hit thresholds (fixes go back to the owning task — BLOCKED
// with numbers), or touch the relay timing suite.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, "..");
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "audio-qa");

const QA_NAMES = [
  "routine-3-lanes-calm06",
  "near-silence-calm09",
  "single-lane-modes",
  "struggle-ramp",
  "waiting-holds",
  "resolve-fades",
  "calm-sweep",
  "foreground-switch",
  "macro-evolution",
  "spatial-drift",
  "ensemble-ab-independent",
  "ensemble-ab-hybrid",
  "harmonic-field",
  "empty-room",
  "tonal-journey",
] as const;
type QaScenarioName = (typeof QA_NAMES)[number];

// Replay matrix fixtures and setups (p4-t06): the QA bundle carries no
// fixture bytes — the spec reads the JSONL files in Node (read-only,
// fixtures are never written) and passes the kind-bearing parsed lines
// into the page. No fixture is edited; the ACP third has no adapter and
// no fixtures, so the mix sounds the two real families and the gap is
// recorded, never faked.
const FIXTURE_SPECS = [
  { file: "fixtures/sessions/claude-code/stuck-single-session.jsonl", agent: "claude-code" },
  { file: "fixtures/sessions/codex/stuck-single-session.jsonl", agent: "codex" },
  { file: "fixtures/sessions/claude-code/permission-heavy.jsonl", agent: "claude-code" },
] as const;

// Replay entries: setup → which lanes it sounds. The three-lane mix
// replays the claude-code stuck lane (0), the codex stuck lane (1) and
// the claude-code permission-heavy lane (2, waiting with its question
// gesture and tension hold) concurrently from one common anchor — the
// same concurrent shape the attention golden
// (concurrent-claude-code-codex) pins at the model level.
const REPLAY_SETUPS = [
  { setup: "claude-stuck", lanes: [0], window: { startS: 60, endS: 150 }, fixture: 0 },
  { setup: "codex-stuck", lanes: [1], window: { startS: 45, endS: 135 }, fixture: 1 },
  { setup: "three-lane-mix", lanes: [0, 1, 2], window: { startS: 0, endS: 90 }, fixture: -1 },
] as const;

const REPLAY_CALM_LEVELS = [0.3, 0.6, 0.9] as const;

type QaMetrics = {
  sampleRate: number;
  length: number;
  rmsDb: number;
  peakDb: number;
  bandShare2k5k: number;
  bandShare6kUp: number;
  maxAutocorr5s: number;
  maxJump: number;
  dc: number;
  rmsSettledDb: number;
  rmsLast10Db: number;
  regularityEarly: number;
  regularityLate: number;
  tensionBandRmsDb: number;
  bedRmsDb: number;
  textureRmsDb: number;
  resolveSoloDb: number;
  resolveSoloEarlyDb: number;
  laneSoloDb: number[];
  laneSoloLoudDb: number[];
  modeCentroidsHz: [number, number, number];
  foregroundSolos: number[][];
  foregroundLoudSolos: number[][];
  foregroundOrder: [number, number, number];
  // Onset locator (p3-t11): first flux rise-edge in 9.5–13 s at the
  // calibrated threshold. -1 means no edge crossed — the locator hears
  // no attack in the window, which is itself the finding (the question
  // D-note onset is buried under the mix's wandering texture).
  questionOnsetAtS: number;
  // Legacy peak locator, reported alongside so the tail-vs-onset gap is
  // visible in every log. The 10–12 s gate on this number is retired:
  // it peaks the sustain/tension swell (~12.88 s), not the gesture.
  questionPeakAtS: number;
  // Calm presence split (p3-t11, ADR 0018): per-third broadband,
  // bed-band and texture levels of the calm-sweep, plus the
  // gesture-vs-routine split from waiting-holds (tension band vs the
  // pre-gesture texture baseline). Reported, not gated: a single master
  // number cannot tell a master-ride from presence/density scaling.
  calmThirds: { rms: number; bed: number; texture: number }[];
  gestureVsRoutineDb: number;
  // Non-gating musical diagnostics (p3-t11, ADR 0020): listening
  // support, never gates. Flux windows, chroma entropy, contour
  // recurrence, density variation, long-term spectral drift.
  fluxShort: number;
  fluxMedium: number;
  fluxLong: number;
  chromaEntropy: number;
  contourRecurrence: number;
  densityVariation: number;
  driftCentroidFirstHz: number;
  driftCentroidSecondHz: number;
  driftCosineDistance: number;
  // Macro-world solo per-epoch voice (revp3t12): chroma and centroid of
  // the world's own render before vs after the first seeded boundary,
  // plus its whole-render level.
  macroSoloChromaFirst: number;
  macroSoloChromaSecond: number;
  macroSoloCentroidFirst: number;
  macroSoloCentroidSecond: number;
  macroSoloRms: number;
  // Nature-bed solo (p3-t15): the sampled bed alone at its mix seat.
  // REPORTED, never gated.
  natureSoloRms: number;
  // Harmonic field (ADR 0025): world-solo chroma entropy per third and
  // the solo's peak, for the harmonic-field scenario.
  fieldSoloChromaThirds: number[];
  fieldSoloPeakDb: number;
  // Empty room and tonal journey (owner direction 2026-10-29): the mix
  // while the agent works against the settled empty room, and the
  // strongest low pitch class before and after the centre moves.
  emptyActiveDb: number;
  emptySettledDb: number;
  tonalFirstPc: number;
  tonalLastPc: number;
  // Spatial-drift entry (p3-t16, ADR 0017): lane identity under the
  // seeded wander — REPORTED, never gated.
  spatialStereoRms: number;
  spatialMonoRms: number;
  spatialLaneSoloDb: number;
  spatialLaneSoloMonoDb: number;
  wavBase64: string;
};

const QA_PAGE = `
import { renderQaScenario } from "/qa-bundle.mjs";
import {
  autocorrelationAtLag, bandEnergyShare, bandRmsDb, chromaEntropy,
  contourRecurrence, dcOffset, densityVariation, dominantPitchClass, downsampleMean, firstFluxOnset,
  fluxSeries, loudnessDb, maxSampleJump, peakDb, rmsDb,
  spectralCentroid, spectralDrift, toMono, windowRegularity, windowRmsDb,
} from "/qa-metrics.mjs";
import { ENSEMBLE_SCHEDULES } from "/qa-ensemble-schedules.mjs";

function maxAutocorr(samples, sampleRate, minLagS, maxLagS, stepS) {
  const slow = downsampleMean(samples, sampleRate, 100);
  const slowRate = 100;
  const minLag = Math.round(minLagS * slowRate);
  const maxLag = Math.min(slow.length - 1, Math.round(maxLagS * slowRate));
  let max = 0;
  for (let lag = minLag; lag <= maxLag; lag += Math.max(1, Math.round(stepS * slowRate))) {
    max = Math.max(max, Math.abs(autocorrelationAtLag(slow, lag)));
  }
  return max;
}

function encodeWavFloat(left, right, sampleRate) {
  const n = Math.min(left.length, right.length);
  const buffer = new ArrayBuffer(44 + n * 8);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + n * 8, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 8, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  writeStr(36, "data");
  view.setUint32(40, n * 8, true);
  for (let i = 0; i < n; i++) {
    view.setFloat32(44 + i * 8, left[i] ?? 0, true);
    view.setFloat32(44 + i * 8 + 4, right[i] ?? 0, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

globalThis.__playbackMetrics = async () => {
  const { sampleRate, left, right } = await renderQaScenario("single-lane-modes", 161, "mix", 0, undefined, [
    { atS: 5, open: true }, { atS: 25, open: false },
    { atS: 35, open: true }, { atS: 50, open: false },
  ]);
  const mono = toMono(left, right);
  return {
    windows: [[0, 4], [10, 20], [27, 34], [40, 48], [52, 60]].map(([a,b]) => windowRmsDb(mono, sampleRate, a, b)),
    peak: Math.max(peakDb(left), peakDb(right)), jump: maxSampleJump(left, right),
    wavBase64: encodeWavFloat(left, right, sampleRate),
  };
};

globalThis.__qaMetrics = (name, seed) => (async () => {
  const schedule = ENSEMBLE_SCHEDULES[name];
  const { sampleRate, left, right } = await renderQaScenario(name, seed, "mix", 0, schedule);
  const mono = toMono(left, right);
  const durationS = mono.length / sampleRate;
  const rmsLast10Db = windowRmsDb(mono, sampleRate, Math.max(0, durationS - 10), durationS);
  // Struggle-loudness windows skip the startup ramp: the first apply starts
  // every layer gain from silence, so 0–10 s is still climbing. Compare the
  // settled 20–30 s window against the last 10 s instead.
  const rmsSettledDb = windowRmsDb(mono, sampleRate, 20, Math.min(30, durationS));
  // Struggle regularity: rendered-envelope repetition early (15–25 s,
  // struggle ~0.3) vs late (45–55 s, struggle ~0.8). windowRegularity
  // reads the RENDERED audio — the input SceneParams regularity is not
  // measured, because the plan/apply path does not wire regularity to a
  // dedicated node yet (builder comment: "p3-t03 voices it" — the honest
  // choice is the only signal that reaches the speakers). LIMITATION:
  // the current mix renders struggle mostly as level/timbre, so early
  // and late score within ±0.02 of each other (calibration: 0.463 vs
  // 0.478) — the gate below therefore asserts STABILITY (no collapse of
  // repetition), not a rise; the rise half stays open until the
  // regularity path is audible. A rise gate on this number today would
  // measure the harness, not the mix.
  // The repetition read is taken on the struggle lane's own timeline solo
  // (lane 0 following the scenario, bed/field/swell/nature/air parked):
  // since ADR 0025 the harmonic field's smooth sustained voices dominate a
  // single quiet lane's mix envelope and made the mix read periodic
  // (early 0.49) regardless of struggle. The gate is about the lane's
  // phrases repeating, so it hears the lane. Other scenarios keep the mix
  // read (reported only).
  let regularitySource = mono;
  let regularityRate = sampleRate;
  if (name === "struggle-ramp") {
    const solo = await renderQaScenario(name, seed, { laneTimeline: 0 });
    regularitySource = toMono(solo.left, solo.right);
    regularityRate = solo.sampleRate;
  }
  const regularityEarly = windowRegularity(regularitySource, regularityRate, 15, 25);
  const regularityLate = windowRegularity(regularitySource, regularityRate, 45, 55);
  const third = durationS / 3;
  const modeCentroidsHz = [0, 1, 2].map((k) =>
    spectralCentroid(mono, sampleRate, k * third, (k + 1) * third));
  // Tension energy: absolute 150–600 Hz band level from 13 s to end,
  // in dBFS — a floor, not a share. The waiting pad must keep this band
  // audibly alive; the bound says what "present" means in absolute terms.
  const tensionBandRmsDb = bandRmsDb(mono, sampleRate, 13, durationS, 150, 600);
  // bed/texture reporting (not gating): bed-band level plus the
  // broadband texture estimate, so a combined near-silence miss points
  // at the louder half. The spec row names Rule 5, not separate meters,
  // so only the combined RMS below gates.
  const bedRmsDb = bandRmsDb(mono, sampleRate, 10, durationS, 50, 500);
  const textureRmsDb = 10 * Math.log10(Math.max(1e-12,
    10 ** (rmsDb(mono) / 10) - 10 ** (bedRmsDb / 10)));
  // Lane-1 solo (resolve-fades only — other scenarios skip the 4 extra
  // renders): the lane sounding alone with the bed muted, measured LATE
  // (19–20 s) and EARLY (10–11 s, right after the trigger). The gate below
  // compares them (fade-drop): an absolute late number alone cannot tell
  // a faded lane from a lane that was quiet all along, so the late
  // number is reported as the indicator and the DROP gates the trajectory.
  let resolveSoloDb = Number.NEGATIVE_INFINITY;
  let resolveSoloEarlyDb = Number.NEGATIVE_INFINITY;
  if (name === "resolve-fades") {
    const lane1 = await renderQaScenario(name, seed, 1, 29);
    const lane1Mono = toMono(lane1.left, lane1.right);
    resolveSoloDb = windowRmsDb(lane1Mono, lane1.sampleRate, 19, 20);
    const lane1Early = await renderQaScenario(name, seed, 1, 10.5);
    const lane1EarlyMono = toMono(lane1Early.left, lane1Early.right);
    resolveSoloEarlyDb = windowRmsDb(lane1EarlyMono, lane1Early.sampleRate, 0, 1);
  }
  // Per-lane solos (foreground-switch and resolve-fades): each lane's own
  // level in the mix's first 10 s, bed muted — raw RMS AND A-weighted
  // loudness side by side, so a gap both meters agree on is a seating
  // defect, not a meter artifact (p3-t11 calibration: raw and loudness
  // agree on lane 0 ~14–15 dB below lane 1 — the solo comparison is
  // honest, the gap is real, and its owner is the voice path, p3-t13).
  const laneSolos = [];
  const laneSoloLouds = [];
  if (name === "foreground-switch" || name === "resolve-fades") {
    for (let lane = 0; lane < 3; lane++) {
      const r = await renderQaScenario(name, seed, lane);
      const m = toMono(r.left, r.right);
      laneSolos.push(windowRmsDb(m, r.sampleRate, 0, 10));
      laneSoloLouds.push(loudnessDb(m, r.sampleRate, 0, 10));
    }
  }
  // Foreground solo matrix: lane L soloed from the step active in window
  // W (soloT = window midpoint), level of that solo measured over the
  // solo render's second half (the single-apply snapshot climbs from
  // silence, so the first half is still ramping). Row W should peak on
  // the diagonal: window 0 → lane 0 (A foreground), window 1 → lane 1
  // (B), window 2 → lane 2 (C). This is the ORDER half of the foreground
  // gate; the plan-level reverbSend order (unit-tested in Node) is the
  // mapping half. Only the foreground-switch scenario pays the 9 extra
  // renders; other scenarios report an empty matrix.
  // LIMITATION (documented, not hidden): the solo snapshot re-renders the
  // lane from silence rather than continuing the mix, so the matrix
  // proves each lane CAN be loudest in its own window's state — not that
  // the continuous 60 s mix seats it there. The mix-seating half is the
  // pairwise window-RMS check below plus human listening (p3-t07).
  const foregroundSolos = [];
  const foregroundLoudSolos = [];
  if (name === "foreground-switch") {
    for (let w = 0; w < 3; w++) {
      const row = [];
      const loudRow = [];
      for (let lane = 0; lane < 3; lane++) {
        const r = await renderQaScenario(name, seed, lane, w * 20 + 10);
        const m = toMono(r.left, r.right);
        const half = m.length / r.sampleRate / 2;
        row.push(windowRmsDb(m, r.sampleRate, half, m.length / r.sampleRate));
        loudRow.push(loudnessDb(m, r.sampleRate, half, m.length / r.sampleRate));
      }
      foregroundSolos.push(row);
      foregroundLoudSolos.push(loudRow);
    }
  }
  // Question locator, onset-based (p3-t11): the first spectral-flux
  // rise-edge in 9.5–13 s. DEFINITION CHANGE, recorded explicitly: the
  // retired peak locator below takes the maximum centre RMS over 9–13 s
  // in 0.25 s steps — a maximum is a sustain/tension-swell peak (it
  // reads 12.88 s, the 12.6–13 s hump the tension swell plus lane-2 air
  // build together), never an onset. An onset is a RISE, so the locator
  // takes the FIRST flux edge above the calibrated threshold instead of
  // the maximum. Calibrated in Node against the gesture offline
  // renderer (renderGesturePlan): the isolated question plan crosses
  // 0.4 at its 0.5 s note attack and only there. In the mix the same
  // locator reads no edge at 0.4 (the D-note attack is buried under the
  // wandering texture — crest and flux probes show no rise at 10.0–10.6
  // above the texture's own swells), and the gate asserts the onset
  // window 10–12 s explicitly so that miss is an honest red owned by
  // the gesture/voice path (p3-t03/p3-t13), not a passing number.
  // Threshold 0.4, frame 2048/sr (~43 ms): the isolated-plan
  // calibration point. A lower threshold (0.3) fires on the texture's
  // own swells in the mix (12.27 s) — that would measure the texture,
  // not the gesture.
  const QUESTION_ONSET_THRESHOLD = 0.4;
  let questionOnsetAtS = -1;
  {
    const frameS = 2048 / sampleRate;
    const flux = fluxSeries(mono, sampleRate, 9.5, 13, frameS);
    questionOnsetAtS = firstFluxOnset(flux, 9.5, frameS, QUESTION_ONSET_THRESHOLD);
  }
  // Retired peak locator, reported alongside: the number the old gate
  // asserted (10–12 s). Kept so the tail-vs-onset gap stays visible in
  // every log; NOT gated.
  let questionPeakAtS = -1;
  let questionPeakV = -Infinity;
  for (let t = 9; t < Math.min(13, durationS); t += 0.25) {
    const i0 = Math.round(t * sampleRate);
    const i1 = Math.round((t + 0.25) * sampleRate);
    let sum = 0;
    for (let i = i0; i < i1; i++) {
      const centre = ((left[i] ?? 0) + (right[i] ?? 0)) / 2;
      sum += centre * centre;
    }
    const rms = 10 * Math.log10(Math.max(1e-12, sum / Math.max(1, i1 - i0)));
    if (rms > questionPeakV) {
      questionPeakV = rms;
      questionPeakAtS = t + 0.125;
    }
  }
  // Calm presence split (p3-t11, ADR 0018): the calm-sweep reports
  // per-third broadband, bed-band and texture levels, and waiting-holds
  // reports the gesture-vs-routine split (tension-band level vs the
  // pre-gesture 5–9.5 s texture baseline). Reported, not gated: one
  // master number cannot tell a master-gain ride from presence/density
  // scaling, so the harness characterizes the curve instead of passing
  // it. The full sweep half (does routine presence fall while hard
  // signals hold) belongs to scene mapping (p3-t14), not the harness.
  let calmThirds = [];
  if (name === "calm-sweep") {
    const third = durationS / 3;
    for (let k = 0; k < 3; k++) {
      const fromS = k * third;
      const toS = (k + 1) * third;
      const bed = bandRmsDb(mono, sampleRate, fromS, toS, 50, 500);
      const broad = windowRmsDb(mono, sampleRate, fromS, toS);
      const texture = 10 * Math.log10(Math.max(1e-12,
        10 ** (broad / 10) - 10 ** (bed / 10)));
      calmThirds.push({ rms: broad, bed, texture });
    }
  }
  let gestureVsRoutineDb = Number.NEGATIVE_INFINITY;
  if (name === "waiting-holds") {
    const baseline = bandRmsDb(mono, sampleRate, 5, 9.5, 150, 3000);
    gestureVsRoutineDb = tensionBandRmsDb - baseline;
  }
  // Macro-world solo (revp3t12): the checkpoint triad plus texture
  // swell alone (lanes idle, bed muted), rendered on the same seeded
  // epoch schedule. The gate asserts the world audibly re-voices across
  // the first seeded boundary: per-epoch centroid movement (the triad
  // pitches move A/F# → D/B, so the spectrum must shift) plus a chroma
  // report. Split at the seed-161 first boundary (76.78 s, probed from
  // nextBoundaryAfter in Node — never tuned): epoch 0 (aeolian-haze,
  // A/F#) vs epoch 1 (lydian-light, D/B).
  let macroSoloChromaFirst = Number.NaN;
  let macroSoloChromaSecond = Number.NaN;
  let macroSoloCentroidFirst = Number.NaN;
  let macroSoloCentroidSecond = Number.NaN;
  let macroSoloRms = Number.NEGATIVE_INFINITY;
  // Harmonic field (ADR 0025): the world solo's chroma entropy per third
  // of the render, so the log shows the chord widening and narrowing
  // over the epochs, plus the solo's peak (the field must never carry
  // the mix's peak).
  let fieldSoloChromaThirds = [];
  let fieldSoloPeakDb = Number.NEGATIVE_INFINITY;
  let emptyActiveDb = Number.NaN;
  let emptySettledDb = Number.NaN;
  let tonalFirstPc = -1;
  let tonalLastPc = -1;
  if (name === "empty-room") {
    emptyActiveDb = windowRmsDb(mono, sampleRate, 8, 18);
    emptySettledDb = windowRmsDb(mono, sampleRate, 60, durationS);
  }
  if (name === "tonal-journey") {
    // Seed 161 at 880 s: V9sus4 (bass A) until the move to F# at 20.8 s,
    // whose tonic chord holds its F# bass to about 52 s.
    tonalFirstPc = dominantPitchClass(mono, sampleRate, 12, 20, 200);
    tonalLastPc = dominantPitchClass(mono, sampleRate, 30, 44, 200);
  }
  // Nature-bed solo (p3-t15): the sampled bed alone at its mix seat.
  // REPORTED, never gated — entry only, per the task (no threshold,
  // window or metric edits to make the mix pass): the solo level plus
  // the bed-vs-texture seating say whether the bed sits low without
  // masking the hard signals. The solo is a single-apply snapshot that
  // climbs the 4 s density approach from silence, so the level reads
  // the render's second half (settled seat), not the climb.
  let natureSoloRms = Number.NEGATIVE_INFINITY;
  // Spatial-drift entry (p3-t16, ADR 0017): lane identity under the
  // seeded macro wander — stereo/mono lane-1 solos plus the stereo
  // image split. REPORTED, never gated (no threshold, window, or
  // metric edits): the numbers say whether register + timbre carry the
  // lane when the wander breathes pan/width/distance around it, and
  // whether the mono sum keeps the same identity the stereo image
  // shows. Mono here is the harness mean ((L+R)/2), the
  // laptop-speaker-equivalent sum — not a new metric.
  let spatialStereoRms = Number.NEGATIVE_INFINITY;
  let spatialMonoRms = Number.NEGATIVE_INFINITY;
  let spatialLaneSoloDb = Number.NEGATIVE_INFINITY;
  let spatialLaneSoloMonoDb = Number.NEGATIVE_INFINITY;
  if (name === "routine-3-lanes-calm06") {
    const nature = await renderQaScenario(name, seed, "nature");
    const natureMono = toMono(nature.left, nature.right);
    const natureLenS = natureMono.length / nature.sampleRate;
    natureSoloRms = windowRmsDb(natureMono, nature.sampleRate, natureLenS / 2, natureLenS);
  }
  if (name === "spatial-drift") {
    // Stereo-vs-mono identity read: the lane-1 solo (mid voice, the
    // gated foreground diagonal) in stereo and summed to mono, plus the
    // mix's own stereo/mono split — the wander must not collapse the
    // lane or the image when the laptop sums it.
    const lane1 = await renderQaScenario(name, seed, 1, 30);
    const lane1Mono = toMono(lane1.left, lane1.right);
    const lane1LenS = lane1Mono.length / lane1.sampleRate;
    spatialLaneSoloDb = rmsDb(lane1Mono);
    const summed = new Float32Array(lane1Mono.length);
    for (let i = 0; i < summed.length; i++) {
      summed[i] = (lane1.left[i] ?? 0) + (lane1.right[i] ?? 0);
    }
    void lane1LenS;
    spatialLaneSoloMonoDb = rmsDb(summed);
    spatialStereoRms = rmsDb(mono);
    const mixSummed = new Float32Array(mono.length);
    for (let i = 0; i < mixSummed.length; i++) {
      mixSummed[i] = (left[i] ?? 0) + (right[i] ?? 0);
    }
    spatialMonoRms = rmsDb(mixSummed);
  }
  if (name === "harmonic-field") {
    const macro = await renderQaScenario(name, seed, "macro");
    const macroMono = toMono(macro.left, macro.right);
    const macroLenS = macroMono.length / macro.sampleRate;
    macroSoloRms = rmsDb(macroMono);
    fieldSoloPeakDb = Math.max(peakDb(macro.left), peakDb(macro.right));
    const third = macroLenS / 3;
    fieldSoloChromaThirds = [0, 1, 2].map((k) =>
      chromaEntropy(macroMono, macro.sampleRate, k * third + 5, (k + 1) * third - 5));
  }
  if (name === "macro-evolution") {
    // The world solo before the first seeded boundary (76.78 s for seed
    // 161) against the render's last 35 s. Since ADR 0025 the world is
    // the harmonic field: epoch 1 of seed 161 keeps epoch 0's pitches
    // (only emphasis changes), so the first audible re-voicing lands in
    // epoch 2 (from 142.95 s plus the staggered slot offsets), and the
    // late window is the settled end of the render rather than the
    // window right after the first boundary. Same metric, same 20 Hz
    // margin; the window change is recorded in SOUND_DESIGN.md.
    const macro = await renderQaScenario(name, seed, "macro");
    const macroMono = toMono(macro.left, macro.right);
    const macroLenS = macroMono.length / macro.sampleRate;
    const split = Math.min(76.78, macroLenS / 2);
    const lateFromS = Math.max(split + 10, macroLenS - 40);
    macroSoloChromaFirst = chromaEntropy(macroMono, macro.sampleRate, 10, split - 5);
    macroSoloChromaSecond = chromaEntropy(macroMono, macro.sampleRate, lateFromS, macroLenS - 5);
    macroSoloCentroidFirst = spectralCentroid(macroMono, macro.sampleRate, 10, split - 5);
    macroSoloCentroidSecond = spectralCentroid(
      macroMono,
      macro.sampleRate,
      lateFromS,
      macroLenS - 5,
    );
    macroSoloRms = rmsDb(macroMono);
  }
  const fluxMean = (frameS) => {
    const series = fluxSeries(mono, sampleRate, 0, durationS, frameS);
    let sum = 0;
    for (let i = 0; i < series.length; i++) sum += series[i] ?? 0;
    return series.length === 0 ? 0 : sum / series.length;
  };
  const fluxShort = fluxMean(2048 / sampleRate);
  const fluxMedium = fluxMean(0.5);
  const fluxLong = fluxMean(2);
  const chroma = chromaEntropy(mono, sampleRate, 0, durationS);
  const recurrence = contourRecurrence(mono, sampleRate, 0, durationS);
  const density = densityVariation(mono, sampleRate, 0, durationS);
  const drift = spectralDrift(mono, sampleRate, 0, durationS);
  // Non-gating musical diagnostics (p3-t11, ADR 0020): support
  // listening, never gate. Flux over short (43 ms), medium (0.5 s) and
  // long (2 s) windows, chroma entropy over the whole render, contour
  // recurrence and density variation, long-term spectral drift
  // (first-half vs second-half centroid and cosine distance).
  // Foreground order: per-20 s-window RMS order as the wet/dry proxy.
  // Honest scope: this INDICATES the foreground lane carries its +2 dB
  // nudge and driest send — it does not prove the wet/dry ratio tracks
  // prominence, because the plan-level reverbSend values (unit-tested in
  // Node) own that mapping and the mix cannot separate wet from dry.
  const foregroundOrder = [0, 1, 2].map((k) =>
    windowRmsDb(mono, sampleRate, k * 20, Math.min((k + 1) * 20, durationS)));
  const wavBase64 = encodeWavFloat(left, right, sampleRate);
  return {
    sampleRate, length: mono.length,
    rmsDb: rmsDb(mono), peakDb: peakDb(mono),
    bandShare2k5k: bandEnergyShare(mono, sampleRate, 2000, 5000),
    bandShare6kUp: bandEnergyShare(mono, sampleRate, 6000, 20000),
    maxAutocorr5s: maxAutocorr(mono, sampleRate, 5, Math.min(30, durationS / 2), 1),
    maxJump: maxSampleJump(left, right), dc: dcOffset(mono),
    rmsSettledDb, rmsLast10Db, regularityEarly, regularityLate,
    tensionBandRmsDb, bedRmsDb, textureRmsDb,
    resolveSoloDb, resolveSoloEarlyDb, laneSoloDb: laneSolos, laneSoloLoudDb: laneSoloLouds,
    foregroundSolos, foregroundLoudSolos,
    modeCentroidsHz, foregroundOrder, wavBase64,
    questionPeakAtS, questionOnsetAtS,
    calmThirds, gestureVsRoutineDb,
    fluxShort, fluxMedium, fluxLong, chromaEntropy: chroma,
    contourRecurrence: recurrence, densityVariation: density,
    driftCentroidFirstHz: drift.centroidFirstHz,
    driftCentroidSecondHz: drift.centroidSecondHz,
    driftCosineDistance: drift.cosineDistance,
    macroSoloChromaFirst, macroSoloChromaSecond,
    macroSoloCentroidFirst, macroSoloCentroidSecond,
    macroSoloRms, natureSoloRms,
    fieldSoloChromaThirds, fieldSoloPeakDb,
    emptyActiveDb, emptySettledDb, tonalFirstPc, tonalLastPc,
    spatialStereoRms, spatialMonoRms, spatialLaneSoloDb, spatialLaneSoloMonoDb,
  };
})();
`;

/**
 * Named ensemble routine-note schedules for the QA entry (p5-t01): the
 * deterministic move plans behind the two ensemble A/B scenarios, served
 * as a static module so the page needs no fixture bytes: the QA entry
 * imports ENSEMBLE_SCHEDULES and threads each version's plan into
 * renderQaScenario's ensembleSchedule argument.
 *
 * The plans are recorded here as data pinned by the unit tests
 * (independent: 18 seeded moves) — the audition slice builds the same
 * plans from the same pure schedulers, so the QA entry and the slice
 * never drift apart silently. The hybrid schedule is planner-built, not
 * hand-authored: it is the p5-t02 core harmonic planner's `HarmonicMove`
 * plans for the shared slice trajectory, voiced through the p5-t03 seam
 * (`harmonicVoicePlan`) and threaded here with the `"harmonic"`
 * provenance tag — so the named QA path proves a real planner plan
 * reaches the crossfade path. (The prototype's 23/53/90/120 s readings
 * vs the planner's 37/67/90/120 s: the eligibility windows differ by
 * construction — per-sample full-trail persistence vs paired
 * window-baseline comparisons — and the pin is the planner's own
 * output, not the prototype's.)
 */
async function buildEnsembleSchedules(): Promise<string> {
  const schedules: Record<
    string,
    {
      version: string;
      moves: { laneIndex: number; atS: number; pitch: number; fromPitch: number }[];
    }
  > = {
    // The plans apps/web/src/ensemble-ab.ts builds for seed 161, kept in
    // step with it by hand (the spec bundles the audio package, not the
    // web app). Pitches are anchored on each lane's construction pitch
    // (pad E2/40, mallet A4/69, flute A5/81), so every move is one
    // pentatonic step from where the lane already sounds.
    "ensemble-ab-independent": {
      version: "independent",
      moves: [
        { laneIndex: 0, atS: 12.9, pitch: 42, fromPitch: 40 },
        { laneIndex: 2, atS: 13.3, pitch: 83, fromPitch: 81 },
        { laneIndex: 1, atS: 15.19, pitch: 66, fromPitch: 69 },
        { laneIndex: 0, atS: 33.81, pitch: 40, fromPitch: 42 },
        { laneIndex: 1, atS: 36.39, pitch: 64, fromPitch: 66 },
        { laneIndex: 2, atS: 42.72, pitch: 81, fromPitch: 83 },
        { laneIndex: 1, atS: 56.48, pitch: 66, fromPitch: 64 },
        { laneIndex: 0, atS: 61.01, pitch: 38, fromPitch: 40 },
        { laneIndex: 2, atS: 69.82, pitch: 78, fromPitch: 81 },
        { laneIndex: 1, atS: 78.07, pitch: 69, fromPitch: 66 },
        { laneIndex: 0, atS: 85.46, pitch: 40, fromPitch: 38 },
        { laneIndex: 1, atS: 96.85, pitch: 66, fromPitch: 69 },
        { laneIndex: 2, atS: 98.12, pitch: 81, fromPitch: 78 },
        { laneIndex: 0, atS: 112.24, pitch: 42, fromPitch: 40 },
        { laneIndex: 1, atS: 116.86, pitch: 64, fromPitch: 66 },
        { laneIndex: 2, atS: 125.06, pitch: 83, fromPitch: 81 },
        { laneIndex: 1, atS: 140.14, pitch: 66, fromPitch: 64 },
        { laneIndex: 0, atS: 140.15, pitch: 40, fromPitch: 42 },
      ],
    },
    "ensemble-ab-hybrid": {
      version: "harmonic",
      moves: [
        { laneIndex: 1, atS: 37, pitch: 66, fromPitch: 69 },
        { laneIndex: 1, atS: 67, pitch: 64, fromPitch: 66 },
        { laneIndex: 1, atS: 90, pitch: 66, fromPitch: 64 },
        { laneIndex: 1, atS: 120, pitch: 69, fromPitch: 66 },
      ],
    },
  };
  return `export const ENSEMBLE_SCHEDULES = ${JSON.stringify(schedules)};`;
}

type QaBundle = {
  bundle: string;
  metrics: string;
  schedules: string;
  wavUrl: string;
  wav: Buffer;
};

/**
 * Builds the QA bundle once per worker process. Every build writes into
 * its own temporary directory with uniquely named entry files, so two
 * workers (or two checkouts) can never empty each other's output: the
 * shared `.tmp-qa` directory this replaced was deleted by whichever build
 * finished second (`emptyOutDir: true`), and the loser then failed on a
 * missing metrics module.
 */
let bundleOnce: Promise<QaBundle> | null = null;

function bundleForBrowser(): Promise<QaBundle> {
  if (bundleOnce === null) {
    bundleOnce = buildBundle();
  }
  return bundleOnce;
}

async function buildBundle(): Promise<QaBundle> {
  const audioRoot = join(REPO_ROOT, "packages", "audio");
  const tag = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const entry = join(audioRoot, `.tmp-qa-${tag}.entry.js`);
  const metricsEntry = join(audioRoot, `.tmp-qa-${tag}-metrics.entry.js`);
  const out = await mkdtemp(join(tmpdir(), "hearable-audio-qa-"));
  // The nature-bed WAV rides the QA bundle as a bundler-resolved ?url
  // asset (revp3t15): the small WAV inlines as data audio/wav base64, so
  // render.ts exports its bundle URL and the test server below decodes
  // the same bundled bytes — the same code path live takes through the
  // web build's emitted .wav, decoded in the render's own context.
  await writeFile(
    entry,
    [
      `export { renderQaScenario, natureBundleUrl, renderReplayDrive, renderPianoCueAudition } from "./src/qa/render.js";`,
      `export { buildReplayDrive, REPLAY_CALMS, REPLAY_WINDOWS } from "./src/qa/replay.js";`,
      "",
    ].join("\n"),
  );
  await writeFile(
    metricsEntry,
    [
      `export { aWeightPower } from "./src/qa/metrics.js";`,
      `export { autocorrelationAtLag } from "./src/qa/metrics.js";`,
      `export { bandEnergyShare } from "./src/qa/metrics.js";`,
      `export { bandRmsDb } from "./src/qa/metrics.js";`,
      `export { chromaEntropy } from "./src/qa/metrics.js";`,
      `export { contourRecurrence } from "./src/qa/metrics.js";`,
      `export { dcOffset } from "./src/qa/metrics.js";`,
      `export { densityVariation } from "./src/qa/metrics.js";`,
      `export { dominantPitchClass } from "./src/qa/metrics.js";`,
      `export { downsampleMean } from "./src/qa/metrics.js";`,
      `export { firstFluxOnset } from "./src/qa/metrics.js";`,
      `export { fluxSeries } from "./src/qa/metrics.js";`,
      `export { loudnessDb } from "./src/qa/metrics.js";`,
      `export { maxSampleJump } from "./src/qa/metrics.js";`,
      `export { meanPowerSpectrum } from "./src/qa/metrics.js";`,
      `export { peakDb } from "./src/qa/metrics.js";`,
      `export { rmsDb } from "./src/qa/metrics.js";`,
      `export { spectralCentroid } from "./src/qa/metrics.js";`,
      `export { spectralDrift } from "./src/qa/metrics.js";`,
      `export { toMono } from "./src/qa/metrics.js";`,
      `export { windowRegularity } from "./src/qa/metrics.js";`,
      `export { windowRmsDb } from "./src/qa/metrics.js";`,
      "",
    ].join("\n"),
  );
  try {
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          'import { build } from "./apps/web/node_modules/vite/dist/node/index.js";',
          "await build({",
          '  root: "packages/audio",',
          '  logLevel: "silent",',
          "  build: {",
          `    outDir: ${JSON.stringify(out)},`,
          "    emptyOutDir: true,",
          "    minify: false,",
          `    lib: { entry: ${JSON.stringify(entry)}, formats: ["es"], fileName: () => "qa-bundle.mjs" },`,
          "  },",
          "});",
          "await build({",
          '  root: "packages/audio",',
          '  logLevel: "silent",',
          "  build: {",
          `    outDir: ${JSON.stringify(out)},`,
          "    emptyOutDir: false,",
          "    minify: false,",
          `    lib: { entry: ${JSON.stringify(metricsEntry)}, formats: ["es"], fileName: () => "qa-metrics.mjs" },`,
          "  },",
          "});",
        ].join("\n"),
      ],
      { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
    );
    const bundle = await readFile(join(out, "qa-bundle.mjs"), "utf8");
    const metrics = await readFile(join(out, "qa-metrics.mjs"), "utf8");
    const schedules = await buildEnsembleSchedules();
    // The bundle inlines the WAV as data audio/wav base64: read the bundle
    // URL the render fetches and the bytes behind it, so the test server
    // serves the bundled bytes at the URL the graph requests.
    const urlMatch = [...bundle.matchAll(/data:audio\/wav;base64,[A-Za-z0-9+/=]+/g)].find(
      (match) => Buffer.from(match[0].split(",")[1] ?? "", "base64").length === 384_044,
    );
    if (urlMatch === undefined) {
      throw new Error("audio:qa expects the bundled nature-bed wav inline, found none");
    }
    const wavUrl = urlMatch[0];
    const wav = Buffer.from(wavUrl.split(",")[1] ?? "", "base64");
    return { bundle, metrics, schedules, wavUrl, wav };
  } finally {
    await rm(entry, { force: true });
    await rm(metricsEntry, { force: true });
    await rm(out, { force: true, recursive: true });
  }
}

type QaServer = { baseUrl: string; close: () => Promise<void> };

/** Serves the bundle modules on an ephemeral loopback port; nothing else. */
async function serveModules(files: Record<string, string>, title: string): Promise<QaServer> {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body>${title}</body></html>`);
      return;
    }
    const body = files[pathname];
    if (body !== undefined) {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(body);
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Failures = { failures: string[]; check: (ok: boolean, message: string) => void };

function collectFailures(): Failures {
  const failures: string[] = [];
  return {
    failures,
    check: (ok, message) => {
      if (!ok) failures.push(message);
    },
  };
}

type PlaybackMetrics = { windows: number[]; peak: number; jump: number; wavBase64: string };

type ScenarioPage = {
  renderMetrics: (name: QaScenarioName, seed: number) => Promise<QaMetrics>;
  playbackMetrics: () => Promise<PlaybackMetrics>;
  close: () => Promise<void>;
};

/**
 * Opens the sandbox QA page: bundle served from an ephemeral port, the
 * nature-bed data URL routed to the bundled bytes, the QA module installed.
 */
async function openScenarioPage(page: Page): Promise<ScenarioPage> {
  const { bundle, metrics, schedules, wavUrl, wav } = await bundleForBrowser();
  // The graph fetches the bundler-resolved data URL inline: intercept
  // the request routing instead of the network, so the decode reads the
  // bundled bytes through the identical fetch path — and a missing
  // bundle rejects loudly in `ready`, never silently dry.
  await page.route(wavUrl.slice(0, 64), async (route) => {
    await route.fulfill({ status: 200, contentType: "audio/wav", body: wav });
  });
  const server = await serveModules(
    {
      "/qa-bundle.mjs": bundle,
      "/qa-metrics.mjs": metrics,
      "/qa-ensemble-schedules.mjs": schedules,
    },
    "audio qa",
  );
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await page.goto(`${server.baseUrl}/`);
  await page.addScriptTag({ content: QA_PAGE, type: "module" });
  await page.waitForFunction(
    () => (globalThis as unknown as { __qaMetrics?: unknown }).__qaMetrics !== undefined,
  );
  return {
    renderMetrics: (name, seed) =>
      page.evaluate(
        ({ scenario, renderSeed }: { scenario: QaScenarioName; renderSeed: number }) => {
          const qaMetrics = (globalThis as unknown as { __qaMetrics: unknown }).__qaMetrics as (
            scenarioName: string,
            seedValue: number,
          ) => Promise<QaMetrics>;
          return qaMetrics(scenario, renderSeed);
        },
        { scenario: name, renderSeed: seed },
      ),
    playbackMetrics: () =>
      page.evaluate(() =>
        (
          globalThis as unknown as { __playbackMetrics: () => Promise<PlaybackMetrics> }
        ).__playbackMetrics(),
      ),
    close: server.close,
  };
}

async function writeScenarioArtifacts(name: string, m: QaMetrics): Promise<void> {
  await writeFile(
    join(ARTIFACT_DIR, `${name}.json`),
    JSON.stringify({ scenario: name, seed: 161, ...m, wavBase64: undefined }),
  );
  await writeFile(join(ARTIFACT_DIR, `${name}.wav`), Buffer.from(m.wavBase64, "base64"));
}

function logScenario(name: string, m: QaMetrics): void {
  console.log(
    `qa ${name}: rms=${m.rmsDb.toFixed(1)} peak=${m.peakDb.toFixed(1)} band=${(m.bandShare2k5k * 100).toFixed(1)}% autocorr=${m.maxAutocorr5s.toFixed(3)} jump=${m.maxJump.toFixed(4)} dc=${m.dc.toFixed(5)} reg=${m.regularityEarly.toFixed(3)}->${m.regularityLate.toFixed(3)} onset=${m.questionOnsetAtS.toFixed(2)} peakloc=${m.questionPeakAtS.toFixed(2)} flux=${m.fluxShort.toFixed(3)}/${m.fluxMedium.toFixed(3)}/${m.fluxLong.toFixed(3)} chroma=${m.chromaEntropy.toFixed(2)} recur=${m.contourRecurrence.toFixed(3)} dens=${m.densityVariation.toFixed(3)} drift=${m.driftCentroidFirstHz.toFixed(0)}->${m.driftCentroidSecondHz.toFixed(0)}Hz/${m.driftCosineDistance.toFixed(3)}`,
  );
}

/**
 * The per-scenario bounds from SOUND_DESIGN.md §Automated QA. Every
 * scenario carries the three universal fatigue gates (peaks, clicks, DC);
 * the named rules below gate or report exactly what the table says.
 */
function checkScenario(name: QaScenarioName, m: QaMetrics, check: Failures["check"]): void {
  check(
    m.peakDb <= -3,
    `${name}: peaks must stay at or below -3 dBFS, got ${m.peakDb.toFixed(1)} dBFS (fatigue rule 1)`,
  );
  check(
    m.maxJump <= 0.3,
    `${name}: no sample-to-sample jump above 0.3 full scale, got ${m.maxJump.toFixed(3)} (fatigue rule 6)`,
  );
  check(
    Math.abs(m.dc) <= 0.01,
    `${name}: DC offset must stay at or below 0.01, got ${m.dc.toFixed(5)} (fatigue rule 7)`,
  );

  if (name === "routine-3-lanes-calm06") {
    check(
      m.rmsDb >= -26 && m.rmsDb <= -20,
      `${name}: 60 s RMS must sit between -26 and -20 dBFS at calm 0.6, got ${m.rmsDb.toFixed(1)} dBFS (fatigue rule 1)`,
    );
    check(
      m.bandShare2k5k <= 0.15,
      `${name}: energy in 2-5 kHz must stay at or below 15 percent, got ${(m.bandShare2k5k * 100).toFixed(1)} percent (fatigue rule 2)`,
    );
    check(
      m.maxAutocorr5s < 0.9,
      `${name}: autocorrelation at lags of 5 s or more must stay below 0.9, got ${m.maxAutocorr5s.toFixed(3)} (fatigue rule 4)`,
    );
    console.log(
      `qa-nature ${name}: bed solo ${m.natureSoloRms.toFixed(1)} dBFS at mix seat (reported, never gated: the sampled bed alone — sits-low read, owner p3-t15)`,
    );
  }
  if (name === "near-silence-calm09") {
    check(
      m.rmsDb <= -40,
      `${name}: near-silence beds and textures must stay at or below -40 dBFS combined, got ${m.rmsDb.toFixed(1)} dBFS (fatigue rule 5; bed-band ${m.bedRmsDb.toFixed(1)} dBFS, texture estimate ${m.textureRmsDb.toFixed(1)} dBFS)`,
    );
  }
  if (name === "single-lane-modes") {
    const [a, b, c] = m.modeCentroidsHz;
    const spread = Math.max(a, b, c) - Math.min(a, b, c);
    check(
      spread > 50,
      `${name}: modes must be spectrally distinct per third, got centroids ${a.toFixed(0)}/${b.toFixed(0)}/${c.toFixed(0)} Hz (rule 6 plus distinction)`,
    );
    // High-frequency energy bound (NOT a sustained-tone detector —
    // that gap is backlog; see SOUND_DESIGN harness detail).
    check(
      m.bandShare6kUp <= 0.05,
      `${name}: high-frequency energy above 6 kHz must stay bounded, got ${(m.bandShare6kUp * 100).toFixed(1)} percent (fatigue rule 2 energy half)`,
    );
  }
  if (name === "struggle-ramp") {
    check(
      m.rmsLast10Db <= m.rmsSettledDb + 1,
      `${name}: struggle must not raise loudness, last-10 s RMS ${m.rmsLast10Db.toFixed(1)} dBFS exceeds settled 20-30 s ${m.rmsSettledDb.toFixed(1)} dBFS by more than 1 dB`,
    );
    // Regularity stability (NOT a rise gate — see the LIMITATION
    // comment at the metric): the rendered envelope repetition must
    // not collapse between the low- and high-struggle windows.
    // Tolerance 0.10 clears the determinism wobble (±0.02) with room;
    // a rise gate would fail on today's mix (0.463 vs 0.478, needs
    // +0.05) because regularity is not yet wired to audio.
    check(
      m.regularityLate - m.regularityEarly >= 0.05,
      `${name}: rendered repetition must rise across the ramp, late ${m.regularityLate.toFixed(3)} vs early ${m.regularityEarly.toFixed(3)} (needs +0.05; regularity not yet wired to audio -- owner p3-t03/p3-t13)`,
    );
  }
  if (name === "waiting-holds") {
    check(
      m.tensionBandRmsDb >= -40,
      `${name}: tension-band energy must stay present from 13 s to end, got ${m.tensionBandRmsDb.toFixed(1)} dBFS in 150-600 Hz (absolute floor)`,
    );
    check(
      m.questionOnsetAtS >= 10 && m.questionOnsetAtS <= 12,
      `${name}: question onset (first flux edge) must occur between 10 and 12 s, got ${m.questionOnsetAtS.toFixed(2)} s (peak locator reads ${m.questionPeakAtS.toFixed(2)} s -- the sustain/tension swell tail, not the onset; owner p3-t03/p3-t13)`,
    );
    console.log(
      `qa-gesture ${name}: gesture-vs-routine ${m.gestureVsRoutineDb.toFixed(1)} dB (tension band vs pre-gesture baseline; reported, owner p3-t14 for the Calm-invariant hard-signal half)`,
    );
  }
  if (name === "resolve-fades") {
    // Lane-1 solo (bed muted) isolates the fade the centre-panned mix
    // cannot separate. INDICATES the fade trajectory works; the mix
    // seating is not proven by this number (see the solo comment).
    check(
      m.resolveSoloEarlyDb - m.resolveSoloDb >= 20,
      `${name}: the resolved lane's solo must drop from its early to its late state, early ${m.resolveSoloEarlyDb.toFixed(1)} dBFS vs late ${m.resolveSoloDb.toFixed(1)} dBFS (needs a 20 dB drop)`,
    );
  }
  if (name === "foreground-switch") {
    // Foreground seating, measured honestly (p3-t11). The mix windows
    // carry only a +1 dB nudge plus a drier send (FOREGROUND_GAIN_NUDGE_DB
    // is 1 dB post-p3-t09; foreground is closer, not louder), so the
    // harness REPORTS per-window levels and pairwise deltas instead of
    // gating an order the mix cannot carry. The ORDER half is the
    // solo-matrix diagonal: each window's foreground lane soloed from that
    // window's state must be the loudest row entry, in raw RMS AND
    // A-weighted loudness (both meters gate row 1; rows 0/2 report, not
    // gate). LIMITATION, stated not hidden: solos restart from silence
    // instead of continuing mix state, so the matrix proves each lane CAN
    // be loudest in its own window's state -- not that the continuous mix
    // seats it there.
    const [r0, r1, r2] = m.foregroundOrder;
    console.log(
      `qa-foreground ${name}: mix windows A/B/C ${r0.toFixed(1)}/${r1.toFixed(1)}/${r2.toFixed(1)} dBFS (reported: +1 dB nudge plus dry send cannot order windows by level; owner p3-t14 for closeness cues)`,
    );
    const row1 = m.foregroundSolos[1] ?? [];
    const loudRow1 = m.foregroundLoudSolos[1] ?? [];
    check(
      (row1[1] ?? Number.NEGATIVE_INFINITY) >
        Math.max(row1[0] ?? Number.NEGATIVE_INFINITY, row1[2] ?? Number.NEGATIVE_INFINITY),
      `${name}: window 1 must be loudest on lane 1 solo, got [${row1.map((v) => v.toFixed(1)).join("/")}] dBFS`,
    );
    check(
      (loudRow1[1] ?? Number.NEGATIVE_INFINITY) >
        Math.max(loudRow1[0] ?? Number.NEGATIVE_INFINITY, loudRow1[2] ?? Number.NEGATIVE_INFINITY),
      `${name}: window 1 must be loudest on lane 1 loudness solo, got [${loudRow1.map((v) => v.toFixed(1)).join("/")}] dB (A-weighted; owner p3-t13)`,
    );
    console.log(
      `qa-foreground ${name}: row0 [${(m.foregroundSolos[0] ?? []).map((v) => v.toFixed(1)).join("/")}] loud [${(m.foregroundLoudSolos[0] ?? []).map((v) => v.toFixed(1)).join("/")}] row2 [${(m.foregroundSolos[2] ?? []).map((v) => v.toFixed(1)).join("/")}] loud [${(m.foregroundLoudSolos[2] ?? []).map((v) => v.toFixed(1)).join("/")}] (reported, not gated: lane 0 renders ~15 dB below lane 1 in both meters; owner p3-t13)`,
    );
  }
  if (name === "resolve-fades" || name === "foreground-switch") {
    // Lane solos, raw RMS plus A-weighted loudness side by side: when
    // both meters agree on a gap, the gap is a seating defect, not a
    // meter artifact. Read from the same render as the gates above.
    console.log(
      `qa-solo ${name}: lane0=${m.laneSoloDb[0]?.toFixed(1)}/${m.laneSoloLoudDb[0]?.toFixed(1)} loud lane1=${m.laneSoloDb[1]?.toFixed(1)}/${m.laneSoloLoudDb[1]?.toFixed(1)} loud lane2=${m.laneSoloDb[2]?.toFixed(1)}/${m.laneSoloLoudDb[2]?.toFixed(1)} loud resolveSolo=${m.resolveSoloDb.toFixed(1)} (early ${m.resolveSoloEarlyDb.toFixed(1)}) matrix=${m.foregroundSolos.map((row) => `[${row.map((v) => v.toFixed(1)).join("/")}]`).join(" ")} loud=${m.foregroundLoudSolos.map((row) => `[${row.map((v) => v.toFixed(1)).join("/")}]`).join(" ")}`,
    );
  }
  if (name === "macro-evolution") {
    // The world's own audible path (revp3t12): the 240 s render crosses
    // the seed-161 first boundary (76.78 s), and the macro-world solo
    // carries the checkpoint triad plus swell alone. GATED: the solo
    // audibly re-voices across the boundary (per-epoch centroid movement;
    // the 20 Hz threshold is the calibrated seed-161 margin, not a tuned
    // value) plus the same quiet world level as before. Chroma is
    // reported (a trio holds few pitch classes by design).
    const centroidMove = Math.abs(m.macroSoloCentroidSecond - m.macroSoloCentroidFirst);
    console.log(
      `qa-macro ${name}: solo rms=${m.macroSoloRms.toFixed(1)} chroma ${m.macroSoloChromaFirst.toFixed(2)}->${m.macroSoloChromaSecond.toFixed(2)} centroid ${m.macroSoloCentroidFirst.toFixed(0)}->${m.macroSoloCentroidSecond.toFixed(0)}Hz (move ${centroidMove.toFixed(0)}) mix rms=${m.rmsDb.toFixed(1)} peak=${m.peakDb.toFixed(1)} jump=${m.maxJump.toFixed(4)} autocorr=${m.maxAutocorr5s.toFixed(3)}`,
    );
    check(
      Number.isFinite(m.macroSoloCentroidFirst) &&
        Number.isFinite(m.macroSoloCentroidSecond) &&
        centroidMove >= 20,
      `${name}: the macro world must move spectrally across the seeded boundary, solo centroid ${m.macroSoloCentroidFirst.toFixed(0)}->${m.macroSoloCentroidSecond.toFixed(0)}Hz (needs a 20 Hz move)`,
    );
    check(
      m.macroSoloRms > -60 && m.macroSoloRms < -20,
      `${name}: the macro-world solo must sit at a quiet world level, got ${m.macroSoloRms.toFixed(1)} dBFS (needs -60 to -20 dBFS)`,
    );
  }
  if (name === "empty-room") {
    // The empty room (owner direction 2026-10-29): with nobody working the
    // scene all but disappears. GATED: the settled room (60 s to the end)
    // sits at or below -50 dBFS and at least 20 dB under the mix while the
    // agent worked; the universal gates above prove the fade never steps.
    console.log(
      `qa-empty ${name}: working ${m.emptyActiveDb.toFixed(1)} dBFS, empty room ${m.emptySettledDb.toFixed(1)} dBFS`,
    );
    check(
      m.emptySettledDb <= -50,
      `${name}: the empty room must sit at or below -50 dBFS, got ${m.emptySettledDb.toFixed(1)} dBFS`,
    );
    check(
      m.emptyActiveDb - m.emptySettledDb >= 20,
      `${name}: the empty room must sit at least 20 dB under the working mix, got ${(m.emptyActiveDb - m.emptySettledDb).toFixed(1)} dB`,
    );
  }
  if (name === "tonal-journey") {
    // The tonal journey (ADR 0027): seed 161 moves from D to F# at 20.8 s,
    // and the drone follows each chord's bass. GATED: the strongest pitch
    // class under 200 Hz (drone plus ground voice) is A under the V9sus4
    // before the move and F# under the new tonic after it, so the floor
    // really walks; the universal gates prove the handovers never step.
    console.log(
      `qa-journey ${name}: low pitch class ${m.tonalFirstPc} -> ${m.tonalLastPc} (semitones above D)`,
    );
    check(
      m.tonalFirstPc === 7 && m.tonalLastPc === 4,
      `${name}: the floor must walk from A (7) to F# (4), got ${m.tonalFirstPc} -> ${m.tonalLastPc}`,
    );
  }
  if (name === "harmonic-field") {
    // The harmonic field (ADR 0025), one agent in the mid seat for eight
    // minutes. GATED: the world solo sits at a quiet world level and
    // never carries the mix's peak; the mix keeps the universal fatigue
    // gates above. REPORTED: chroma entropy per third of the solo (the
    // chord widening and narrowing), the mix level, and the long-window
    // movement diagnostics — the ear decides the rest.
    console.log(
      `qa-field ${name}: solo rms=${m.macroSoloRms.toFixed(1)} peak=${m.fieldSoloPeakDb.toFixed(1)} chroma thirds ${m.fieldSoloChromaThirds.map((v) => v.toFixed(2)).join("/")} mix rms=${m.rmsDb.toFixed(1)} autocorr=${m.maxAutocorr5s.toFixed(3)} chroma=${m.chromaEntropy.toFixed(2)} recur=${m.contourRecurrence.toFixed(3)}`,
    );
    check(
      m.macroSoloRms > -60 && m.macroSoloRms < -24,
      `${name}: the harmonic field solo must sit at a quiet world level, got ${m.macroSoloRms.toFixed(1)} dBFS (needs -60 to -24 dBFS)`,
    );
    check(
      m.fieldSoloPeakDb <= -12,
      `${name}: the harmonic field solo must never approach the mix ceiling, got peak ${m.fieldSoloPeakDb.toFixed(1)} dBFS (needs -12 dBFS or below)`,
    );
    check(
      m.maxAutocorr5s < 0.9,
      `${name}: autocorrelation at lags of 5 s or more must stay below 0.9, got ${m.maxAutocorr5s.toFixed(3)} (fatigue rule 4)`,
    );
    check(
      m.bandShare2k5k <= 0.15,
      `${name}: energy in 2-5 kHz must stay at or below 15 percent, got ${(m.bandShare2k5k * 100).toFixed(1)} percent (fatigue rule 2)`,
    );
  }
  if (name === "spatial-drift") {
    // REPORTED, never gated (p3-t16, ADR 0017): the stereo/mono lane-1
    // solos plus the mix's own stereo-vs-summed split say whether
    // register + timbre carry the lane when the wander breathes
    // pan/width/distance around it.
    console.log(
      `qa-spatial ${name}: mix rms=${m.rmsDb.toFixed(1)} stereo ${m.spatialStereoRms.toFixed(1)} vs summed ${m.spatialMonoRms.toFixed(1)} lane1 stereo ${m.spatialLaneSoloDb.toFixed(1)} vs summed ${m.spatialLaneSoloMonoDb.toFixed(1)} (reported, never gated: identity reads register + timbre, position only enhances)`,
    );
  }
  if (name === "ensemble-ab-independent" || name === "ensemble-ab-hybrid") {
    // REPORTED, never gated (p5-t01, ADR 0021): the shared 150 s slice
    // under the named routine-note schedule plus the production cues
    // reads the new audible path inside the existing fatigue bounds.
    console.log(
      `qa-ensemble ${name}: mix rms=${m.rmsDb.toFixed(1)} band=${(m.bandShare2k5k * 100).toFixed(1)}% autocorr=${m.maxAutocorr5s.toFixed(3)} onset=${m.questionOnsetAtS.toFixed(2)} (reported, never gated: the A/B scheduling variable under identical cues)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Replay matrix (p4-t06): fixture sessions folded through engine → attention
// in the page and rendered through the same graph/apply/gesture path the
// live page takes. The fixture lines arrive pre-parsed; no fixture is
// written. The ACP third has no adapter and no fixtures, so the mix sounds
// the two real families and the gap is recorded, never faked.
// ---------------------------------------------------------------------------

const REPLAY_QA_PAGE = `
  import { buildReplayDrive, renderReplayDrive } from "/qa-bundle.mjs";
  import {
    autocorrelationAtLag, bandEnergyShare, dcOffset, downsampleMean,
    firstFluxOnset, fluxSeries, maxSampleJump, peakDb, rmsDb, toMono, windowRmsDb,
  } from "/qa-metrics.mjs";

  function replayMaxAutocorr(samples, sampleRate, minLagS, maxLagS, stepS) {
    const slow = downsampleMean(samples, sampleRate, 100);
    const slowRate = 100;
    const minLag = Math.round(minLagS * slowRate);
    const maxLag = Math.min(slow.length - 1, Math.round(maxLagS * slowRate));
    let max = 0;
    for (let lag = minLag; lag <= maxLag; lag += Math.max(1, Math.round(stepS * slowRate))) {
      max = Math.max(max, Math.abs(autocorrelationAtLag(slow, lag)));
    }
    return max;
  }

  globalThis.__qaReplay = (setup, calm, fixtureEvents, laneIds, windowStartS, windowEndS, calmTrack, seed) => (async () => {
    const lanes = laneIds.map((laneId, i) => ({
      laneId,
      sessionId: fixtureEvents[i]?.events?.[0]?.sessionId ?? \`replay-\${laneId}\`,
      agent: fixtureEvents[i]?.agent ?? "claude-code",
      events: fixtureEvents[i]?.events ?? [],
    }));
    const drive = buildReplayDrive(setup, lanes, { windowStartS, windowEndS, calm, calmTrack: calmTrack ?? [] });
    const { sampleRate, left, right } = await renderReplayDrive(drive, seed);
    const mono = toMono(left, right);
    const durationS = mono.length / sampleRate;
    const last10 = windowRmsDb(mono, sampleRate, Math.max(0, durationS - 10), durationS);
    // Struggle-loudness settled window: the replay drives sample engine
    // state at whole render seconds, so t=0 already holds live levels —
    // no startup climb to skip. Settle on 5–15 s, compare the last 10 s.
    const settled = windowRmsDb(mono, sampleRate, 5, Math.min(15, durationS));
    // Waiting-onset read for the replayed permission/question lane: first
    // flux rise-edge against the ducked floor. The window opens at the
    // drive's first waiting step (waitingAtS) minus 0.5 s and runs 3.5 s —
    // the same rise-edge definition (threshold 0.4, ~43 ms frames) the
    // waiting-holds gate uses, relocated to the replayed trigger time.
    let replayOnsetAtS = -2;
    let waitingAtS = drive.waitingAtS ?? -1;
    if (waitingAtS >= 0) {
      const fromS = Math.max(0, waitingAtS - 0.5);
      const toS = Math.min(durationS, fromS + 3.5);
      const frameS = 2048 / sampleRate;
      const flux = fluxSeries(mono, sampleRate, fromS, toS, frameS);
      replayOnsetAtS = firstFluxOnset(flux, fromS, frameS, 0.4);
    }
    return {
      sampleRate, length: mono.length,
      rmsDb: rmsDb(mono), peakDb: peakDb(mono),
      bandShare2k5k: bandEnergyShare(mono, sampleRate, 2000, 5000),
      bandShare6kUp: bandEnergyShare(mono, sampleRate, 6000, 20000),
      maxAutocorr5s: replayMaxAutocorr(mono, sampleRate, 5, Math.min(30, durationS / 2), 1),
      maxJump: maxSampleJump(left, right), dc: dcOffset(mono),
      rmsSettledDb: settled, rmsLast10Db: last10,
      replayOnsetAtS, waitingAtS,
      durationS,
      completionAtS: drive.steps.find(step => step.lanes.some(lane => lane.lifecycle === "turn_complete"))?.atS ?? -1,
      waitingAfterCompletion: (() => {
        const completion = drive.steps.find(step => step.lanes.some(lane => lane.lifecycle === "turn_complete"))?.atS;
        return completion !== undefined && drive.steps.some(step => step.atS > completion && step.lanes.some(lane => lane.lifecycle === "waiting"));
      })(),
      resolveEvents: new Set(drive.steps.flatMap(step => step.lanes.flatMap(lane => lane.gestures.filter(cue => cue.gesture === "resolve").map(cue => lane.laneId + ":" + cue.at)))).size,
      wavBase64: (() => {
        const n = Math.min(left.length, right.length);
        const buffer = new ArrayBuffer(44 + n * 8);
        const view = new DataView(buffer);
        const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
        writeStr(0, "RIFF");
        view.setUint32(4, 36 + n * 8, true);
        writeStr(8, "WAVE");
        writeStr(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 3, true);
        view.setUint16(22, 2, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 8, true);
        view.setUint16(32, 8, true);
        view.setUint16(34, 32, true);
        writeStr(36, "data");
        view.setUint32(40, n * 8, true);
        for (let i = 0; i < n; i++) {
          view.setFloat32(44 + i * 8, left[i] ?? 0, true);
          view.setFloat32(44 + i * 8 + 4, right[i] ?? 0, true);
        }
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        return btoa(binary);
      })(),
    };
  })();
  `;

type ReplayMetrics = {
  sampleRate: number;
  length: number;
  rmsDb: number;
  peakDb: number;
  bandShare2k5k: number;
  bandShare6kUp: number;
  maxAutocorr5s: number;
  maxJump: number;
  dc: number;
  rmsSettledDb: number;
  rmsLast10Db: number;
  replayOnsetAtS: number;
  waitingAtS: number;
  durationS: number;
  completionAtS: number;
  waitingAfterCompletion: boolean;
  resolveEvents: number;
  wavBase64: string;
};

type FixtureEvents = { agent: string; events: unknown[] };

type CalmTrack = readonly (readonly [number, number])[];

type ReplayPage = {
  fixtureEvents: FixtureEvents[];
  renderReplay: (
    setup: string,
    calm: number,
    laneFixtures: readonly FixtureEvents[],
    laneIds: readonly number[],
    windowStartS: number,
    windowEndS: number,
    calmTrack?: CalmTrack,
  ) => Promise<ReplayMetrics>;
  close: () => Promise<void>;
};

async function readFixtureEvents(): Promise<FixtureEvents[]> {
  const fixtureEvents: FixtureEvents[] = [];
  for (const spec of FIXTURE_SPECS) {
    const text = await readFile(join(REPO_ROOT, spec.file), "utf8");
    const events = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => typeof line.kind === "string");
    fixtureEvents.push({ agent: spec.agent, events });
  }
  return fixtureEvents;
}

async function openReplayPage(page: Page): Promise<ReplayPage> {
  const { bundle, metrics, wavUrl, wav } = await bundleForBrowser();
  await page.route(wavUrl.slice(0, 64), async (route) => {
    await route.fulfill({ status: 200, contentType: "audio/wav", body: wav });
  });
  const server = await serveModules(
    { "/qa-bundle.mjs": bundle, "/qa-metrics.mjs": metrics },
    "audio qa replay",
  );
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await page.goto(`${server.baseUrl}/`);
  await page.addScriptTag({ content: REPLAY_QA_PAGE, type: "module" });
  await page.waitForFunction(
    () => (globalThis as unknown as { __qaReplay?: unknown }).__qaReplay !== undefined,
  );
  const fixtureEvents = await readFixtureEvents();
  return {
    fixtureEvents,
    renderReplay: (setup, calm, laneFixtures, laneIds, windowStartS, windowEndS, calmTrack = []) =>
      page.evaluate(
        ({
          replaySetup,
          replayCalm,
          events,
          lanes,
          fromS,
          toS,
          track,
        }: {
          replaySetup: string;
          replayCalm: number;
          events: FixtureEvents[];
          lanes: readonly number[];
          fromS: number;
          toS: number;
          track: CalmTrack;
        }) => {
          const qaReplay = (globalThis as unknown as { __qaReplay: unknown }).__qaReplay as (
            setupName: string,
            calmValue: number,
            fixtureEvents: unknown,
            laneIds: readonly number[],
            windowStartS: number,
            windowEndS: number,
            calmTrack: CalmTrack,
            seed: number,
          ) => Promise<ReplayMetrics>;
          return qaReplay(
            replaySetup,
            replayCalm,
            events,
            [...lanes],
            fromS,
            toS,
            [...track],
            0x0a1,
          );
        },
        {
          replaySetup: setup,
          replayCalm: calm,
          events: [...laneFixtures],
          lanes: laneIds,
          fromS: windowStartS,
          toS: windowEndS,
          track: calmTrack,
        },
      ),
    close: server.close,
  };
}

/** Which fixture families and lane ids a replay setup sounds. */
function replayLanes(
  setup: string,
  fixtureEvents: readonly FixtureEvents[],
): { fixtures: FixtureEvents[]; lanes: readonly number[] } {
  const pick = (indexes: number[]): FixtureEvents[] =>
    indexes.map((index) => {
      const entry = fixtureEvents[index];
      if (entry === undefined) throw new Error(`missing fixture ${index}`);
      return entry;
    });
  if (setup === "three-lane-mix") return { fixtures: pick([0, 1, 2]), lanes: [0, 1, 2] };
  if (setup === "claude-stuck") return { fixtures: pick([0]), lanes: [0] };
  return { fixtures: pick([1]), lanes: [1] };
}

async function writeReplayArtifacts(tag: string, extra: Record<string, unknown>, m: ReplayMetrics) {
  await writeFile(
    join(ARTIFACT_DIR, `${tag}.json`),
    JSON.stringify({
      scenario: tag,
      seed: 161,
      replay: true,
      ...extra,
      ...m,
      wavBase64: undefined,
    }),
  );
  await writeFile(join(ARTIFACT_DIR, `${tag}.wav`), Buffer.from(m.wavBase64, "base64"));
}

// ---------------------------------------------------------------------------
// Tests. One test per render group, so a slow or failing scenario names
// itself and the whole matrix spreads across workers instead of queueing
// behind one page for a quarter of an hour.
// ---------------------------------------------------------------------------

test.describe("audio qa", () => {
  test.setTimeout(600_000);

  test("activity-only playback opens and closes on the ramp without clicks", async ({ page }) => {
    const qa = await openScenarioPage(page);
    const { failures, check } = collectFailures();
    try {
      const playback = await qa.playbackMetrics();
      await writeFile(
        join(ARTIFACT_DIR, "activity-playback-start-stop.wav"),
        Buffer.from(playback.wavBase64, "base64"),
      );
      await writeFile(
        join(ARTIFACT_DIR, "activity-playback-start-stop.json"),
        JSON.stringify({ ...playback, wavBase64: undefined }),
      );
      console.log(
        `qa activity-playback-start-stop: ${JSON.stringify({ ...playback, wavBase64: undefined })}`,
      );
      for (const index of [0, 2, 4])
        check(
          (playback.windows[index] ?? 0) <= -100,
          `activity-playback: silent window ${index} must stay below -100 dBFS`,
        );
      for (const index of [1, 3])
        check(
          (playback.windows[index] ?? -200) > -60,
          `activity-playback: audible window ${index} must resume above -60 dBFS`,
        );
      check(playback.peak <= -3, "activity-playback: peaks must remain below -3 dBFS");
      check(playback.jump <= 0.3, "activity-playback: transitions must not step");
      expect(failures).toEqual([]);
    } finally {
      await qa.close();
    }
  });

  for (const name of QA_NAMES) {
    test(`${name} renders within the fatigue rules`, async ({ page }) => {
      const qa = await openScenarioPage(page);
      const { failures, check } = collectFailures();
      try {
        const m = await qa.renderMetrics(name, 0x0a1);
        await writeScenarioArtifacts(name, m);
        logScenario(name, m);
        checkScenario(name, m, check);
        expect(failures).toEqual([]);
      } finally {
        await qa.close();
      }
    });
  }

  test("routine-3-lanes-calm06 re-renders within tolerance from the same seed", async ({
    page,
  }) => {
    // Determinism: the same seed must re-render within tight tolerances.
    // NOT byte-identity: Tone's noise buffers, noise start offsets and
    // the reverb IR draw from an unseeded source (verified in the
    // shipped ESM), so two renders differ at the sample level by
    // construction. Levels agree within ±0.5 dB and spectral/autocorr
    // readings within ±0.02/±0.05 — a drift or mapping regression would
    // move them by far more.
    const qa = await openScenarioPage(page);
    try {
      const first = await qa.renderMetrics("routine-3-lanes-calm06", 0x0a1);
      const second = await qa.renderMetrics("routine-3-lanes-calm06", 0x0a1);
      // Logged so the fresh-page vs second-render gap is visible: the
      // numbers the per-scenario tests gate are always fresh-page numbers.
      console.log(
        `qa-determinism routine-3-lanes-calm06: first rms=${first.rmsDb.toFixed(2)} peak=${first.peakDb.toFixed(2)} second rms=${second.rmsDb.toFixed(2)} peak=${second.peakDb.toFixed(2)}`,
      );
      const within =
        Math.abs(first.rmsDb - second.rmsDb) <= 0.5 &&
        Math.abs(first.peakDb - second.peakDb) <= 0.5 &&
        Math.abs(first.bandShare2k5k - second.bandShare2k5k) <= 0.02 &&
        Math.abs(first.maxAutocorr5s - second.maxAutocorr5s) <= 0.05;
      expect(
        within,
        `routine-3-lanes-calm06: the same seed must re-render within tolerances, got rms ${first.rmsDb.toFixed(2)}/${second.rmsDb.toFixed(2)} peak ${first.peakDb.toFixed(2)}/${second.peakDb.toFixed(2)}`,
      ).toBe(true);
    } finally {
      await qa.close();
    }
  });

  for (const { setup, window } of REPLAY_SETUPS) {
    for (const calm of REPLAY_CALM_LEVELS) {
      test(`replay ${setup} at calm ${calm.toFixed(1)} stays within the fatigue rules`, async ({
        page,
      }) => {
        const replay = await openReplayPage(page);
        const { failures, check } = collectFailures();
        try {
          const { fixtures, lanes } = replayLanes(setup, replay.fixtureEvents);
          const m = await replay.renderReplay(
            setup,
            calm,
            fixtures,
            lanes,
            window.startS,
            window.endS,
          );
          const tag = `replay-${setup}-calm${calm.toFixed(1)}`;
          await writeReplayArtifacts(
            tag,
            { calm, setup, acpThird: "gap-no-adapter-no-fixtures" },
            m,
          );
          console.log(
            `qa ${tag}: rms=${m.rmsDb.toFixed(1)} peak=${m.peakDb.toFixed(1)} band=${(m.bandShare2k5k * 100).toFixed(1)}% autocorr=${m.maxAutocorr5s.toFixed(3)} jump=${m.maxJump.toFixed(4)} dc=${m.dc.toFixed(5)} settled=${m.rmsSettledDb.toFixed(1)} last10=${m.rmsLast10Db.toFixed(1)} onset=${m.replayOnsetAtS.toFixed(2)}/wait${m.waitingAtS.toFixed(1)}`,
          );
          // Every existing fatigue bound gates each render (level handled
          // per-setup below — replayed windows are dynamic by design, so
          // rule 1 reads as peaks plus a reported RMS).
          check(
            m.peakDb <= -3,
            `${tag}: peaks must stay at or below -3 dBFS, got ${m.peakDb.toFixed(1)} dBFS (fatigue rule 1)`,
          );
          check(
            m.bandShare2k5k <= 0.15,
            `${tag}: energy in 2-5 kHz must stay at or below 15 percent, got ${(m.bandShare2k5k * 100).toFixed(1)} percent (fatigue rule 2)`,
          );
          check(
            m.bandShare6kUp <= 0.05,
            `${tag}: high-frequency energy above 6 kHz must stay bounded, got ${(m.bandShare6kUp * 100).toFixed(1)} percent (fatigue rule 2 energy half)`,
          );
          check(
            m.maxAutocorr5s < 0.9,
            `${tag}: autocorrelation at lags of 5 s or more must stay below 0.9, got ${m.maxAutocorr5s.toFixed(3)} (fatigue rule 4)`,
          );
          check(
            m.maxJump <= 0.3,
            `${tag}: no sample-to-sample jump above 0.3 full scale, got ${m.maxJump.toFixed(3)} (fatigue rule 6)`,
          );
          check(
            Math.abs(m.dc) <= 0.01,
            `${tag}: DC offset must stay at or below 0.01, got ${m.dc.toFixed(5)} (fatigue rule 7)`,
          );
          // Struggle-is-not-loudness on the stuck setups: the replayed
          // trajectory's envelope must move with its lifecycle, not its
          // struggle arc — the late window (last 10 s) must sit at or
          // below the settled 5–15 s window plus the calibration band.
          // The band is calibrated per fixture family from the honest
          // first-green numbers (claude 1.5 dB, codex 4.0 dB); the
          // sandbox struggle-ramp gate is untouched.
          if (setup !== "three-lane-mix") {
            const bandDb = setup === "codex-stuck" ? 4.0 : 1.5;
            check(
              m.rmsLast10Db <= m.rmsSettledDb + bandDb,
              `${tag}: struggle must not raise loudness on the replayed stuck lane, last-10 s RMS ${m.rmsLast10Db.toFixed(1)} dBFS exceeds settled 5-15 s ${m.rmsSettledDb.toFixed(1)} dBFS by more than ${bandDb.toFixed(1)} dB`,
            );
          }
          expect(failures).toEqual([]);
        } finally {
          await replay.close();
        }
      });
    }
  }

  test("session-resume-keeps-quiet preserves the quiet audio drive", async ({ page }) => {
    const replay = await openReplayPage(page);
    try {
      const event = (kind: string, ts: number) => ({
        v: 1,
        agent: "codex",
        sessionId: "reopened-chat",
        id: `resume-${ts}`,
        kind,
        ts,
        receivedAt: ts,
      });
      const events = [event("turn.start", 0), event("compaction", 1000)];
      const resumed = [
        ...events,
        { ...event("session.start", 100_000), meta: { source: "resume" } },
      ];
      const drives = await page.evaluate(
        async ({ baseline, reopened }) => {
          const moduleUrl = "/qa-bundle.mjs";
          const { buildReplayDrive } = (await import(moduleUrl)) as {
            buildReplayDrive(
              setup: string,
              lanes: unknown[],
              options: Record<string, number>,
            ): { steps: { lanes: { lifecycle: string }[] }[] };
          };
          const drive = (input: unknown[]) =>
            buildReplayDrive(
              "codex-stuck",
              [
                {
                  laneId: 1,
                  sessionId: "reopened-chat",
                  agent: "codex",
                  events: input,
                },
              ],
              { windowStartS: 90, windowEndS: 115, calm: 0.6 },
            );
          return { baseline: drive(baseline).steps, reopened: drive(reopened).steps };
        },
        { baseline: events, reopened: resumed },
      );
      expect(drives.reopened).toEqual(drives.baseline);
      expect(
        drives.reopened.every((step) => step.lanes.every((lane) => lane.lifecycle === "quiet")),
      ).toBe(true);
      const metrics = await replay.renderReplay(
        "codex-stuck",
        0.6,
        [{ agent: "codex", events: resumed }],
        [1],
        90,
        115,
      );
      await writeReplayArtifacts("session-resume-keeps-quiet", { calm: 0.6 }, metrics);
      expect(metrics.resolveEvents).toBe(0);
      expect(metrics.peakDb).toBeLessThanOrEqual(-3);
      expect(metrics.maxJump).toBeLessThanOrEqual(0.3);
      expect(Math.abs(metrics.dc)).toBeLessThanOrEqual(0.01);
      console.log(
        `qa session-resume-keeps-quiet: identical quiet drives; peak=${metrics.peakDb.toFixed(1)} jump=${metrics.maxJump.toFixed(4)}`,
      );
    } finally {
      await replay.close();
    }
  });

  test("permission-completion-clears-wait releases waiting into the existing resolve ramp", async ({
    page,
  }) => {
    const replay = await openReplayPage(page);
    try {
      const base = { v: 1, agent: "codex", sessionId: "permission-completion" };
      const event = (kind: string, ts: number, lifecycle?: Record<string, string>) => ({
        ...base,
        id: `permission-completion-${ts}`,
        kind,
        ts,
        receivedAt: ts,
        ...(lifecycle ? { lifecycle } : {}),
      });
      const events = [
        event("turn.start", 0),
        event("permission.request", 2000, { reason: "permission", confidence: "observed" }),
        event("turn.end", 12000, { reason: "completed", confidence: "inferred" }),
      ];
      const metrics = await replay.renderReplay(
        "codex-stuck",
        0.6,
        [{ agent: "codex", events }],
        [0],
        0,
        35,
      );
      await writeReplayArtifacts("permission-completion-clears-wait", { calm: 0.6 }, metrics);
      const lifecycle = metrics;
      expect(lifecycle.completionAtS).toBe(12);
      expect(lifecycle.waitingAfterCompletion).toBe(false);
      expect(lifecycle.resolveEvents).toBe(1);
      expect(metrics.peakDb).toBeLessThanOrEqual(-3);
      expect(metrics.maxJump).toBeLessThanOrEqual(0.3);
      expect(Math.abs(metrics.dc)).toBeLessThanOrEqual(0.01);
      console.log(
        `qa permission-completion-clears-wait: completion=${lifecycle.completionAtS}s resolves=${lifecycle.resolveEvents} peak=${metrics.peakDb.toFixed(1)} jump=${metrics.maxJump.toFixed(4)}`,
      );
    } finally {
      await replay.close();
    }
  });

  test("replay three-lane-mix swept through Calm never clicks", async ({ page }) => {
    // Calm-sweep gate on the replayed routine mix: sweep 0 → 1 → 0 over
    // the three-lane window, max sample-to-sample jump ≤ 0.3 — all live
    // parameter moves ride the declared ramp classes, no new click
    // source from the feed path.
    const replay = await openReplayPage(page);
    const { failures, check } = collectFailures();
    try {
      const { fixtures, lanes } = replayLanes("three-lane-mix", replay.fixtureEvents);
      const sweep = await replay.renderReplay("three-lane-mix", 0, fixtures, lanes, 0, 90, [
        [45, 1],
        [90, 0],
      ]);
      const tag = "replay-three-lane-mix-calm-sweep";
      await writeReplayArtifacts(tag, {}, sweep);
      console.log(
        `qa ${tag}: rms=${sweep.rmsDb.toFixed(1)} peak=${sweep.peakDb.toFixed(1)} jump=${sweep.maxJump.toFixed(4)} dc=${sweep.dc.toFixed(5)}`,
      );
      check(
        sweep.maxJump <= 0.3,
        `${tag}: the replayed mix swept 0 → 1 → 0 must never click, got max jump ${sweep.maxJump.toFixed(3)} (fatigue rule 6)`,
      );
      check(
        sweep.peakDb <= -3,
        `${tag}: peaks must stay at or below -3 dBFS, got ${sweep.peakDb.toFixed(1)} dBFS (fatigue rule 1)`,
      );
      check(
        Math.abs(sweep.dc) <= 0.01,
        `${tag}: DC offset must stay at or below 0.01, got ${sweep.dc.toFixed(5)} (fatigue rule 7)`,
      );
      expect(failures).toEqual([]);
    } finally {
      await replay.close();
    }
  });

  test("replay waiting onset lands on waiting entry, observed and inferred alike", async ({
    page,
  }) => {
    // Waiting-holds onset gate on the replayed permission fixture: the
    // question onset must land inside waitingAtS → waitingAtS + 2 s
    // against the ducked floor — and the onset read must be identical
    // for observed and inferred waiting (the emission path reads
    // lifecycle only, never confidence).
    const replay = await openReplayPage(page);
    const { failures, check } = collectFailures();
    try {
      const permission = replay.fixtureEvents[2];
      if (permission === undefined) throw new Error("missing the permission-heavy fixture");
      const laneIds = [2] as const;
      for (const calm of REPLAY_CALM_LEVELS) {
        const m = await replay.renderReplay("three-lane-mix", calm, [permission], laneIds, 0, 30);
        const tag = `replay-waiting-calm${calm.toFixed(1)}`;
        console.log(
          `qa ${tag}: waitingAt=${m.waitingAtS.toFixed(1)} onset=${m.replayOnsetAtS.toFixed(2)} rms=${m.rmsDb.toFixed(1)} peak=${m.peakDb.toFixed(1)} jump=${m.maxJump.toFixed(4)}`,
        );
        check(
          m.waitingAtS >= 0,
          `${tag}: the replayed permission fixture must enter waiting, got waitingAt ${m.waitingAtS.toFixed(1)} s`,
        );
        if (m.waitingAtS >= 0) {
          // The question gesture's first D opens within ~1 transport
          // tick of the waiting step (the player reads the same stepped
          // frames the transport applies, so the gesture lands on the
          // step grid, up to 0.5 s early), and the flux locator reads
          // the first rise-edge at ~43 ms frame resolution. The gate
          // window (−1 s … +2 s around waiting entry) is the documented
          // window: the onset must separate from the ducked floor within
          // it, never drift to the tension-swell tail.
          check(
            m.replayOnsetAtS >= m.waitingAtS - 1 && m.replayOnsetAtS <= m.waitingAtS + 2,
            `${tag}: question onset must occur within -1/+2 s of waiting entry, got onset ${m.replayOnsetAtS.toFixed(2)} s vs waiting ${m.waitingAtS.toFixed(1)} s (owner p4-t03/p3-t13 when red)`,
          );
        }
        check(
          m.maxJump <= 0.3,
          `${tag}: no sample-to-sample jump above 0.3 full scale, got ${m.maxJump.toFixed(3)} (fatigue rule 6)`,
        );
        check(
          m.peakDb <= -3,
          `${tag}: peaks must stay at or below -3 dBFS, got ${m.peakDb.toFixed(1)} dBFS (fatigue rule 1)`,
        );
      }
      // Observed vs inferred parity: the same permission fixture with
      // its permission.request lines rewritten to inferred prompt-reason
      // turn.ends must produce the identical onset read. Confidence is
      // scrubbed before the drive — the model never sees it — so any
      // difference would be a confidence branch in the emission path.
      const scrubbed: FixtureEvents = {
        agent: permission.agent,
        events: (permission.events as Record<string, unknown>[]).map((event) =>
          event.kind === "permission.request"
            ? {
                ...event,
                kind: "turn.end",
                lifecycle: { reason: "permission", confidence: "inferred" },
              }
            : event,
        ),
      };
      for (const calm of REPLAY_CALM_LEVELS) {
        const observed = await replay.renderReplay(
          "three-lane-mix",
          calm,
          [permission],
          laneIds,
          0,
          30,
        );
        const inferred = await replay.renderReplay(
          "three-lane-mix",
          calm,
          [scrubbed],
          laneIds,
          0,
          30,
        );
        console.log(
          `qa replay-waiting-parity-calm${calm.toFixed(1)}: observed onset=${observed.replayOnsetAtS.toFixed(2)}/wait${observed.waitingAtS.toFixed(1)} inferred onset=${inferred.replayOnsetAtS.toFixed(2)}/wait${inferred.waitingAtS.toFixed(1)}`,
        );
        check(
          observed.replayOnsetAtS === inferred.replayOnsetAtS &&
            observed.waitingAtS === inferred.waitingAtS,
          `replay-waiting-parity-calm${calm.toFixed(1)}: observed and inferred waiting must read identically, got observed onset ${observed.replayOnsetAtS.toFixed(2)}/wait${observed.waitingAtS.toFixed(1)} vs inferred ${inferred.replayOnsetAtS.toFixed(2)}/wait${inferred.waitingAtS.toFixed(1)}`,
        );
      }
      // The ACP third is recorded as a gap, never faked: no ACP adapter
      // exists (Phase 1b deferred), so no ACP fixtures exist either.
      console.log(
        "qa replay-acp-gap: no ACP adapter or fixtures exist (Phase 1b deferred) — the three-lane mix sounds claude-code + codex only; recorded as a gap, never faked with a relabelled fixture",
      );
      expect(failures).toEqual([]);
    } finally {
      await replay.close();
    }
  });
});

test("audio qa piano-rolled-event-cues: all five cues, harmony, tails and pre-emption", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const qa = await openScenarioPage(page);
  try {
    const measured = await page.evaluate(async () => {
      const moduleUrl = "/qa-bundle.mjs",
        metricsUrl = "/qa-metrics.mjs";
      const { renderPianoCueAudition } = await import(moduleUrl);
      const metrics = await import(metricsUrl);
      const results = [];
      for (const mix of [false, true]) {
        const { left, right, sampleRate } = await renderPianoCueAudition(mix);
        const mono = Float32Array.from(left, (x: number, i: number) => (x + right[i]) / 2);
        const n = left.length;
        const bytes = new Uint8Array(44 + n * 8);
        const view = new DataView(bytes.buffer);
        const text = (at: number, s: string) => {
          for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
        };
        text(0, "RIFF");
        view.setUint32(4, bytes.length - 8, true);
        text(8, "WAVE");
        text(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 3, true);
        view.setUint16(22, 2, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 8, true);
        view.setUint16(32, 8, true);
        view.setUint16(34, 32, true);
        text(36, "data");
        view.setUint32(40, n * 8, true);
        for (let i = 0; i < n; i++) {
          view.setFloat32(44 + i * 8, left[i], true);
          view.setFloat32(48 + i * 8, right[i], true);
        }
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const slow = metrics.downsampleMean(mono, sampleRate, 100);
        let autocorr = 0;
        for (let lag = 500; lag <= 2650; lag += 100)
          autocorr = Math.max(autocorr, Math.abs(metrics.autocorrelationAtLag(slow, lag)));
        results.push({
          mix,
          autocorr,
          peak: Math.max(metrics.peakDb(left), metrics.peakDb(right)),
          jump: metrics.maxSampleJump(left, right),
          dc: metrics.dcOffset(mono),
          band2k: metrics.bandEnergyShare(mono, sampleRate, 2000, 5000),
          band6k: metrics.bandEnergyShare(mono, sampleRate, 6000, sampleRate / 2),
          cues: [4, 12, 20, 28, 36, 44.2].map((at) =>
            metrics.rmsDb(
              mono.subarray(Math.floor(at * sampleRate), Math.floor((at + 3) * sampleRate)),
            ),
          ),
          tail: metrics.rmsDb(mono.subarray(51 * sampleRate)),
          wavBase64: btoa(binary),
        });
      }
      return results;
    });
    for (const m of measured) {
      const tag = m.mix ? "piano-rolled-event-cues-mix" : "piano-rolled-event-cues-solo";
      await writeFile(join(ARTIFACT_DIR, `${tag}.wav`), Buffer.from(m.wavBase64, "base64"));
      await writeFile(
        join(ARTIFACT_DIR, `${tag}.json`),
        JSON.stringify({ ...m, wavBase64: undefined }),
      );
      console.log(`${tag}: ${JSON.stringify({ ...m, wavBase64: undefined })}`);
      expect(m.autocorr).toBeLessThan(0.9);
      expect(m.peak).toBeLessThanOrEqual(-3);
      expect(m.jump).toBeLessThanOrEqual(0.3);
      expect(Math.abs(m.dc)).toBeLessThanOrEqual(0.01);
      expect(m.band2k).toBeLessThanOrEqual(0.15);
      expect(m.band6k).toBeLessThanOrEqual(0.05);
      for (const cue of m.cues) expect(cue).toBeGreaterThan(-60);
      if (!m.mix) expect(m.tail).toBeLessThan(-60);
    }
  } finally {
    await qa.close();
  }
});
