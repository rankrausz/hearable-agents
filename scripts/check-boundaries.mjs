// scripts/check-boundaries.mjs — self-proving negative check for the package boundary
// lint rules. What this is for: `pnpm boundaries` temporarily injects each forbidden
// import or global into a scratch file inside the package under test (packages/core,
// packages/adapter-kit, and the packages/adapters/ subtree that adapter packages inherit),
// asserts that the same lint command `pnpm lint` runs fails with the boundary rule named
// and its purity message shown, then removes the scratch file and asserts that lint
// passes again. A boundary rule that silently stops matching fails this script loudly.
// What it must not do: touch real source files, or leave any file behind whether the
// check succeeds or fails. Every scratch path is registered before use and removed in a
// finally block.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const biomeBin = fileURLToPath(import.meta.resolve("@biomejs/biome/bin/biome"));

// Scratch source must itself be biome-clean so a formatting or assist diagnostic can
// never masquerade as (or mask) a boundary violation.
function tsSource(lines) {
  return [...lines, ""].join("\n");
}

// Each case injects one scratch module and expects lint to either reject it (with the
// rule name and message fragments the diagnostic must carry) or accept it (a positive
// control proving the rule is scoped, not a blanket ban).
const cases = [
  {
    name: "core rejects import of node:fs",
    file: "packages/core/src/boundary-scratch.ts",
    content: tsSource([
      'import { readFileSync } from "node:fs";',
      "",
      "export const boundaryScratch = readFileSync;",
    ]),
    expect: "rejected",
    mustMention: [
      "lint/style/noRestrictedImports",
      "packages/core is pure and deterministic",
      "node:fs",
    ],
  },
  {
    name: "core rejects any other node:* specifier (node:child_process)",
    file: "packages/core/src/boundary-scratch.ts",
    content: tsSource([
      'import { exec } from "node:child_process";',
      "",
      "export const boundaryScratch = exec;",
    ]),
    expect: "rejected",
    mustMention: [
      "lint/style/noRestrictedImports",
      "packages/core is pure and deterministic",
      "node:child_process",
    ],
  },
  {
    name: "core rejects bare import of the @hearable/adapter-kit workspace package",
    file: "packages/core/src/boundary-scratch.ts",
    content: tsSource([
      'import { ADAPTER_KIT_VERSION } from "@hearable/adapter-kit";',
      "",
      "export const boundaryScratch = ADAPTER_KIT_VERSION;",
    ]),
    expect: "rejected",
    mustMention: [
      "lint/style/noRestrictedImports",
      "imports nothing from the workspace",
      "@hearable/adapter-kit",
    ],
  },
  {
    name: "core rejects bare import of the @hearable/daemon workspace package",
    file: "packages/core/src/boundary-scratch.ts",
    content: tsSource([
      'import { startDaemon } from "@hearable/daemon";',
      "",
      "export const boundaryScratch = startDaemon;",
    ]),
    expect: "rejected",
    mustMention: [
      "lint/style/noRestrictedImports",
      "imports nothing from the workspace",
      "@hearable/daemon",
    ],
  },
  {
    name: "core rejects the window browser global",
    file: "packages/core/src/boundary-scratch.ts",
    content: tsSource(["export const boundaryScratch = window;"]),
    expect: "rejected",
    mustMention: ["lint/style/noRestrictedGlobals", "must not reference browser globals", "window"],
  },
  {
    name: "core rejects Date.now() and Math.random()",
    file: "packages/core/src/boundary-scratch.ts",
    content: tsSource([
      "export const boundaryScratchNow = Date.now();",
      "export const boundaryScratchRandom = Math.random();",
    ]),
    expect: "rejected",
    mustMention: [
      "lint/nursery/noJsRestrictedProperties",
      "never Date.now()",
      "never Math.random()",
    ],
  },
  {
    name: "adapter-kit rejects import of @hearable/daemon",
    file: "packages/adapter-kit/src/boundary-scratch.ts",
    content: tsSource([
      'import { startDaemon } from "@hearable/daemon";',
      "",
      "export const boundaryScratch = startDaemon;",
    ]),
    expect: "rejected",
    mustMention: [
      "lint/style/noRestrictedImports",
      "may only import @hearable/core",
      "@hearable/daemon",
    ],
  },
  {
    name: "adapter-kit accepts import of @hearable/core",
    file: "packages/adapter-kit/src/boundary-scratch.ts",
    content: tsSource([
      'import { SCHEMA_VERSION } from "@hearable/core";',
      "",
      "export const boundaryScratch = SCHEMA_VERSION;",
    ]),
    expect: "accepted",
    mustMention: [],
  },
  {
    name: "a package under packages/adapters/ inherits the rule and rejects @hearable/daemon",
    file: "packages/adapters/boundary-scratch/src/module.ts",
    content: tsSource([
      'import { startDaemon } from "@hearable/daemon";',
      "",
      "export const boundaryScratch = startDaemon;",
    ]),
    expect: "rejected",
    mustMention: [
      "lint/style/noRestrictedImports",
      "Adapters may only import @hearable/core and @hearable/adapter-kit",
      "@hearable/daemon",
    ],
  },
  {
    name: "a package under packages/adapters/ accepts @hearable/core and @hearable/adapter-kit",
    file: "packages/adapters/boundary-scratch/src/module.ts",
    content: tsSource([
      'import { ADAPTER_KIT_VERSION } from "@hearable/adapter-kit";',
      'import { SCHEMA_VERSION } from "@hearable/core";',
      "",
      "export const boundaryScratch = [SCHEMA_VERSION, ADAPTER_KIT_VERSION];",
    ]),
    expect: "accepted",
    mustMention: [],
  },
];

