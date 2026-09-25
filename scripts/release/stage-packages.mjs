#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Stage every publishable Omnesis package into `release/staging/<name>/`
 * with its publish-ready manifest (see transform-manifest.mjs), its built
 * `dist/` output, and any runtime assets (the gateway's `portal/`).
 *
 * Run `npm run build` (tsc --build) first — staging fails loudly on a
 * missing or stale-looking dist. Compiled test files are excluded from the
 * staged dist: they're dev-only and would drag vitest imports into the
 * artifact.
 *
 * Usage: node scripts/release/stage-packages.mjs [--out <dir>]
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformManifest } from "./transform-manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Packages that never publish. Currently none — even @omnesis/near-dupes
 * ships, because the gateway imports its algorithm at runtime. */
const EXCLUDED = new Set();

/** Per-package runtime assets to copy in addition to dist/. */
const EXTRA_ASSETS = {
  "@omnesis/agent-integration": [
    { from: "openclaw-entry.mjs", to: "openclaw-entry.mjs" },
    { from: "openclaw.plugin.json", to: "openclaw.plugin.json" },
    { from: "hermes/__init__.py", to: "hermes/__init__.py" },
    { from: "hermes/adapter.py", to: "hermes/adapter.py" },
    { from: "hermes/plugin.yaml", to: "hermes/plugin.yaml" },
  ],
  "@omnesis/gateway": [
    { from: "portal", to: "portal" },
    { from: "models-dev", to: "models-dev" },
    { from: "../../scripts/native-runtime-preflight.mjs", to: "native-runtime-preflight.mjs" },
  ],
};

export function runtimeAssetsFor(packageName) {
  return EXTRA_ASSETS[packageName] ?? [];
}

// Compiled test files and the e2e harness are dev-only: they import vitest,
// which a published package does not carry.
//
// A `testing/` directory is NOT excluded, because a package may deliberately
// publish one — `@omnesis/source-sdk/testing` ships the provider-contract
// checks a source author runs against their own sync, and a subpath the
// manifest declares must resolve for whoever installs it. The `.test.` rule
// still removes the vitest-importing files inside such a directory, and
// `assertExportsAreStaged` below is what stops a declared subpath from
// silently shipping empty.
const TEST_FILE = /(\.test\.|\.e2e\.|(^|\/)e2e(\/|$))/;

const COMPILED_SOURCE_SUFFIXES = [
  [".d.mts.map", [".mts"]],
  [".d.cts.map", [".cts"]],
  [".d.ts.map", [".ts", ".tsx"]],
  [".d.mts", [".mts"]],
  [".d.cts", [".cts"]],
  [".d.ts", [".ts", ".tsx"]],
  [".mjs.map", [".mts"]],
  [".cjs.map", [".cts"]],
  [".jsx.map", [".tsx"]],
  [".js.map", [".ts", ".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
  [".jsx", [".tsx"]],
  [".js", [".ts", ".tsx"]],
];

function walkFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...walkFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

function normalizeRuntimePermissions(directory) {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) normalizeRuntimePermissions(path);
    else if (entry.isFile()) chmodSync(path, 0o644);
  }
}

/**
 * Find compiled modules that no longer have a TypeScript source file.
 * Incremental `tsc --build` does not remove outputs for deleted sources, so
 * staging must reject them rather than silently publishing retired code.
 */
export function findOrphanedCompiledOutputs(srcDir, distDir) {
  const sourceRoot = join(srcDir, "src");
  return walkFiles(distDir)
    .filter((rel) => !TEST_FILE.test(rel))
    .filter((rel) => {
      const mapping = COMPILED_SOURCE_SUFFIXES.find(([suffix]) => rel.endsWith(suffix));
      if (!mapping) return false;
      const [suffix, sourceExtensions] = mapping;
      const stem = rel.slice(0, -suffix.length);
      return !sourceExtensions.some((extension) =>
        existsSync(join(sourceRoot, `${stem}${extension}`)),
      );
    })
    .sort();
}

