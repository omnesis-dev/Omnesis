// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [checkoutArg, workArg, sha] = process.argv.slice(2);
assert.match(sha, /^[0-9a-f]{40}$/);
assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
const checkout = resolve(checkoutArg),
  work = resolve(workArg),
  runtime = join(work, "compiled"),
  staging = join(runtime, "staging");
const hash = (data) => createHash("sha256").update(data).digest("hex");
function git(args) {
  const result = spawnSync("git", args, {
    cwd: checkout,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, "Git provenance command failed");
  return result.stdout;
}
assert.equal(git(["rev-parse", "HEAD"]).trim(), sha);
assert.equal(
  git(["status", "--porcelain", "--untracked-files=no"]).trim(),
  "",
  "Tracked source changed",
);
assert.ok(!existsSync(work), "Preparation requires a fresh output directory");
mkdirSync(staging, { recursive: true });
const sourceFiles = [],
  sourceLinks = [];
for (const entry of git(["ls-files", "--stage", "-z"]).split("\0").filter(Boolean)) {
  const match = /^(\d+) ([a-f0-9]+) (\d)\t(.+)$/s.exec(entry);
  assert.ok(match);
  assert.equal(match[3], "0");
  const path = match[4];
  if (match[1] === "120000") {
    sourceLinks.push({ path, gitObject: match[2] });
    continue;
  }
  const bytes = readFileSync(join(checkout, path));
  sourceFiles.push({
    path,
    sha256: hash(bytes),
    bytes: bytes.length,
    gitObject: match[2],
  });
}
const sourceManifest = {
  sourceCommit: sha,
  files: sourceFiles,
  gitLinks: sourceLinks,
};
const sourceManifestPath = join(work, "source-input-manifest.json");
writeFileSync(sourceManifestPath, JSON.stringify(sourceManifest));
// The exact supported stage API copies assets and rejects stale compiler output.
const stage = await import(
  pathToFileURL(join(checkout, "scripts/release/stage-packages.mjs")).href
);
const entries = stage.listPublishablePackages();
const sourceBindings = [],
  compiledBindings = [];
for (const entry of entries) {
  const target = stage.stagePackage(entry, staging);
  compiledBindings.push({
    name: entry.pkg.name,
    relativeRoot: relative(staging, target).split(sep).join("/"),
  });
  sourceBindings.push({
    name: entry.pkg.name,
    relativeRoot: entry.dir.split(sep).join("/"),
  });
}
const buildFiles = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else {
      assert.ok(entry.isFile(), "Unexpected staged link");
      assert.ok(!/\.(node|dll|exe)$/i.test(file), "Stage must not copy native dependency binaries");
      const bytes = readFileSync(file);
      buildFiles.push({
        path: relative(staging, file).split(sep).join("/"),
        sha256: hash(bytes),
        bytes: bytes.length,
      });
    }
  }
}
walk(staging);
const buildManifestPath = join(work, "build-manifest.json");
writeFileSync(buildManifestPath, JSON.stringify({ sourceCommit: sha, files: buildFiles }));
writeFileSync(join(runtime, "package.json"), JSON.stringify({ private: true, type: "module" }));
const nativeModules = join(checkout, "node_modules"),
  bindings = join(runtime, "node_modules");
mkdirSync(bindings);
mkdirSync(join(bindings, "@omnesis"));
// Native dependencies remain at their actual Windows installation; workspace
// packages resolve exclusively through this independently staged namespace.
for (const entry of readdirSync(nativeModules, { withFileTypes: true })) {
  if (["@omnesis", "omnesis", ".bin"].includes(entry.name)) continue;
  const target = join(nativeModules, entry.name),
    link = join(bindings, entry.name);
  if (!statSync(target).isDirectory()) continue;
  symlinkSync(target, link, "junction");
}
for (const binding of compiledBindings) {
  const alias = join(bindings, ...binding.name.split("/"));
  mkdirSync(dirname(alias), { recursive: true });
  symlinkSync(join(staging, binding.relativeRoot), alias, "junction");
}
// Staged package resolution climbs to staging/node_modules before the wrapper
// root; both point to exactly the same independently constructed namespace.
symlinkSync(bindings, join(staging, "node_modules"), "junction");
const require = createRequire(pathToFileURL(join(checkout, "package.json")));
const common = {
  sourceCommit: sha,
  nodePath: process.execPath,
  depsRoot: checkout,
  sourceRoot: checkout,
  sourceManifest: sourceManifestPath,
  sourceManifestSha256: hash(readFileSync(sourceManifestPath)),
  sourceBootBudgetFile: join(checkout, "scripts/lib/gateway-boot-budget.json"),
  gracefulObservationMs: 35000,
  fixtureParent: join(work, "private-fixtures"),
};
for (const mode of ["source", "compiled"]) {
  const compiled = mode === "compiled";
  const cli = compiled
    ? join(staging, "omnesis/dist/index.js")
    : join(checkout, "packages/cli/src/index.ts");
  const config = {
    ...common,
    mode,
    runtimeRoot: compiled ? runtime : checkout,
    cliEntry: cli,
    nodeArgs: compiled ? [] : ["--import", pathToFileURL(require.resolve("tsx")).href],
    packageBindings: compiled ? compiledBindings : sourceBindings,
    publicSummaryFile: join(work, mode + "-summary.json"),
    ...(compiled
      ? {
          buildManifest: buildManifestPath,
          buildManifestSha256: hash(readFileSync(buildManifestPath)),
        }
      : {}),
  };
  writeFileSync(join(work, mode + "-config.json"), JSON.stringify(config));
}
writeFileSync(
  join(work, "provenance-summary.json"),
  JSON.stringify({
    sourceCommit: sha,
    sourceManifestSha256: common.sourceManifestSha256,
    buildManifestSha256: hash(readFileSync(buildManifestPath)),
    sourceFiles: sourceFiles.length,
    stagedFiles: buildFiles.length,
    packages: entries.length,
  }),
);
console.log(
  JSON.stringify({
    phase: "hosted-runtime-prepared",
    sourceCommit: sha,
    packages: entries.length,
    stagedFiles: buildFiles.length,
  }),
);
