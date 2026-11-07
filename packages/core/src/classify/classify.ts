// packages/core/src/classify/classify.ts — the classifier's single entry
// point: a deterministic, I/O-free, clock-free mapping from an observed tool
// call to the category, exec kind and repetition fingerprint documented in
// docs/EVENTS.md §Classification and §Fingerprints. When `kind` (an ACP typed
// kind) is present it bypasses name classification entirely, exactly as the
// doc specifies; otherwise the (agent, toolName) fixture table plus the
// documented shell-command rules decide. Exec-class commands that only read,
// search, edit or fetch files refine to those categories (cat -> read,
// rg -> search, `sed -i`/redirects -> edit, curl/wget -> web); the fingerprint
// then follows the path rule of those categories instead of a command rule.
// Unknown tool names are `other`, never guessed. Core must not branch on an
// agent's name here — the table lookup owns agent granularity.

import {
  classifyShellCommand,
  execKindFromCommand,
  type ShellCommandClassification,
} from "./execKind.js";
import { truncatedSha256 } from "./hash.js";
import { normalizeCommand, normalizePathPattern, stripCwdPrefix } from "./normalize.js";
import type { ACPKind, Classification, ClassifyInput, ToolCategory } from "./schema.js";
import { findToolNameRow } from "./table.js";
import { splitTokens } from "./text.js";

// The ACP typed-kind mapping of docs/EVENTS.md §Classification, verbatim:
// read->read, search->search, edit|delete|move->edit, execute->exec (with
// execKind from the command when one is present), fetch->web, think|other->other.
// Kinds ACP defines but the doc does not map (switch_mode) never reach here:
// ACPKindSchema rejects them at the boundary.
const ACP_KIND_TO_CATEGORY: Record<ACPKind, ToolCategory> = {
  read: "read",
  search: "search",
  edit: "edit",
  delete: "edit",
  move: "edit",
  execute: "exec",
  fetch: "web",
  think: "other",
  other: "other",
};

export function classify(input: ClassifyInput): Classification {
  if (input.kind !== undefined) return classifyTyped(input);
  return classifyByName(input);
}

function classifyTyped(input: ClassifyInput): Classification {
  const category = ACP_KIND_TO_CATEGORY[input.kind as ACPKind];
  if (category === "exec") return execClassification(input, extractCommand(input));
  if (category === "read" || category === "search" || category === "edit") {
    return pathClassification(input, category, extractPathOrPattern(input.toolInput));
  }
  return identityClassification(input, category);
}

function classifyByName(input: ClassifyInput): Classification {
  const row = findToolNameRow(input.agent, input.toolName);
  let category: ToolCategory;
  if (row !== undefined) {
    category = row.category;
  } else {
    // Unrecorded names are `other`, and the docs/EVENTS.md §Classification
    // mcp__* rule resolves to that same bucket: MCP names classify as `other`
    // unless a fixture row says otherwise (which can only happen through a row,
    // never a name branch). No heuristic name is invented here.
    category = "other";
  }
  if (category === "exec") {
    const command = extractCommand(input);
    if (command === undefined) return execClassification(input, undefined);
    const shell: ShellCommandClassification = classifyShellCommand(command);
    if (shell.category === "exec") return execClassification(input, command);
    return pathClassification(input, shell.category, shell.target);
  }
  if (category === "read" || category === "search" || category === "edit") {
    return pathClassification(input, category, extractPathOrPattern(input.toolInput));
  }
  return identityClassification(input, category);
}

// edit/read/search fingerprint by normalized path or pattern (docs/EVENTS.md
// §Fingerprints); web/other carry no defined fingerprint rule in the docs, so
// they fingerprint by a stable tool identity instead (see ADR 0013).
function pathClassification(
  input: ClassifyInput,
  category: ToolCategory,
  value: string | undefined,
): Classification {
  const target = normalizePathPattern(value ?? "", input.cwd);
  return {
    category,
    fingerprint: truncatedSha256(`${category}:${target}`),
    ...(target.length > 0 ? { target } : {}),
  };
}

function execClassification(input: ClassifyInput, command: string | undefined): Classification {
  if (command === undefined) {
    // An exec-class tool whose command is unknown still needs a stable
    // fingerprint; the documented rule sha256(<execKind>:<normalizedCommand>)
    // with an empty command yields this for execKind `other`.
    return { category: "exec", execKind: "other", fingerprint: truncatedSha256("other:") };
  }
  const execKind = execKindFromCommand(command);
  return {
    category: "exec",
    execKind,
    fingerprint: truncatedSha256(`${execKind}:${normalizeCommand(command, input.cwd)}`),
    target: commandHead(command, input.cwd),
  };
}

function identityClassification(input: ClassifyInput, category: ToolCategory): Classification {
  const identity = input.toolName || input.title || category;
  return {
    category,
    fingerprint: truncatedSha256(`${category}:${identity}`),
    target: identity,
  };
}

function commandHead(command: string, cwd: string | undefined): string | undefined {
  const first = splitTokens(command)[0];
  return first !== undefined ? stripCwdPrefix(first, cwd) : undefined;
}

// The command text of a tool input: a bare string, a known command field, or
// the ACP title when nothing else looks like a command.
function extractCommand(input: ClassifyInput): string | undefined {
  return (
    extractStringField(input.toolInput, ["command", "commandString", "cmd"]) ??
    (input.title !== undefined && input.title.trim().length > 0 ? input.title : undefined)
  );
}

// The path or pattern a read/search/edit tool targets: a bare string (the
// shell case), the documented path-ish fields, or ACP tool locations.
function extractPathOrPattern(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["file_path", "path", "target", "pattern"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  const locations = record.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      if (location === null || typeof location !== "object") continue;
      const path = (location as Record<string, unknown>).path;
      if (typeof path === "string") return path;
    }
  }
  return undefined;
}

function extractStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}
