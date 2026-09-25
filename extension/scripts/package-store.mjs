// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  BUILD_INSTRUCTIONS_ANCHOR,
  assertArtifactReplacement,
  assertReleaseCheckout,
  assertReleaseVersions,
  assertStoreFiles,
} from "./store-package-contract.mjs";

/**
 * The corresponding-source notice shipped in the package. While the repository
 * is not yet public, a `tree/<commit>` link would resolve to nothing, so the
 * notice names the commit and offers the source through the support address,
 * and says nothing about a repository URL — a link that resolves to nothing is
 * worse than no link, and claiming the repository is published would be false. `sourceAvailability: "public"`
 * restores the direct links, which is the state to return to once the
 * repository is published.
 */
function sourceStatement(contract, sourceCommit) {
  if (contract.sourceAvailability === "on-request" && !contract.supportContact) {
    throw new Error("release contract must name a supportContact to offer source on request");
  }
  const header = `Omnesis Browser Capture\n\nLicense: GNU Affero General Public License v3.0 or later\nSource commit: ${sourceCommit}\n`;
  return contract.sourceAvailability === "on-request"
    ? `${header}Corresponding source: the complete source for this exact commit is provided on request from ${contract.supportContact}.\n`
    : `${header}Corresponding source: ${contract.sourceRepository}/tree/${sourceCommit}\nBuild instructions: ${contract.sourceRepository}/blob/${sourceCommit}/docs/releasing.md#${BUILD_INSTRUCTIONS_ANCHOR}\n`;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Both output directories can be redirected so a test run never replaces the
// unpacked build a developer has loaded in Chrome or leaves a ZIP behind.
const dist = process.env.OMNESIS_EXTENSION_DIST_DIR ?? join(root, "dist");
const artifacts = process.env.OMNESIS_EXTENSION_ARTIFACTS_DIR ?? join(root, "artifacts");
const manifest = JSON.parse(await readFile(join(root, "public", "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const contract = JSON.parse(await readFile(join(root, "release-contract.json"), "utf8"));
const releaseMode = process.argv.slice(2).includes("--release");
const repository = dirname(root);
let sourceCommit;

if (releaseMode) {
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: repository,
    encoding: "utf8",
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const expectedCommit = process.env.OMNESIS_EXTENSION_RELEASE_COMMIT;
  assertReleaseCheckout({ dirty, head, expectedCommit });
  sourceCommit = head;
}
sourceCommit ??= execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
assertReleaseVersions(manifest, packageJson, contract);

execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], {
  cwd: root,
  env: { ...process.env, OMNESIS_EXTENSION_STORE_BUILD: "1", OMNESIS_EXTENSION_DIST_DIR: dist },
  stdio: "inherit",
});

const files = await regularFiles(dist);
if (files.some((path) => path.endsWith(".map")))
  throw new Error("Store package must not contain source maps.");
const expectedFiles = [
  "THIRD_PARTY_NOTICES.txt",
  "background.js",
  "content.js",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  "options.html",
  "options.js",
  "popup.html",
  "popup.js",
  "ui.css",
];
assertStoreFiles(files, expectedFiles);
await mkdir(artifacts, { recursive: true });
const artifact = join(artifacts, `omnesis-browser-capture-${manifest.version}.zip`);
const fixedTime = new Date("2020-01-01T00:00:00.000Z");
const archive = new JSZip();
archive.file("LICENSE", await readFile(join(repository, "LICENSE")), {
  date: fixedTime,
  createFolders: false,
  unixPermissions: 0o100644,
});
archive.file("SOURCE.txt", sourceStatement(contract, sourceCommit), {
  date: fixedTime,
  createFolders: false,
  unixPermissions: 0o100644,
});
for (const path of files) {
  archive.file(path, await readFile(join(dist, path)), {
    date: fixedTime,
    createFolders: false,
    unixPermissions: 0o100644,
  });
}
const bytes = await archive.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
  platform: "UNIX",
  streamFiles: false,
});
let existing = null;
try {
  const artifactStat = await lstat(artifact);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
    throw new Error(`Store artifact path must be a regular file: ${artifact}`);
  }
  existing = await readFile(artifact);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
assertArtifactReplacement({ releaseMode, existing, bytes, artifact });
if (!releaseMode && existing) await rm(artifact, { force: true });
if (!releaseMode || !existing) await writeFile(artifact, bytes, { mode: 0o644, flag: "wx" });
await chmod(artifact, 0o644);
const digest = createHash("sha256").update(bytes).digest("hex");
process.stdout.write(`${artifact}\nsha256:${digest}\n`);

async function regularFiles(directory) {
  const found = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && (await stat(path)).isFile()) found.push(relative(directory, path));
      else
        throw new Error(`Store package contains unsupported entry: ${relative(directory, path)}`);
    }
  }
  await walk(directory);
  return found;
}
