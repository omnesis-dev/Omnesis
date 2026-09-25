// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Phantom-dependency guard for the publishable graph.
 *
 * In the monorepo, a package can import anything hoisted into the root
 * node_modules without declaring it — and everything works until the package
 * is published standalone, where the undeclared import is ERR_MODULE_NOT_FOUND
 * at boot (the original instance: @omnesis/gateway using the root's
 * @hono/node-server). This test statically scans every publishable package's
 * runtime sources for bare-specifier imports and asserts each resolves to a
 * declared dependency.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { listPublishablePackages } from "./stage-packages.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Matches the specifier of static imports/re-exports, dynamic import() and
// require() calls. Anchored to line starts / call sites so prose in block
// comments doesn't produce false positives.
const IMPORT_RES = [
  /^\s*import\s+[^"'`]*?\s+from\s+["']([^"'.][^"']*)["']/gm,
  /^\s*import\s+["']([^"'.][^"']*)["']/gm,
  /^\s*export\s+[^"'`]*?\s+from\s+["']([^"'.][^"']*)["']/gm,
  /\bimport\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g,
];

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

// Dev-only paths that ship nothing (mirrors stage-packages' dist filter).
const DEV_ONLY = /(\.test\.|\.e2e\.|(^|\/)testing(\/|$)|(^|\/)e2e(\/|$))/;

function packageNameOf(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function* walkTsFiles(dir, base = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full);
    if (DEV_ONLY.test(rel)) continue;
    if (entry.isDirectory()) yield* walkTsFiles(full, base);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

describe("publishable packages declare every runtime import", () => {
  for (const { dir, pkg } of listPublishablePackages()) {
    test(pkg.name, () => {
      const declared = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
        pkg.name,
      ]);
      const srcDir = join(repoRoot, dir, "src");
      if (!existsSync(srcDir)) return;
      const undeclared = new Map();
      for (const file of walkTsFiles(srcDir)) {
        const text = readFileSync(file, "utf8");
        for (const re of IMPORT_RES) {
          re.lastIndex = 0;
          for (const m of text.matchAll(re)) {
            const name = packageNameOf(m[1]);
            if (BUILTINS.has(name) || declared.has(name)) continue;
            if (!undeclared.has(name)) undeclared.set(name, relative(repoRoot, file));
          }
        }
      }
      expect(
        [...undeclared.entries()].map(([dep, file]) => `${dep} (first seen in ${file})`),
        `${pkg.name} imports packages missing from its dependencies`,
      ).toEqual([]);
    });
  }
});

/**
 * A published package's workspace dependencies have to be published too.
 *
 * Declaring the dependency is not enough. `stage-packages.mjs` skips private
 * packages, while `transform-manifest.mjs` still rewrites every `@omnesis/*`
 * `"*"` range to the lockstep version — so a publishable package depending on
 * a private one ships a manifest naming a version that exists on no registry,
 * and the first `npm install` of it fails with E404. Nothing above catches
 * that: the import IS declared, and the declaration is exactly the problem.
 */
describe("publishable packages depend only on publishable packages", () => {
  const publishable = new Set(listPublishablePackages().map(({ pkg }) => pkg.name));

  for (const { pkg } of listPublishablePackages()) {
    test(pkg.name, () => {
      const workspaceDeps = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ].filter((dep) => dep.startsWith("@omnesis/"));

      expect(
        workspaceDeps.filter((dep) => !publishable.has(dep)),
        `${pkg.name} depends on workspace packages that never publish, so its published manifest would name a version no registry has`,
      ).toEqual([]);
    });
  }
});
