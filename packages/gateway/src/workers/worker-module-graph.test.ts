// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Every worker thread is its own V8 isolate and loads its own copy of each
// module its entry reaches, so a large library that a worker reaches through a
// static import costs every instance of that worker its memory, used or not.
// These libraries are loaded on first use instead (`lazyRequire` in
// `@omnesis/core`, or a dynamic `import()`), and this test fails if any worker
// entry reaches one of them statically again. It reads the import graph from
// the source, so it covers every code path, not only the ones a test runs.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const GATEWAY_SRC = join(REPO, "packages/gateway/src");

/** Libraries no worker entry may load at import time, with what they are. */
const DEFERRED_LIBRARIES: Record<string, string> = {
  "@microsoft/recognizers-text-date-time": "the date recognizer's models",
  tinyld: "the language detector's profiles",
  "libphonenumber-js": "the phone-number metadata",
  turndown: "the HTML-to-Markdown converter and its DOM",
  "bonjour-service": "the mDNS browser",
  "@anthropic-ai/sdk": "the Anthropic SDK",
};

interface WorkspacePackage {
  dir: string;
  manifest: { name: string; main?: string; exports?: unknown };
}

function workspacePackages(): Map<string, WorkspacePackage> {
  const out = new Map<string, WorkspacePackage>();
  for (const base of ["packages", "packages/providers"]) {
    for (const name of readdirSync(join(REPO, base))) {
      const file = join(REPO, base, name, "package.json");
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8")) as WorkspacePackage["manifest"];
      out.set(manifest.name, { dir: join(REPO, base, name), manifest });
    }
  }
  return out;
}

const PACKAGES = workspacePackages();
const BUILTINS = new Set(builtinModules);

type Resolved = { file: string } | { library: string } | null;

