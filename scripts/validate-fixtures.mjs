// scripts/validate-fixtures.mjs — task p1-t08 verification: every
// `<name>.annotations.json` matches the shape documented in
// fixtures/README.md, and every referenced segment lies within the session's
// duration. Run with: node scripts/validate-fixtures.mjs
// What this is for: the task's "A script that validates every annotation
// file against the documented shape" verification. What it must not do:
// change any fixture or annotation file.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const sessionsDir = join(root, "fixtures", "sessions");

const EVENT_KINDS = new Set(["turn_start", "turn_complete", "waiting"]);
const WAIT_REASONS = new Set(["permission", "question"]);

let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`FAIL: ${message}`);
}

function checkString(value, field, file) {
  if (typeof value !== "string" || value === "") {
    fail(`${file}: ${field} must be a non-empty string`);
    return false;
  }
  return true;
}

function checkSegment(segment, field, file, durationMs) {
  if (typeof segment !== "object" || segment === null) {
    fail(`${file}: ${field} entries must be objects`);
    return;
  }
  const { fromMs, toMs } = segment;
  if (!Number.isInteger(fromMs) || fromMs < 0) {
    fail(`${file}: ${field} fromMs must be a non-negative integer`);
  }
  if (!Number.isInteger(toMs) || toMs < 0) {
    fail(`${file}: ${field} toMs must be a non-negative integer`);
  }
  if (Number.isInteger(fromMs) && Number.isInteger(toMs) && toMs <= fromMs) {
    fail(`${file}: ${field} toMs must be after fromMs`);
  }
  if (Number.isInteger(fromMs) && fromMs > durationMs) {
    fail(`${file}: ${field} fromMs ${fromMs} lies after the session duration ${durationMs}`);
  }
  if (Number.isInteger(toMs) && toMs > durationMs) {
    fail(`${file}: ${field} toMs ${toMs} lies after the session duration ${durationMs}`);
  }
  if (!checkString(segment.note, `${field} note`, file)) {
    // counted inside
  }
}

function sessionDurationMs(jsonlPath) {
  const lines = readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    fail(`${jsonlPath}: recording holds no events`);
    return null;
  }
  const events = lines.slice(1).map((l) => JSON.parse(l));
  const t0 = events[0].ts;
  const t1 = events[events.length - 1].ts;
  return { durationMs: t1 - t0, events };
}

