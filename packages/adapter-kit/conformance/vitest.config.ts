// packages/adapter-kit/conformance/vitest.config.ts — the configuration
// behind `pnpm conformance`: it runs the kit's self-check
// (conformance/selfcheck.ts), which registers the conformance runner against
// the kit's own test doubles with no suites and must exit 0 while printing
// every uncovered category, plus both Phase 1 adapters' conformance
// registrations (packages/adapters/*/test/conformance.test.ts), so one root
// command proves every category covered and green for claude-code and codex.
// The self-check file is not named *.test.ts on purpose, so the ordinary
// unit-test runs never pick it up; only this config includes it. The adapter
// registrations are included by explicit path so `pnpm conformance` stays the
// single aggregate the p1-t12 wiring task owns. The verbose reporter is part
// of the contract: the default reporter hides passing tests and their console
// output, which would hide exactly the NOT COVERED reports this run exists to
// print.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: [
      "conformance/selfcheck.ts",
      "../adapters/claude-code/test/conformance.test.ts",
      "../adapters/codex/test/conformance.test.ts",
    ],
    reporters: ["verbose"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  },
});