function resolveFile(path: string): string | null {
  for (const candidate of [
    path.replace(/\.js$/, ".ts"),
    path,
    `${path}.ts`,
    join(path, "index.ts"),
  ]) {
    if (existsSync(candidate) && !candidate.endsWith("/") && /\.(m?[jt]s)$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveSpecifier(specifier: string, from: string): Resolved {
  if (specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0]!)) return null;
  if (specifier.startsWith(".")) {
    const file = resolveFile(resolve(dirname(from), specifier));
    if (!file)
      throw new Error(
        `${relative(REPO, from).split(sep).join("/")} imports ${specifier}, which does not resolve`,
      );
    return { file };
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const workspace = PACKAGES.get(name);
  if (!workspace) return { library: name };
  const subpath = `.${specifier.slice(name.length)}`;
  const target = exportTarget(workspace.manifest, subpath);
  if (!target) throw new Error(`${specifier} is not exported by ${name}`);
  return { file: resolve(workspace.dir, target) };
}

type ExportValue = string | { import?: ExportValue; default?: ExportValue } | null | undefined;

/** The file a workspace package exports at `subpath`, through condition objects and `*` patterns. */
function exportTarget(manifest: WorkspacePackage["manifest"], subpath: string): string | undefined {
  const pick = (value: ExportValue): string | undefined =>
    typeof value === "string" ? value : value ? pick(value.import ?? value.default) : undefined;
  const exportsMap = manifest.exports as ExportValue | Record<string, ExportValue>;
  if (typeof exportsMap === "string") return subpath === "." ? exportsMap : undefined;
  if (!exportsMap) return subpath === "." ? manifest.main : undefined;
  const map = exportsMap as Record<string, ExportValue>;
  if (subpath in map) return pick(map[subpath]);
  for (const [pattern, value] of Object.entries(map)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const [prefix, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      const match = subpath.slice(prefix.length, subpath.length - suffix.length);
      return pick(value)?.replaceAll("*", match);
    }
  }
  return subpath === "." ? manifest.main : undefined;
}

/** The module specifiers a file imports for their values; type-only imports are erased. */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const out: string[] = [];
  const onlyTypes = (elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>) =>
    elements.length > 0 && elements.every((element) => element.isTypeOnly);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      if (
        clause &&
        !clause.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        onlyTypes(bindings.elements)
      ) {
        continue;
      }
      out.push((statement.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause) && onlyTypes(clause.elements)) continue;
      out.push((statement.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return out;
}

/** Every library an entry reaches through static value imports, with the path that reaches it. */
function librariesReached(entry: string, visited?: Set<string>): Map<string, string[]> {
  const parent = new Map<string, string | null>([[entry, null]]);
  const libraries = new Map<string, string>();
  const queue = [entry];
  for (let file = queue.shift(); file; file = queue.shift()) {
    visited?.add(file);
    for (const specifier of valueImports(file)) {
      const resolved = resolveSpecifier(specifier, file);
      if (!resolved) continue;
      if ("library" in resolved) {
        if (!libraries.has(resolved.library)) libraries.set(resolved.library, file);
      } else if (!parent.has(resolved.file)) {
        parent.set(resolved.file, file);
        queue.push(resolved.file);
      }
    }
  }
  const paths = new Map<string, string[]>();
  for (const [library, importer] of libraries) {
    const chain: string[] = [];
    for (let file: string | null | undefined = importer; file; file = parent.get(file)) {
      chain.unshift(relative(REPO, file).split(sep).join("/"));
    }
    paths.set(library, chain);
  }
  return paths;
}

/**
 * Each worker thread and child process the packages start from their own
 * sources: the first argument of every `resolveWorkerEntry` and
 * `resolveSubprocessEntry` call.
 */
function workerEntries(): string[] {
  const entries = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(
          /resolve(?:Worker|Subprocess)Entry\(\s*["'`]([^"'`]+\.ts)["'`]/g,
        )) {
          entries.add(resolve(dirname(path), match[1]!));
        }
      }
    }
  };
  for (const { dir } of PACKAGES.values()) {
    if (existsSync(join(dir, "src"))) walk(join(dir, "src"));
  }
  return [...entries].sort();
}

describe("worker module graphs", () => {
  const entries = workerEntries();

  it("finds the worker entries", () => {
    const names = entries.map((entry) => relative(REPO, entry).split(sep).join("/"));
    for (const expected of [
      "packages/gateway/src/workers/io-worker.ts",
      "packages/gateway/src/workers/cpu-worker.ts",
      "packages/gateway/src/workers/search-worker.ts",
      "packages/gateway/src/workers/writer-worker.ts",
      "packages/gateway/src/workers/indexer-worker.ts",
      "packages/collector/src/event-loop-watchdog-worker.ts",
    ]) {
      expect(names).toContain(expected);
    }
    for (const entry of entries) expect(existsSync(entry), entry).toBe(true);
  });

  it.each(entries.map((entry) => [relative(REPO, entry).split(sep).join("/"), entry]))(
    "%s reaches no deferred library statically",
    (_name, entry) => {
      const reached = librariesReached(entry);
      const offending = Object.keys(DEFERRED_LIBRARIES)
        .filter((library) => reached.has(library))
        .map(
          (library) =>
            `${library} (${DEFERRED_LIBRARIES[library]}) via ${reached.get(library)!.join(" -> ")}`,
        );
      expect(offending).toEqual([]);
    },
  );

  it("keeps private-file and stall-worker graphs builtin-only without broad gateway/agent barrels", () => {
    const allowedCore = new Set([
      "packages/core/src/subpath/private-files.ts",
      "packages/core/src/atomic-write.ts",
      "packages/core/src/security-files.ts",
      "packages/core/src/windows-private-file.ts",
    ]);
    for (const entry of [
      join(REPO, "packages/core/src/subpath/private-files.ts"),
      join(GATEWAY_SRC, "workers/stall-watchdog-worker.ts"),
    ]) {
      const visited = new Set<string>();
      expect([...librariesReached(entry, visited).keys()]).toEqual([]);
      const paths = [...visited].map((file) => relative(REPO, file).split(sep).join("/"));
      expect(
        paths.filter((file) => file.startsWith("packages/core/") && !allowedCore.has(file)),
      ).toEqual([]);
      expect(paths.some((file) => file.startsWith("packages/agent/"))).toBe(false);
      expect(paths).not.toContain("packages/gateway/src/server.ts");
    }
  });

  it("sees a static import of a deferred library", () => {
    // The graph reader itself: `recognizer.ts` defers the recognizer through
    // `lazyRequire`, while its own test imports the library directly.
    const reached = librariesReached(join(GATEWAY_SRC, "enrichment/dates/language-route.test.ts"));
    expect(reached.has("@microsoft/recognizers-text-date-time")).toBe(true);
  });
});