function validatePair(dir, name) {
  const jsonlPath = join(dir, `${name}.jsonl`);
  const annotationsPath = join(dir, `${name}.annotations.json`);
  let annotations;
  try {
    annotations = JSON.parse(readFileSync(annotationsPath, "utf8"));
  } catch (error) {
    fail(`${annotationsPath}: not valid JSON (${error.message})`);
    return null;
  }
  // The recording header must point at this pair's own annotations file, so
  // a renamed or copied recording cannot silently carry a stale pointer.
  let header;
  try {
    header = JSON.parse(
      readFileSync(jsonlPath, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")[0],
    );
  } catch (error) {
    fail(`${jsonlPath}: cannot read the recording header (${error.message})`);
    return null;
  }
  const wantAnnotations = `${name}.annotations.json`;
  if (header.annotations !== wantAnnotations) {
    fail(
      `${jsonlPath}: header annotations pointer "${header.annotations}" does not match the pair file "${wantAnnotations}"`,
    );
  }
  const measured = sessionDurationMs(jsonlPath);
  if (measured === null) {
    return null;
  }
  checkString(annotations.name, "name", annotationsPath);
  if (annotations.name !== name) {
    fail(`${annotationsPath}: name "${annotations.name}" does not match the file name "${name}"`);
  }
  checkString(annotations.agent, "agent", annotationsPath);
  const agentDir = dir.split("/").pop();
  if (annotations.agent !== agentDir) {
    fail(
      `${annotationsPath}: agent "${annotations.agent}" does not match the directory "${agentDir}"`,
    );
  }
  checkString(annotations.recordedAt, "recordedAt", annotationsPath);
  if (Number.isNaN(Date.parse(annotations.recordedAt))) {
    fail(`${annotationsPath}: recordedAt is not a parseable timestamp`);
  }
  checkString(annotations.summary, "summary", annotationsPath);
  if (typeof annotations.synthetic !== "boolean") {
    fail(`${annotationsPath}: synthetic must be a boolean`);
  }
  if (typeof annotations.deprecated !== "boolean") {
    fail(`${annotationsPath}: deprecated must be a boolean`);
  }
  if (!Number.isInteger(annotations.durationMs) || annotations.durationMs <= 0) {
    fail(`${annotationsPath}: durationMs must be a positive integer`);
  } else if (annotations.durationMs !== measured.durationMs) {
    fail(
      `${annotationsPath}: durationMs ${annotations.durationMs} does not match the measured session span ${measured.durationMs}`,
    );
  }
  for (const field of ["events", "struggleSegments", "quietSegments"]) {
    if (!Array.isArray(annotations[field])) {
      fail(`${annotationsPath}: ${field} must be an array`);
    }
  }
  if (Array.isArray(annotations.events)) {
    for (const event of annotations.events) {
      if (!Number.isInteger(event.atMs) || event.atMs < 0) {
        fail(`${annotationsPath}: events atMs must be a non-negative integer`);
      } else if (event.atMs > annotations.durationMs) {
        fail(
          `${annotationsPath}: events atMs ${event.atMs} lies after the session duration ${annotations.durationMs}`,
        );
      }
      if (!EVENT_KINDS.has(event.kind)) {
        fail(
          `${annotationsPath}: events kind "${event.kind}" is not turn_start, turn_complete or waiting`,
        );
      }
      if (event.kind === "waiting") {
        if (!WAIT_REASONS.has(event.reason)) {
          fail(`${annotationsPath}: waiting events need reason permission or question`);
        }
      }
    }
  }
  if (Array.isArray(annotations.struggleSegments)) {
    for (const segment of annotations.struggleSegments) {
      checkSegment(segment, "struggleSegments", annotationsPath, annotations.durationMs);
    }
  }
  if (Array.isArray(annotations.quietSegments)) {
    for (const segment of annotations.quietSegments) {
      checkSegment(segment, "quietSegments", annotationsPath, annotations.durationMs);
    }
  }
  // Every waiting/question event in the annotations must have a matching
  // recorded event kind nearby in the session.
  if (Array.isArray(annotations.events)) {
    const kinds = new Set(measured.events.map((e) => e.kind));
    for (const event of annotations.events) {
      if (
        event.kind === "waiting" &&
        event.reason === "permission" &&
        !kinds.has("permission.request")
      ) {
        fail(`${annotationsPath}: waiting/permission has no permission.request in the recording`);
      }
      if (
        event.kind === "waiting" &&
        event.reason === "question" &&
        !measured.events.some((e) => e.kind === "turn.end" && e.lifecycle?.reason === "question")
      ) {
        fail(`${annotationsPath}: waiting/question has no question turn.end in the recording`);
      }
      if (event.kind === "turn_complete" && !kinds.has("turn.end")) {
        fail(`${annotationsPath}: turn_complete has no turn.end in the recording`);
      }
      if (event.kind === "turn_start" && !kinds.has("turn.start")) {
        fail(`${annotationsPath}: turn_start has no turn.start in the recording`);
      }
    }
  }
  return { annotations, events: measured.events };
}

const validated = [];

const agents = readdirSync(sessionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (agents.length === 0) {
  fail("fixtures/sessions holds no per-agent directories");
}
for (const agent of agents) {
  const dir = join(sessionsDir, agent);
  const files = readdirSync(dir);
  const stems = new Map();
  for (const file of files) {
    const match = /^(.*)\.(jsonl|annotations\.json)$/.exec(file);
    if (!match) {
      fail(`${dir}/${file}: unexpected file (want <name>.jsonl plus <name>.annotations.json)`);
      continue;
    }
    const stem = match[1];
    if (!stems.has(stem)) {
      stems.set(stem, new Set());
    }
    stems.get(stem).add(file.endsWith(".jsonl") ? "jsonl" : "annotations");
  }
  for (const [stem, kinds] of stems) {
    if (!kinds.has("jsonl") || !kinds.has("annotations")) {
      fail(`${dir}/${stem}: missing pair (want <name>.jsonl plus <name>.annotations.json)`);
      continue;
    }
    const result = validatePair(dir, stem);
    if (result !== null) {
      validated.push({ agent, name: stem, ...result });
    }
  }
}

// The coverage minimums of fixtures/README.md, enforced so a missing or
// thinned fixture fails the script instead of slipping through. The Codex
// stuck slot was waived while the account usage limit blocked capture; the
// waiver closed when live Codex capture succeeded, so no WAIVERS remain.
const FIVE_MIN_MS = 5 * 60_000;

function hasKind(events, kind) {
  return events.some((e) => e.kind === kind);
}

function longestStruggleMs(annotations) {
  let longest = 0;
  for (const segment of annotations.struggleSegments ?? []) {
    if (Number.isInteger(segment.fromMs) && Number.isInteger(segment.toMs)) {
      longest = Math.max(longest, segment.toMs - segment.fromMs);
    }
  }
  return longest;
}

function waitingMs(annotations, reason) {
  return annotations.events.filter((e) => e.kind === "waiting" && e.reason === reason).length;
}

function checkMinimums(validated) {
  const byAgent = new Map();
  for (const entry of validated) {
    if (!byAgent.has(entry.agent)) {
      byAgent.set(entry.agent, []);
    }
    byAgent.get(entry.agent).push(entry);
  }
  const agentNames = (agent) => (byAgent.get(agent) ?? []).map((e) => e.name);
  const activeNames = (agent) =>
    (byAgent.get(agent) ?? []).filter((e) => !e.annotations.deprecated).map((e) => e.name);
  const deprecatedNames = (agent) =>
    (byAgent.get(agent) ?? []).filter((e) => e.annotations.deprecated).map((e) => e.name);

  // Exact distribution: five active Claude Code pairs, the deprecated merged
  // file on disk but marked, and three Codex pairs including the genuine
  // stuck session. Anything added, removed or un-deprecated fails.
  const wantActiveClaude = [
    "clean-feature",
    "stuck-single-session",
    "permission-heavy",
    "asks-question",
    "long-quiet",
  ];
  const gotActiveClaude = activeNames("claude-code").sort();
  if (JSON.stringify(gotActiveClaude) !== JSON.stringify([...wantActiveClaude].sort())) {
    fail(
      `minimums: active claude-code sessions are [${gotActiveClaude.join(", ")}], want exactly [${wantActiveClaude.join(", ")}]`,
    );
  }
  const gotDeprecatedClaude = deprecatedNames("claude-code");
  if (JSON.stringify(gotDeprecatedClaude) !== JSON.stringify(["stuck-fix-loop"])) {
    fail(
      `minimums: deprecated claude-code sessions are [${gotDeprecatedClaude.join(", ")}], want exactly [stuck-fix-loop]`,
    );
  }
  const merged = validated.find((e) => e.agent === "claude-code" && e.name === "stuck-fix-loop");
  if (merged && !merged.annotations.summary.includes("stuck-single-session.jsonl")) {
    fail(
      "minimums: claude-code/stuck-fix-loop is deprecated without a replacement pointer to stuck-single-session.jsonl",
    );
  }
  const gotCodex = agentNames("codex").sort();
  if (
    JSON.stringify(gotCodex) !==
    JSON.stringify(["clean-feature", "permission-heavy", "stuck-single-session"])
  ) {
    fail(
      `minimums: codex sessions are [${gotCodex.join(", ")}], want exactly [clean-feature, permission-heavy, stuck-single-session]`,
    );
  }

  // Each agent has a clean-feature that completes without incident.
  for (const agent of ["claude-code", "codex"]) {
    const entry = validated.find((e) => e.agent === agent && e.name === "clean-feature");
    if (entry && !hasKind(entry.events, "turn.end")) {
      fail(`minimums: ${agent}/clean-feature has no turn.end`);
    }
    if (entry && (entry.annotations.struggleSegments ?? []).length > 0) {
      fail(`minimums: ${agent}/clean-feature should complete without incident (no struggle)`);
    }
  }

  // Stuck minimum: an ACTIVE session per agent with a struggle segment of at
  // least 5 minutes, then recovery or a question. The deprecated merged
  // Claude file does not count.
  const claudeStuck = validated.filter(
    (e) =>
      e.agent === "claude-code" &&
      !e.annotations.deprecated &&
      longestStruggleMs(e.annotations) >= FIVE_MIN_MS,
  );
  if (!claudeStuck.some((e) => e.name === "stuck-single-session")) {
    fail(
      "minimums: claude-code/stuck-single-session must carry a struggle segment of at least 5 minutes",
    );
  } else {
    console.log("minimums: claude-code stuck evidence in stuck-single-session");
  }
  const codexStuck = validated.filter(
    (e) =>
      e.agent === "codex" &&
      !e.annotations.deprecated &&
      longestStruggleMs(e.annotations) >= FIVE_MIN_MS,
  );
  if (!codexStuck.some((e) => e.name === "stuck-single-session")) {
    fail(
      "minimums: codex/stuck-single-session must carry a struggle segment of at least 5 minutes",
    );
  } else {
    console.log("minimums: codex stuck evidence in stuck-single-session");
  }
  if (codexStuck.some((e) => e.annotations.synthetic)) {
    fail("minimums: codex stuck evidence must be genuine, never synthetic");
  }
  // Permission coverage: several permission prompts, one left waiting > 2 min.
  for (const agent of ["claude-code", "codex"]) {
    const entry = validated.find((e) => e.agent === agent && e.name === "permission-heavy");
    if (!entry) {
      continue;
    }
    const prompts = entry.events.filter((e) => e.kind === "permission.request").length;
    if (prompts < 3) {
      fail(
        `minimums: ${agent}/permission-heavy holds ${prompts} permission prompts, want at least 3`,
      );
    }
    const gaps = [];
    for (let i = 0; i < entry.events.length; i += 1) {
      const event = entry.events[i];
      if (event.kind !== "permission.request") {
        continue;
      }
      const next = entry.events.slice(i + 1).find((e) => e.kind !== "permission.request");
      if (next) {
        gaps.push(next.ts - event.ts);
      }
    }
    if (!gaps.some((gap) => gap > 2 * 60_000)) {
      fail(`minimums: ${agent}/permission-heavy leaves no prompt waiting longer than 2 minutes`);
    }
  }

  // Claude Code asks-question and long-quiet (with a compaction).
  const asks = validated.find((e) => e.agent === "claude-code" && e.name === "asks-question");
  if (asks && waitingMs(asks.annotations, "question") === 0) {
    fail("minimums: claude-code/asks-question records no question wait");
  }
  const quiet = validated.find((e) => e.agent === "claude-code" && e.name === "long-quiet");
  if (quiet && !hasKind(quiet.events, "compaction")) {
    fail("minimums: claude-code/long-quiet holds no compaction event");
  }
}

if (failures > 0) {
  console.error(`${failures} fixture check(s) failed.`);
  process.exit(1);
}
checkMinimums(validated);
if (failures > 0) {
  console.error(`${failures} fixture check(s) failed.`);
  process.exit(1);
}
console.log("All fixture sessions and annotations are valid.");
