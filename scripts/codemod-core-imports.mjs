// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Consumer-import sweep.
 *
 * Rewrites `import … from "@omnesis/core"` / `export … from "@omnesis/core"`
 * statements so each named binding is imported from its *narrowest* home
 * package (`@omnesis/types` / `@omnesis/config` / `@omnesis/source-sdk`),
 * leaving genuinely-core symbols on `@omnesis/core`. A statement that mixes
 * moved + core symbols is SPLIT into one statement per target package.
 *
 * The symbol→package map is derived at runtime from each package's real
 * export surface via the TypeScript compiler API (barrel membership is NOT
 * assumed — a symbol is attributed only to the package that genuinely
 * exports it, and the extraction asserts no symbol is exported by more than
 * one narrow package, so the mapping is unambiguous).
 *
 * Per-specifier `type` modifiers and `as` aliases are preserved. Namespace
 * (`* as`), default, and side-effect imports from core are left untouched
 * (they can't be partitioned by symbol).
 *
 * Usage:
 *   node scripts/codemod-core-imports.mjs <file-or-dir> [<file-or-dir> …]
 *   node scripts/codemod-core-imports.mjs --dry <dir>      # report only
 *   node scripts/codemod-core-imports.mjs --map            # print the map
 */

import * as ts from "typescript";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const NARROW = {
  "@omnesis/types": "packages/types/src/index.ts",
  "@omnesis/config": "packages/config/src/index.ts",
  "@omnesis/source-sdk": "packages/source-sdk/src/index.ts",
};
const CORE = "@omnesis/core";

/** symbol name -> narrow package name. Built once from the real export surfaces. */
function buildProvenanceMap() {
  const program = ts.createProgram(
    Object.values(NARROW).map((p) => resolve(p)),
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ESNext,
      skipLibCheck: true,
      noEmit: true,
    },
  );
  const checker = program.getTypeChecker();
  const map = new Map();
  for (const [pkg, file] of Object.entries(NARROW)) {
    const sf = program.getSourceFile(resolve(file));
    if (!sf) throw new Error(`cannot load ${file}`);
    const sym = checker.getSymbolAtLocation(sf);
    if (!sym) throw new Error(`no module symbol for ${file}`);
    for (const exp of checker.getExportsOfModule(sym)) {
      const name = exp.getName();
      if (map.has(name) && map.get(name) !== pkg) {
        throw new Error(`AMBIGUOUS: ${name} exported by both ${map.get(name)} and ${pkg}`);
      }
      map.set(name, pkg);
    }
  }
  return map;
}

/** Render one specifier back to source: `type Foo as Bar` / `Foo as Bar` / `Foo`. */
function renderSpecifier(spec) {
  const parts = [];
  if (spec.isTypeOnly) parts.push("type ");
  parts.push(spec.propertyName ? `${spec.propertyName} as ${spec.name}` : spec.name);
  return parts.join("");
}

/** Build an import/export statement string for a group of specifiers from a module. */
function renderStatement(kind, wholeTypeOnly, specs, module) {
  const body = specs.map(renderSpecifier).join(", ");
  const typeKw = wholeTypeOnly ? "type " : "";
  return `${kind} ${typeKw}{ ${body} } from "${module}";`;
}

/**
 * Pure transform: rewrite a source string's @omnesis/core named
 * imports/exports per the provenance map. Returns { text, changed, targets,
 * splits, moved }. No file IO — unit-testable.
 */
