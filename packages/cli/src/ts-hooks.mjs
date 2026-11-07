// packages/cli/src/ts-hooks.mjs — the resolve hook that lets the `hearable`
// binary run the workspace's TypeScript sources directly under Node's type
// stripping (docs/ARCHITECTURE.md §packages/cli, task p1-t11 notes: flag
// parsing dependency-free, no build step). Node strips types but does not
// map `.js` import specifiers to the `.ts` files the repository writes
// (NodeNext convention, vitest/esbuild do the same mapping for tests). This
// hook rewrites only relative specifiers ending in `.js` when a sibling
// `.ts` file exists, so workspace source resolves and real JavaScript
// dependencies (`ws`, `zod`, node:* modules) are untouched. What it must not
// do: rewrite bare package specifiers, rewrite `.mjs`/`.cjs`, or touch
// anything that is not a sibling TypeScript file.

import { existsSync } from "node:fs";

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL !== undefined
  ) {
    const candidate = specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : null;
    if (candidate !== null && existsSync(new URL(candidate, context.parentURL))) {
      return { url: new URL(candidate, context.parentURL).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
