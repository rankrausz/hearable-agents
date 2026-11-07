// scripts/audio-qa.mjs — `pnpm audio:qa`: the automated audio QA through
// headless Chromium. What this is for: running the Playwright audio QA spec
// under its own config (Tone.Offline renders with the fixed seed, in-page
// analysis, numeric fatigue bounds, one test per scenario), keeping the full
// log, and exiting non-zero naming the scenario and rule on failure. Extra
// arguments pass straight to Playwright, so `pnpm audio:qa -- -g routine`
// renders one scenario and `pnpm audio:qa -- --workers=1` serialises. What it
// must not do: judge sound, build anything, or touch the relay timing suite.

import { spawn } from "node:child_process";

// pnpm forwards the `--` separator itself, and Playwright would read
// everything after it as file filters, so drop it.
const passthrough = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));

const child = spawn(
  "pnpm",
  ["exec", "playwright", "test", "--config", "e2e/audio-qa.config.ts", ...passthrough],
  { stdio: "inherit" },
);

child.on("exit", (code) => {
  if ((code ?? 0) !== 0) {
    console.error(
      "audio:qa failed. Read the failing scenario and rule above, then see docs/SOUND_DESIGN.md section Automated QA for what each bound means.",
    );
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`audio:qa could not start: ${error.message}.`);
  process.exit(1);
});
