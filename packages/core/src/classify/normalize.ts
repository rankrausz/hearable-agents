// packages/core/src/classify/normalize.ts — the normalizers behind
// docs/EVENTS.md §Fingerprints: paths and patterns made relative to cwd, and
// commands stripped of their environment so the same action repeated with
// different cosmetics fingerprints identically. Whitespace runs collapse,
// absolute path prefixes equal to cwd are removed, and a small set of volatile
// flags (colour control and inline timestamps) is dropped. Normalization must
// stay conservative: two genuinely different paths or commands must never
// collapse onto each other, so the volatile-flag list is exactly the documented
// `--no-color` family plus timestamped flags, nothing broader.

import { collapseWhitespace, splitTokens } from "./text.js";

const COLOR_DISABLE_FLAG = /^--no-colou?r(s)?$/i;
const COLOR_NEVER_FLAG = /^--colou?r=(never|false|off|0)$/i;
const TIMESTAMP_FLAG = /^--(ts|timestamp|time)=/i;

export function stripCwdPrefix(token: string, cwd: string | undefined): string {
  if (cwd === undefined) return token;
  const root = cwd.replace(/\/+$/, "");
  if (token === root) return ".";
  if (token.startsWith(`${root}/`)) return token.slice(root.length + 1);
  return token;
}

export function normalizePathPattern(text: string, cwd: string | undefined): string {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length === 0) return "";
  return splitTokens(collapsed)
    .map((token) => stripCwdPrefix(token, cwd))
    .join(" ")
    .replace(/^(?:\.\/)+/, "");
}

export function isVolatileFlag(token: string): boolean {
  return (
    COLOR_DISABLE_FLAG.test(token) || COLOR_NEVER_FLAG.test(token) || TIMESTAMP_FLAG.test(token)
  );
}

export function normalizeCommand(command: string, cwd: string | undefined): string {
  const kept: string[] = [];
  for (const token of splitTokens(command)) {
    const stripped = stripCwdPrefix(token, cwd);
    if (isVolatileFlag(stripped)) continue;
    kept.push(stripped);
  }
  return kept.join(" ");
}
