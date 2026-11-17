// Stages the existing relay with a standalone macOS Node binary and its license.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const version = "22.23.5";
const checksums = {
  arm64: "e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d",
  x64: "c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function nodeArchive(distribution, checksum) {
  const cache = join(homedir(), "Library", "Caches", "hearable-build");
  const filename = join(cache, `${distribution}.tar.gz`);
  try {
    const bytes = readFileSync(filename);
    if (sha256(bytes) === checksum) return bytes;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const response = await fetch(`https://nodejs.org/dist/v${version}/${distribution}.tar.gz`, {
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`Could not download the hook runtime: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== checksum) throw new Error("The hook runtime checksum did not match.");

  mkdirSync(cache, { recursive: true });
  const temporary = `${filename}.${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
  return bytes;
}

export async function stageRelay(workspace, root, arch) {
  const checksum = checksums[arch];
  if (!checksum) throw new Error(`No macOS hook runtime for ${arch}.`);
  const distribution = `node-v${version}-darwin-${arch}`;
  const bytes = await nodeArchive(distribution, checksum);
  const directory = join(workspace, "hook-runtime");
  mkdirSync(directory);
  execFileSync(
    "/usr/bin/tar",
    [
      "-xzf",
      "-",
      "-C",
      directory,
      "--strip-components",
      "1",
      `${distribution}/bin/node`,
      `${distribution}/LICENSE`,
    ],
    { input: bytes },
  );
  copyFileSync(
    join(root, "packages/adapter-kit/src/relay/hearable-hook.mjs"),
    join(directory, "hearable-hook.mjs"),
  );
  writeFileSync(
    join(directory, "hearable-hook"),
    `#!/bin/sh
directory=\${0%/*}
unset NODE_OPTIONS NODE_PATH
export HEARABLE_MAC_BUNDLED_RELAY=1
exec "$directory/bin/node" "$directory/hearable-hook.mjs" "$@"
`,
    { mode: 0o755 },
  );
  return directory;
}