const scratchPaths = [];

function registerScratch(relativePath) {
  const absolutePath = join(rootDir, relativePath);
  if (existsSync(absolutePath)) {
    throw new Error(
      `Refusing to overwrite existing path while checking boundaries: ${relativePath}`,
    );
  }
  scratchPaths.push(absolutePath);
  return absolutePath;
}

function removeScratch(absolutePath) {
  rmSync(absolutePath, { recursive: true, force: true });
}

function cleanupScratch() {
  for (const absolutePath of scratchPaths.reverse()) {
    removeScratch(absolutePath);
  }
}

function runLint() {
  const result = spawnSync(biomeBin, ["check", "."], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`Could not run the biome linter: ${result.error.message}`);
  }
  return {
    exitCode: result.status,
    // Whitespace is collapsed so a line-wrapped diagnostic can not hide a fragment.
    output: `${result.stdout ?? ""} ${result.stderr ?? ""}`.replace(/\s+/g, " "),
  };
}

function writeScratch(testCase) {
  const absolutePath = registerScratch(testCase.file);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, testCase.content);
  return absolutePath;
}

function missingFragments(testCase, output) {
  return testCase.mustMention.filter((fragment) => !output.includes(fragment));
}

function excerpt(output) {
  return output.slice(0, 2000);
}

function runCase(testCase) {
  const absolutePath = writeScratch(testCase);
  try {
    if (testCase.expect === "rejected") {
      const failing = runLint();
      const unmentioned = missingFragments(testCase, failing.output);
      if (failing.exitCode === 0) {
        console.error(`${testCase.name}: FAILED — lint still passed`);
        console.error(excerpt(failing.output));
        return false;
      }
      if (unmentioned.length > 0) {
        console.error(
          `${testCase.name}: FAILED — lint failed but the diagnostic was missing: ${unmentioned.join(", ")}`,
        );
        console.error(excerpt(failing.output));
        return false;
      }
      removeScratch(absolutePath);
      const passing = runLint();
      if (passing.exitCode !== 0) {
        console.error(
          `${testCase.name}: FAILED — lint did not pass again after the scratch file was removed`,
        );
        console.error(excerpt(passing.output));
        return false;
      }
      return true;
    }
    const passing = runLint();
    if (passing.exitCode !== 0) {
      console.error(
        `${testCase.name}: FAILED — an allowed import was rejected by the boundary rules`,
      );
      console.error(excerpt(passing.output));
      return false;
    }
    return true;
  } finally {
    removeScratch(absolutePath);
  }
}

try {
  const passed = cases.map((testCase) => runCase(testCase));
  const failures = cases.filter((_, index) => !passed[index]);
  if (failures.length === 0) {
    console.log(`boundaries: ${cases.length}/${cases.length} cases passed`);
    process.exitCode = 0;
  } else {
    for (const failure of failures) {
      console.error(`boundaries: case failed — ${failure.name}`);
    }
    console.error(
      "The boundary lint rules are not enforcing what they should. See the diagnostics above.",
    );
    process.exitCode = 1;
  }
} finally {
  cleanupScratch();
}
