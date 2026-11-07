// Guards the public/private boundary and documentation links; never reads private notebook contents.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
  ),
].filter((file) => existsSync(resolve(root, file)));
const errors = [];
for (const file of files) {
  if (
    /^(?:\.agentic|\.claude|docs\/(?:prompts|listening-notes|reviews)|tools\/agentic-ui)\//.test(
      file,
    ) ||
    /(?:^|\/)sound-lab\//.test(file) ||
    /\.bundle$/.test(file) ||
    file === "apps/web/src/App.tsx" ||
    file.endsWith(".DS_Store")
  )
    errors.push(`Private artifact: ${file}`);
  if (!file.endsWith(".md")) continue;
  const text = readFileSync(resolve(root, file), "utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue;
    if (!existsSync(resolve(root, dirname(file), target)))
      errors.push(`Missing link: ${file} → ${target}`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`Public boundary and local links: ${files.length} files checked.`);

if (process.argv.includes("--built")) {
  const { readdirSync } = await import("node:fs");
  const assets = resolve(root, "apps/mac/dist/web/assets");
  if (!existsSync(assets)) throw new Error("Build the Mac renderer before checking its assets.");
  for (const file of readdirSync(assets)) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(resolve(assets, file), "utf8");
    if (/Sound lab|Start blind trial|Ensemble audition|Open console/.test(source)) {
      throw new Error(`Developer interface found in built runtime: ${file}`);
    }
  }
  console.log("Built Mac renderer contains no developer interface labels.");
}
