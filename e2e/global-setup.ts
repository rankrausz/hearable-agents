// e2e/global-setup.ts — hermetic web build for the Playwright smoke tests.
// What this is for: guaranteeing apps/web/dist/index.html exists before the
// two-lane specs run, so `pnpm test:e2e` passes on a clean clone. What it must
// not do: change test assertions, touch fixtures, or rebuild when the build is
// already present.
//
// Why a build here: root `pnpm typecheck` (`tsc --build`) emits compiler
// output into apps/web/dist, so the directory can exist without index.html,
// which only `vite build` writes. The stub feed serves that directory, so a
// missing index.html means 404s. Building only when index.html is absent keeps
// the step free on machines with a real build and honest on clean clones.
//
// Staleness trap (p3-t05 note): the check is existence-only, so a stale
// dist/index.html from an older source tree is served as-is and e2e specs
// silently assert against old code. If a spec fails oddly after editing
// apps/web, delete apps/web/dist and re-run — global setup rebuilds it.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function globalSetup(): Promise<void> {
  const e2eDir = dirname(fileURLToPath(import.meta.url));
  const webDir = join(e2eDir, "..", "apps", "web");
  if (existsSync(join(webDir, "dist", "index.html"))) {
    return;
  }
  const build = spawnSync("pnpm", ["--filter", "@hearable/web", "exec", "vite", "build"], {
    cwd: join(e2eDir, ".."),
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error(
      "The web console build is missing and the setup build failed. Run pnpm --filter @hearable/web exec vite build and try again.",
    );
  }
}

export default globalSetup;
