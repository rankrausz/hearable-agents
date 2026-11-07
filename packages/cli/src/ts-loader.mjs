// packages/cli/src/ts-loader.mjs — preload entry for the `hearable` binary.
// What this is for: hooking Node's module resolution before the CLI imports
// the workspace's TypeScript packages, so `node --experimental-strip-types
// --import ./src/ts-loader.mjs src/bin.ts` runs straight from source with no
// build step. Uses `module.register` (available since Node 20.6, within the
// Node >= 22.12 floor) rather than the Node 23-only `registerHooks`, so the
// same invocation works across the supported range. What it must not do:
// implement any CLI behaviour — it only installs the resolve hook in
// `ts-hooks.mjs`.

import { register } from "node:module";

register(new URL("./ts-hooks.mjs", import.meta.url));
