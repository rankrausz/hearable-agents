// Packages only built runtime assets; must not include the checkout, credentials or agent data.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

if (process.platform !== "darwin") throw new Error("Build Hearable.app on macOS.");
const root = fileURLToPath(new URL("../..", import.meta.url));
const stage = mkdtempSync(join(tmpdir(), "hearable-package-"));
const electron = JSON.parse(readFileSync(join(root, "node_modules/electron/package.json"), "utf8"));
try {
  cpSync(new URL("./dist", import.meta.url), join(stage, "dist"), {
    recursive: true,
    filter: (path) => !path.includes("/dist/types"),
  });
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify({
      name: "hearable",
      productName: "Hearable",
      version: "0.1.0",
      type: "module",
      main: "dist/main/index.mjs",
    }),
  );
  const paths = await packager({
    dir: stage,
    out: join(root, "apps/mac/release"),
    name: "Hearable",
    platform: "darwin",
    arch: process.arch,
    electronVersion: electron.version,
    appBundleId: "org.hearable.agents",
    appCategoryType: "public.app-category.developer-tools",
    icon: join(root, "apps/mac/assets/Hearable.icns"),
    asar: true,
    overwrite: true,
    prune: false,
    extendInfo: {
      LSUIElement: true,
      NSAppleEventsUsageDescription:
        "Hearable selects the terminal tab containing the agent you clicked.",
    },
  });
  for (const path of paths) console.log(`Built ${path}/Hearable.app`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
