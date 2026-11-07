// Bundles the shell and existing daemon for Electron; never installs hooks or runs the app.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
execFileSync(process.execPath, [join(dirname(require.resolve("electron")), "install.js")], {
  stdio: "inherit",
});

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = fileURLToPath(new URL("./dist/", import.meta.url));
execFileSync("pnpm", ["--filter", "@hearable/web", "exec", "vite", "build"], {
  cwd: root,
  stdio: "inherit",
});
await build({
  entryPoints: [new URL("./src/main/index.ts", import.meta.url).pathname],
  outfile: `${out}main/index.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron"],
  banner: {
    js: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);',
  },
});
await build({
  entryPoints: [new URL("./src/preload/index.ts", import.meta.url).pathname],
  outfile: `${out}preload/index.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
mkdirSync(out, { recursive: true });
writeFileSync(`${out}package.json`, JSON.stringify({ version: "0.1.0" }));
// Replacing renderer assets prevents retired developer bundles surviving incremental builds.
rmSync(`${out}web`, { recursive: true, force: true });
rmSync(`${out}assets`, { recursive: true, force: true });
cpSync(new URL("../web/dist", import.meta.url), `${out}web`, { recursive: true });
cpSync(new URL("./assets", import.meta.url), `${out}assets`, { recursive: true });
