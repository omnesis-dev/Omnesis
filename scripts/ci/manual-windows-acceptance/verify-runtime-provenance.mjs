// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { taggedAssert } from "./preflight-state.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function pinned(path, sha) {
  taggedAssert("provenance-assert-001", assert.match, sha, /^[a-f0-9]{64}$/);
  const bytes = readFileSync(path);
  taggedAssert(
    "provenance-assert-002",
    assert.equal,
    digest(bytes),
    sha,
    "Provenance manifest hash mismatch",
  );
  return JSON.parse(bytes);
}
function inside(base, path) {
  const rel = relative(base, path);
  taggedAssert(
    "provenance-assert-003",
    assert.ok,
    rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep),
    "Path escaped expected package",
  );
  return rel.split(sep).join("/");
}
function sameObject(a, b) {
  const x = statSync(a, { bigint: true }),
    y = statSync(b, { bigint: true });
  return x.dev === y.dev && x.ino === y.ino;
}
function packageForEntry(entry, name) {
  let dir = dirname(realpathSync(entry));
  while (true) {
    const file = join(dir, "package.json");
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === name)
      return realpathSync(dir);
    const parent = dirname(dir);
    taggedAssert(
      "provenance-assert-004",
      assert.notEqual,
      parent,
      dir,
      "No matching package root for module",
    );
    dir = parent;
  }
}
function filesByPath(manifest) {
  const files = new Map();
  for (const item of manifest.files) {
    taggedAssert("provenance-assert-005", assert.match, item.sha256, /^[a-f0-9]{64}$/);
    taggedAssert(
      "provenance-assert-006",
      assert.ok,
      !files.has(item.path),
      "Duplicate manifest file",
    );
    files.set(item.path, item.sha256);
  }
  return files;
}
export function verifyRuntimeProvenance(config) {
  taggedAssert("provenance-assert-007", assert.match, config.sourceCommit, /^[a-f0-9]{40}$/);
  taggedAssert("provenance-assert-008", assert.ok, ["source", "compiled"].includes(config.mode));
  const source = pinned(config.sourceManifest, config.sourceManifestSha256);
  taggedAssert(
    "provenance-assert-009",
    assert.equal,
    source.sourceCommit,
    config.sourceCommit,
    "Source commit differs from pinned capture",
  );
  const sourceRoot = realpathSync(config.sourceRoot),
    sourceFiles = filesByPath(source);
  for (const [path, sha] of sourceFiles) {
    const file = join(sourceRoot, path);
    inside(sourceRoot, file);
    taggedAssert(
      "provenance-assert-010",
      assert.equal,
      digest(readFileSync(file)),
      sha,
      "Captured source file changed: " + path,
    );
  }
  const bootRel = inside(sourceRoot, realpathSync(config.sourceBootBudgetFile));
  taggedAssert(
    "provenance-assert-011",
    assert.ok,
    sourceFiles.has(bootRel),
    "Boot budget missing from source capture",
  );
  const runtimeRoot = realpathSync(config.runtimeRoot);
  let base = sourceRoot,
    files = sourceFiles;
  if (config.mode === "source")
    taggedAssert(
      "provenance-assert-012",
      assert.ok,
      sameObject(runtimeRoot, sourceRoot),
      "Source runtime root is another checkout",
    );
  else {
    const build = pinned(config.buildManifest, config.buildManifestSha256);
    taggedAssert(
      "provenance-assert-013",
      assert.equal,
      build.sourceCommit,
      config.sourceCommit,
      "Build belongs to another source commit",
    );
    base = realpathSync(join(runtimeRoot, "staging"));
    files = filesByPath(build);
    for (const [path, sha] of files) {
      const file = join(base, path);
      inside(base, file);
      taggedAssert(
        "provenance-assert-014",
        assert.equal,
        digest(readFileSync(file)),
        sha,
        "Staged file changed: " + path,
      );
    }
  }
  const expected = new Map();
  const versions = {};
  for (const binding of config.packageBindings) {
    const root = realpathSync(join(base, binding.relativeRoot));
    inside(base, root);
    const json = join(root, "package.json"),
      key = inside(base, json);
    taggedAssert(
      "provenance-assert-015",
      assert.ok,
      files.has(key),
      "Package metadata absent from pinned file inventory",
    );
    const metadata = JSON.parse(readFileSync(json, "utf8"));
    taggedAssert("provenance-assert-016", assert.equal, metadata.name, binding.name);
    expected.set(binding.name, root);
    versions[binding.name] = metadata.version;
    if (config.mode === "compiled") {
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const file = join(dir, entry.name);
          if (entry.isDirectory()) walk(file);
          else {
            taggedAssert(
              "provenance-assert-017",
              assert.ok,
              entry.isFile(),
              "Unexpected link/nonregular dist artifact",
            );
            taggedAssert(
              "provenance-assert-018",
              assert.ok,
              files.has(inside(base, file)),
              "Stale/orphan dist output: " + file,
            );
          }
        }
      };
      const dist = join(root, "dist");
      if (existsSync(dist)) walk(dist);
    }
  }
  for (const required of [
    "omnesis",
    "@omnesis/core",
    "@omnesis/gateway",
    "@omnesis/collector",
    "@omnesis/provider-obsidian",
  ])
    taggedAssert(
      "provenance-assert-019",
      assert.ok,
      expected.has(required),
      "Missing runtime package context: " + required,
    );
  const check = (entry, name) => {
    const real = realpathSync(entry),
      root = packageForEntry(real, name);
    taggedAssert(
      "provenance-assert-020",
      assert.ok,
      sameObject(root, expected.get(name)),
      "Module resolved into another checkout/stage: " + name,
    );
    const key = inside(base, real);
    taggedAssert(
      "provenance-assert-021",
      assert.ok,
      files.has(key),
      "Resolved entry absent from pinned inventory: " + key,
    );
    taggedAssert(
      "provenance-assert-022",
      assert.equal,
      digest(readFileSync(real)),
      files.get(key),
      "Resolved module hash differs from pinned source/build",
    );
    return { name, entry: real, root };
  };
  check(config.cliEntry, "omnesis");
  const resolved = [];
  for (const [name, root] of expected) {
    const require = createRequire(pathToFileURL(join(root, "package.json"))),
      metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const dependency of Object.keys({
      ...metadata.dependencies,
      ...metadata.optionalDependencies,
      ...metadata.peerDependencies,
    }).filter((name) => name.startsWith("@omnesis/"))) {
      taggedAssert(
        "provenance-assert-023",
        assert.ok,
        expected.has(dependency),
        "Missing captured workspace dependency: " + dependency,
      );
      resolved.push({
        from: name,
        ...check(require.resolve(dependency), dependency),
      });
    }
  }
  const rootRequire = createRequire(pathToFileURL(join(runtimeRoot, "package.json")));
  resolved.push({
    from: "runtime-root",
    ...check(rootRequire.resolve("@omnesis/core"), "@omnesis/core"),
  });
  return {
    sourceCommit: config.sourceCommit,
    mode: config.mode,
    sourceManifestSha256: config.sourceManifestSha256,
    buildManifestSha256: config.mode === "compiled" ? config.buildManifestSha256 : null,
    packageVersions: versions,
    resolved,
  };
}
