// packages/core/src/classify/execKind.ts — maps a shell command to the
// execKind buckets of docs/EVENTS.md §Classification (test, build, lint, git,
// install, run, other) and, for exec-class tools, refines the category when
// the command is really one of the documented file or web operations
// (cat/head/less -> read, rg/find/ls -> search, `sed -i` and file redirects ->
// edit, curl/wget -> web). The head lists below mirror the doc exactly;
// unlisted binaries fall through to `other` rather than guessing. This module
// must not touch the agent-name table: it sees only command text.

import type { ExecKind, ToolCategory } from "./schema.js";
import { collapseWhitespace, pathBasename, splitTokens } from "./text.js";

const READ_COMMANDS = new Set(["cat", "head", "less"]);
const SEARCH_COMMANDS = new Set(["rg", "find", "ls"]);
const WEB_COMMANDS = new Set(["curl", "wget"]);

const TEST_BINARIES = new Set(["pytest", "jest", "vitest", "rspec", "phpunit"]);
const LINT_BINARIES = new Set(["eslint", "biome", "ruff", "clippy", "golangci-lint"]);
const INSTALL_MAINTENANCE = new Set(["brew", "apt", "apt-get"]);

export function execKindFromCommand(command: string): ExecKind {
  const tokens = splitTokens(command);
  if (tokens.length === 0) return "other";
  const bin = pathBasename(tokens[0] as string).toLowerCase();
  const sub = (tokens[1] ?? "").toLowerCase();
  const sub2 = (tokens[2] ?? "").toLowerCase();

  if (bin === "git" || bin === "gh") return "git";
  if (INSTALL_MAINTENANCE.has(bin)) return "install";
  if (bin === "pip" || bin === "pip3") return sub === "install" ? "install" : "other";
  if (bin === "npm" || bin === "pnpm" || bin === "yarn") {
    if (sub === "i" || sub === "add" || sub === "install") return "install";
    if (sub === "test") return "test";
    if (sub === "build") return "build";
    if (sub === "run") return sub2 === "build" ? "build" : sub2 === "test" ? "test" : "run";
    return "other";
  }
  switch (bin) {
    case "cargo":
      switch (sub) {
        case "test":
          return "test";
        case "build":
          return "build";
        case "run":
          return "run";
        case "add":
          return "install";
        case "clippy":
          return "lint";
        default:
          return "other";
      }
    case "go":
      switch (sub) {
        case "test":
          return "test";
        case "build":
          return "build";
        case "run":
          return "run";
        default:
          return "other";
      }
    case "make":
      return sub === "test" ? "test" : "build";
    case "mvn":
      return sub === "test" ? "test" : "other";
    case "gradle":
      return sub === "build" ? "build" : "other";
    case "dotnet":
      return sub === "test" ? "test" : "other";
    case "docker":
      return sub === "build" ? "build" : "other";
    default:
      break;
  }
  if (bin === "tsc") return "build";
  if (TEST_BINARIES.has(bin)) return "test";
  if (LINT_BINARIES.has(bin)) return "lint";
  if (bin === "prettier") return tokens.includes("--check") ? "lint" : "other";
  if (bin === "node" || bin === "python" || bin === "python3") return "run";
  return "other";
}

export type ShellCommandClassification = {
  category: ToolCategory;
  execKind?: ExecKind;
  target?: string;
};

// A token that begins a redirection: a bare `>` or `>>`, an attached form
// (`>file`, `>>file`), or a file-descriptor / both-streams form (`2>file`,
// `&>file`). The captured rest is the destination when it is glued to the
// operator. Alternation order puts longer operators first so `&>>file` and
// `2>>file` keep their whole operator instead of splitting at `&>`/`2>`.
const REDIRECT_START_TOKEN = /^(?:&>>|&>|\d+>>|\d+>|>>|>)(.*)$/;
// A dup redirect (`2>&1`, `>&2`) re-points a descriptor instead of writing a
// file; it is not an edit.
const DUP_DESTINATION = /^&[0-9]+$/;

export function classifyShellCommand(command: string): ShellCommandClassification {
  const tokens = splitTokens(command);
  if (tokens.length === 0) return { category: "exec", execKind: "other" };
  const bin = pathBasename(tokens[0] as string).toLowerCase();

  if (WEB_COMMANDS.has(bin)) return { category: "web", target: operandAfterHead(tokens) };
  const redirectTarget = firstWrittenFile(tokens);
  if (redirectTarget !== undefined) return { category: "edit", target: redirectTarget };
  if (bin === "sed" && tokens.includes("-i"))
    return { category: "edit", target: tokens[tokens.length - 1] };
  if (READ_COMMANDS.has(bin)) return { category: "read", target: operandAfterHead(tokens) };
  if (SEARCH_COMMANDS.has(bin)) return { category: "search", target: operandAfterHead(tokens) };
  return { category: "exec", execKind: execKindFromCommand(command) };
}

// The destination file of the first file-writing redirection, normalized. For
// an attached redirect (`echo hi >out.txt`) the destination is the text glued
// to the operator; for a bare one (`echo hi > out.txt`) it is the following
// tokens, matching how the previous detection built targets.
function firstWrittenFile(tokens: readonly string[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const match = REDIRECT_START_TOKEN.exec(token);
    if (match === null) continue;
    const attached = (match[1] ?? "").trim();
    if (attached.length === 0) return collapseWhitespace(tokens.slice(index + 1).join(" "));
    if (DUP_DESTINATION.test(attached)) continue;
    return collapseWhitespace(attached);
  }
  return undefined;
}

function operandAfterHead(tokens: readonly string[]): string {
  return collapseWhitespace(tokens.slice(1).join(" "));
}