export function rewriteSource(text, provenance, fileName = "in.ts") {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

  const edits = []; // { start, end, replacement }
  const targets = new Set();
  let splits = 0;
  let moved = 0;

  for (const stmt of sf.statements) {
    const isImport = ts.isImportDeclaration(stmt);
    const isExport = ts.isExportDeclaration(stmt);
    if (!isImport && !isExport) continue;

    const moduleSpec = isImport ? stmt.moduleSpecifier : stmt.moduleSpecifier;
    if (!moduleSpec || !ts.isStringLiteral(moduleSpec) || moduleSpec.text !== CORE) continue;

    // Only handle named bindings. Skip namespace / default-only / side-effect.
    let namedBindings;
    let wholeTypeOnly;
    if (isImport) {
      const clause = stmt.importClause;
      if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
      if (clause.name) continue; // default import alongside named — leave it alone
      namedBindings = clause.namedBindings;
      wholeTypeOnly = clause.isTypeOnly;
    } else {
      if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
      namedBindings = stmt.exportClause;
      wholeTypeOnly = stmt.isTypeOnly;
    }

    const specs = namedBindings.elements.map((el) => ({
      name: el.name.text,
      propertyName: el.propertyName ? el.propertyName.text : undefined,
      isTypeOnly: el.isTypeOnly,
    }));

    // Partition by provenance. Key by the imported symbol = propertyName ?? name.
    const groups = new Map(); // module -> specs[]
    for (const spec of specs) {
      const symbol = spec.propertyName ?? spec.name;
      const dest = provenance.get(symbol) ?? CORE;
      if (!groups.has(dest)) groups.set(dest, []);
      groups.get(dest).push(spec);
    }

    // Nothing moved → no change.
    if (groups.size === 1 && groups.has(CORE)) continue;

    moved += specs.length - (groups.get(CORE)?.length ?? 0);
    if (groups.size > 1) splits++;

    const kind = isImport ? "import" : "export";
    // Deterministic order: core first (residual), then narrow packages alpha.
    const order = [CORE, "@omnesis/config", "@omnesis/source-sdk", "@omnesis/types"];
    const pieces = [];
    for (const mod of order) {
      const g = groups.get(mod);
      if (!g || g.length === 0) continue;
      if (mod !== CORE) targets.add(mod);
      pieces.push(renderStatement(kind, wholeTypeOnly, g, mod));
    }
    edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), replacement: pieces.join("\n") });
  }

  if (edits.length === 0) return { text, changed: false, targets, splits, moved };

  let result = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, e.start) + e.replacement + result.slice(e.end);
  }
  return { text: result, changed: true, targets, splits, moved };
}

/** File-IO wrapper around rewriteSource. */
function rewriteFile(filePath, provenance, dryRun) {
  const res = rewriteSource(readFileSync(filePath, "utf8"), provenance, filePath);
  if (res.changed && !dryRun) writeFileSync(filePath, res.text);
  return res;
}

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if ((p.endsWith(".ts") || p.endsWith(".mts")) && !p.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

// ── main (only when run as a CLI, not when imported by the test) ────────────
function runCli() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const provenance = buildProvenanceMap();

  if (args.includes("--map")) {
    const byPkg = {};
    for (const [s, p] of provenance) (byPkg[p] ??= []).push(s);
    for (const p of Object.keys(byPkg).sort())
      console.log(`${p} (${byPkg[p].length}): ${byPkg[p].sort().join(", ")}`);
    process.exit(0);
  }

  const inputs = args.filter((a) => !a.startsWith("--"));
  const files = [];
  for (const input of inputs) {
    const st = statSync(input);
    if (st.isDirectory()) walk(input, files);
    else files.push(input);
  }

  let changedCount = 0;
  let splitCount = 0;
  let movedCount = 0;
  const pkgTargets = new Map(); // package dir -> Set<narrow pkg>
  for (const f of files) {
    const { changed, targets, splits, moved } = rewriteFile(f, provenance, dryRun);
    if (!changed) continue;
    changedCount++;
    splitCount += splits;
    movedCount += moved;
    const pkgMatch = f.match(/(packages\/[^/]+(?:\/[^/]+)?)\/src\//);
    const pkgDir = pkgMatch ? pkgMatch[1] : "?";
    if (!pkgTargets.has(pkgDir)) pkgTargets.set(pkgDir, new Set());
    for (const t of targets) pkgTargets.get(pkgDir).add(t);
    if (dryRun)
      console.log(
        `${changed ? "WOULD EDIT" : ""} ${relative(process.cwd(), f)} → ${[...targets].join(",")}${splits ? ` (${splits} split)` : ""}`,
      );
  }

  console.log(
    `\n${dryRun ? "[dry] " : ""}${changedCount} files rewritten, ${splitCount} statements split, ${movedCount} bindings moved`,
  );
  console.log(`Packages needing narrow deps:`);
  for (const [pkg, set] of [...pkgTargets].sort())
    console.log(`  ${pkg}: ${[...set].sort().join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