export function listPublishablePackages() {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const dirs = [];
  for (const pattern of root.workspaces) {
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2);
      for (const entry of readdirSync(join(repoRoot, base), { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(join(base, entry.name));
      }
    } else {
      dirs.push(pattern);
    }
  }
  const out = [];
  for (const dir of dirs) {
    const manifestPath = join(repoRoot, dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (pkg.private || EXCLUDED.has(pkg.name)) continue;
    out.push({ dir, pkg });
  }
  return out;
}

/**
 * Every path the staged manifest points at must exist in the staged tree.
 *
 * The manifest and the file filter are decided independently — one from the
 * package's `exports`, the other from a path pattern — so a subpath can be
 * declared and its files excluded, and nothing downstream notices: `npm
 * publish` succeeds, and the failure surfaces only when someone installs the
 * package and imports the subpath. Checking the two against each other here is
 * what turns that into a build error.
 */
export function assertExportsAreStaged(pkgName, manifest, stageDir) {
  const targets = [];
  const collect = (value) => {
    if (typeof value === "string") {
      if (value.startsWith("./")) targets.push(value);
      return;
    }
    if (value && typeof value === "object") for (const v of Object.values(value)) collect(v);
  };
  collect(manifest.exports);
  collect(manifest.main);
  collect(manifest.bin);
  const missing = targets.filter((t) => !existsSync(join(stageDir, t)));
  if (missing.length > 0) {
    throw new Error(
      `${pkgName}: manifest points at ${missing.length} path(s) missing from the staged package: ` +
        `${[...new Set(missing)].join(", ")} — the file filter excluded a declared entry point`,
    );
  }
}

export function stagePackage({ dir, pkg }, outBase, opts = {}) {
  const srcDir = join(repoRoot, dir);
  const distDir = opts.distDir ?? join(srcDir, "dist");
  if (!existsSync(distDir)) {
    throw new Error(`${pkg.name}: no dist/ at ${distDir} — run \`npm run build\` first`);
  }
  const orphaned = findOrphanedCompiledOutputs(srcDir, distDir);
  if (orphaned.length > 0) {
    const preview = orphaned.slice(0, 10).join(", ");
    const remainder = orphaned.length > 10 ? ` (+${orphaned.length - 10} more)` : "";
    throw new Error(
      `${pkg.name}: orphaned compiled output in dist/: ${preview}${remainder} — clean dist/ and rebuild`,
    );
  }
  const stageDir = join(outBase, pkg.name.replace("@omnesis/", ""));
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  cpSync(distDir, join(stageDir, "dist"), {
    recursive: true,
    filter: (src) => !TEST_FILE.test(relative(distDir, src)),
  });

  for (const asset of runtimeAssetsFor(pkg.name)) {
    const assetSource = join(srcDir, asset.from);
    mkdirSync(dirname(join(stageDir, asset.to)), { recursive: true });
    cpSync(assetSource, join(stageDir, asset.to), {
      recursive: true,
      filter: (src) => !TEST_FILE.test(relative(assetSource, src)),
    });
  }

  const { distDir: _distDir, ...manifestOptions } = opts;
  const manifest = transformManifest(pkg, pkg.version, manifestOptions);
  writeFileSync(join(stageDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  cpSync(join(repoRoot, "LICENSE"), join(stageDir, "LICENSE"));
  assertExportsAreStaged(pkg.name, manifest, stageDir);
  normalizeRuntimePermissions(stageDir);
  return stageDir;
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const outFlag = process.argv.indexOf("--out");
  const outBase = outFlag !== -1 ? process.argv[outFlag + 1] : join(repoRoot, "release", "staging");
  const packages = listPublishablePackages();
  for (const entry of packages) {
    const staged = stagePackage(entry, outBase);
    console.log(`staged ${entry.pkg.name}@${entry.pkg.version} → ${relative(repoRoot, staged)}`);
  }
  console.log(`${packages.length} packages staged`);
}
