// Packages only built runtime assets; must not include the checkout, credentials or agent data.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { stageRelay } from "./package-relay.mjs";

if (process.platform !== "darwin") throw new Error("Build Hearable.app on macOS.");
const root = fileURLToPath(new URL("../..", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "hearable-package-"));
const stage = join(workspace, "app");
const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const electron = JSON.parse(readFileSync(join(root, "node_modules/electron/package.json"), "utf8"));
const checksums = JSON.parse(
  readFileSync(join(root, "node_modules/electron/checksums.json"), "utf8"),
);
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
      version: manifest.version,
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
    download: { checksums },
    appBundleId: "org.hearable.agents",
    appCategoryType: "public.app-category.developer-tools",
    icon: join(root, "apps/mac/assets/Hearable.icns"),
    asar: true,
    overwrite: true,
    prune: false,
    extraResource: [await stageRelay(workspace, root, process.arch)],
    extendInfo: {
      LSUIElement: true,
      NSAppleEventsUsageDescription:
        "Hearable selects the terminal tab containing the agent you clicked.",
    },
  });
  for (const path of paths) console.log(`Built ${path}/Hearable.app`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
