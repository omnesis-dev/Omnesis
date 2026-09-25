#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Stage one or more compiled workspace roots and their transitive local
 * dependencies.
 *
 * The output preserves repository-relative workspace paths so npm's workspace
 * symlinks continue to resolve after only the staged tree and production
 * node_modules are copied into a runtime image.
 *
 * Usage:
 *   node scripts/runtime/stage-runtime.mjs [--package <name>]... [--build] [--out <dir>]
 *
 * `--package` may be repeated; the staged closure is the union over every
 * requested root. With no `--package`, the root is `@omnesis/gateway`.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPublishablePackages, stagePackage } from "../release/stage-packages.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DEFAULT_RUNTIME_ROOTS = ["@omnesis/gateway"];

export function localRuntimeClosure(roots, packages = listPublishablePackages()) {
  const requested = Array.isArray(roots) ? roots : [roots];
  if (requested.length === 0) throw new Error("at least one runtime root is required");
  const byName = new Map(packages.map((entry) => [entry.pkg.name, entry]));
  const closure = new Map();
  const visit = (name) => {
    if (closure.has(name)) return;
    const entry = byName.get(name);
    if (!entry) throw new Error(`unknown local runtime package: ${name}`);
    closure.set(name, entry);
    const manifests = [
      entry.pkg.dependencies,
      entry.pkg.optionalDependencies,
      entry.pkg.peerDependencies,
    ];
    for (const dependencies of manifests) {
      for (const dependency of Object.keys(dependencies ?? {})) {
        if (byName.has(dependency)) visit(dependency);
      }
    }
  };
  for (const root of requested) visit(root);
  return [...closure.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

export function compileRuntimeClosure(
  entries = localRuntimeClosure(DEFAULT_RUNTIME_ROOTS),
  runCompiler = execFileSync,
) {
  const compiler = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const projects = entries.map((entry) => join(repoRoot, entry.dir));
  runCompiler(process.execPath, [compiler, "--build", ...projects], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return entries;
}

export function stageRuntime(outDir, entries = localRuntimeClosure(DEFAULT_RUNTIME_ROOTS)) {
  mkdirSync(dirname(outDir), { recursive: true });
  try {
    // Claim the final path atomically. A preflight existsSync check would let
    // two concurrent invocations both believe they own the same directory.
    mkdirSync(outDir);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`runtime staging output must not already exist: ${outDir}`, { cause: error });
    }
    throw error;
  }
  const scratch = join(outDir, ".package-stage");
  mkdirSync(scratch);
  try {
    for (const entry of entries) {
      const staged = stagePackage(entry, scratch);
      const destination = join(outDir, entry.dir);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(staged, destination, { recursive: true });
    }
    rmSync(scratch, { recursive: true, force: true });

    const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    return {
      // Every @omnesis package carries the one lockstep product version, so any
      // staged package reports it regardless of which roots were requested.
      productVersion: entries[0]?.pkg.version,
      packages: entries.map((entry) => ({ name: entry.pkg.name, path: entry.dir })),
      node: rootManifest.engines?.node,
    };
  } catch (error) {
    // This invocation created outDir, so it exclusively owns cleanup. Existing
    // paths are rejected above and are never recursively removed.
    rmSync(outDir, { recursive: true, force: true });
    throw error;
  }
}

/** Collect every value of a repeatable `--flag <value>` argument. */
function flagValues(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.push(value);
  }
  return values;
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const outDirs = flagValues(process.argv, "--out");
  if (outDirs.length > 1) throw new Error("--out may be given only once");
  const outDir = outDirs[0] ?? join(repoRoot, "release", "gateway-runtime");
  const roots = flagValues(process.argv, "--package");
  const entries = localRuntimeClosure(roots.length > 0 ? roots : DEFAULT_RUNTIME_ROOTS);
  if (process.argv.includes("--build")) compileRuntimeClosure(entries);
  const manifest = stageRuntime(outDir, entries);
  console.log(JSON.stringify(manifest, null, 2));
}
