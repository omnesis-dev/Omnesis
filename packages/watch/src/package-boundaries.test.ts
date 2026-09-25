// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Two properties this package must hold are exactly the two shortcuts that are
 * tempting to take, so they are enforced mechanically rather than by review.
 *
 * **No gateway.** The proof of concept's whole value is that the DSL and the
 * runtime are proven against a fixture universe. The moment a module reaches
 * into the gateway for "the real ontology" or "the real journal", the thing
 * being proven changes into something that only works on a live install.
 *
 * **No clock reads.** Golden traces and backtests must be reproducible. Time in
 * this package is always *passed in* — from the journal, from the tick, from a
 * bound `$today` — so a run in CI at 3am gives the same answer as a run on a
 * laptop at noon. `Date.now()` and a zero-argument `new Date()` are the two
 * ways that gets broken by accident.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));
/**
 * The fixture generators are inside the guard too. A universe built from a
 * clock read would produce a different journal on every run, which is the one
 * thing a golden corpus cannot survive.
 */
const UNIVERSES = resolve(SRC, "..", "universes");
const SCRIPTS = resolve(SRC, "..", "scripts");

/**
 * The files the determinism guards read: `src/` and the fixture builders, no
 * tests. A test may read a clock; a source file may not.
 */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|mjs)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) found.push(path);
    }
  };
  walk(SRC);
  walk(UNIVERSES);
  return found.sort();
}

/**
 * Every file in the package, tests and scripts included.
 *
 * The network guard needs all of them. A test acquiring a live endpoint is the
 * likeliest way this package starts depending on a provider being up, and the
 * script is the one file that spends money — so a guard that skipped either
 * would be checking the places least likely to go wrong.
 */
function allFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|mjs)$/.test(entry.name)) found.push(path);
    }
  };
  walk(SRC);
  walk(UNIVERSES);
  walk(SCRIPTS);
  return found.sort();
}

/**
 * Blank out comments while preserving line numbering, so a line-based scan
 * reads code only.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => " ".repeat(line.length));
}

/**
 * Comments and string bodies both blanked.
 *
 * A banned call spelled inside a string is not a call, and once test files are
 * in scope that stops being hypothetical: the test below writes
 * `fetch("https://example.com")` into a literal to show the pattern matches,
 * and a scan that read strings would flag the guard for describing itself.
 * Import specifiers are read before this runs, so blanking them costs nothing.
 */
function stripCommentsAndStrings(source: string): string {
  return stripComments(source)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (text) => `"${" ".repeat(Math.max(0, text.length - 2))}"`)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (text) => `'${" ".repeat(Math.max(0, text.length - 2))}'`)
    .replace(/`(?:[^`\\]|\\.)*`/g, (text) => text.replace(/[^\n]/g, " "));
}

/**
 * Import specifiers, however they are written.
 *
 * Matching only double-quoted static imports leaves three ways past the guard:
 * a single-quoted or backtick specifier, a dynamic `import(...)`, and a
 * `require(...)`. None of those is exotic — Prettier is what keeps this package
 * on double quotes, so the guard would be relying on a formatter to enforce an
 * architectural boundary.
 */
function importsOf(source: string): string[] {
  const quoted = String.raw`["'\`]([^"'\`]+)["'\`]`;
  const patterns = [
    new RegExp(String.raw`(?:from|import)\s+${quoted}`, "g"),
    new RegExp(String.raw`\bimport\s*\(\s*${quoted}`, "g"),
    new RegExp(String.raw`\brequire\s*\(\s*${quoted}`, "g"),
  ];
  return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]!));
}

describe("package boundaries", () => {
  const files = sourceFiles();

  it("has sources to check", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith("build.mjs"))).toBe(true);
  });

  it("imports nothing from the gateway or the collector", () => {
    const offenders: string[] = [];
    for (const file of files) {
      // Scan code, not prose, for the same reason the clock guard does: a
      // comment naming a forbidden package must not read as an import of it.
      for (const specifier of importsOf(stripComments(readFileSync(file, "utf8")))) {
        if (
          /^@omnesis\/(gateway|collector|cli)(\/|$)/.test(specifier) ||
          specifier.includes("packages/gateway")
        ) {
          offenders.push(`${relative(SRC, file)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reads no clock", () => {
    const offenders: string[] = [];
    for (const file of files) {
      // Scan code, not prose. A comment explaining the rule mentions the very
      // call it forbids, and a guard that cannot tell those apart is a guard
      // people work around.
      stripComments(readFileSync(file, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          // `Date.UTC(…)`, `Date.parse(…)` and `new Date(<instant>)` convert a
          // value that was passed in. `Date.now()` and a bare `new Date()` read
          // the wall clock.
          if (
            /\bDate\.now\s*\(/.test(line) ||
            /\bnew Date\s*\(\s*\)/.test(line) ||
            /\bperformance\.now\s*\(/.test(line) ||
            /\bMath\.random\s*\(/.test(line)
          ) {
            offenders.push(`${relative(SRC, file)}:${i + 1} ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("sees an import however it is spelled, so the guard cannot be stepped around", () => {
    // Each of these would have slipped past a scan that matched only
    // double-quoted static imports.
    const evasions = [
      `import { x } from '@omnesis/gateway';`,
      "const m = await import(`@omnesis/gateway`);",
      `const m = require("@omnesis/gateway");`,
      `import { y } from "@omnesis/gateway";`,
    ];
    for (const source of evasions) {
      expect(importsOf(source), source).toContain("@omnesis/gateway");
    }
  });

  it("reads an import in a comment as prose, not as an import", () => {
    expect(importsOf(stripComments(`// never import { x } from "@omnesis/gateway"`))).toEqual([]);
  });

  it("catches a real clock read, so the guard is not vacuous", () => {
    const withCall = stripComments("const t = Date.now();");
    const withComment = stripComments("// Nothing here calls Date.now().\nconst t = 1;");
    expect(/\bDate\.now\s*\(/.test(withCall)).toBe(true);
    expect(/\bDate\.now\s*\(/.test(withComment)).toBe(false);
  });
});

describe("only one file may reach the network", () => {
  /**
   * "Nothing in the suite reaches the network" is true and, until this, held
   * only by everybody remembering. A single import is all it takes for a test
   * to start depending on a provider being up, and the failure would arrive as
   * a flake on somebody else's branch.
   *
   * Every file is scanned — tests and the scripts included, because those are
   * the two most likely places for it to happen and the two a source-only walk
   * would miss.
   *
   * What is banned is *taking* a way out: the global `fetch` as a value, a
   * call to one of the browser transports, or an import of a request library.
   * Not a bare `fetch(` call alone — nothing here makes one, because the client
   * receives its `fetch` as an argument, so a guard anchored only on that would
   * match nothing anywhere and pass for that reason.
   *
   * `typeof globalThis.fetch` is a type annotation and not a way out. The tests
   * that inject a fake client write it, and a guard that could not tell a type
   * from a value would push them into casts that say less.
   */
  const REACHES_OUT =
    /(?<!typeof\s)\b(?:globalThis|window)\.fetch\b|\bfetch\s*\(|\b(?:XMLHttpRequest|EventSource|WebSocket)\s*\(/;
  const REQUEST_LIBRARIES = [
    "undici",
    "node:http",
    "node:https",
    "node:http2",
    "node:net",
    "node:dgram",
    "axios",
    "got",
    "superagent",
    "node-fetch",
    "cross-fetch",
    "ky",
    "ws",
  ];

  /**
   * The client, and this file.
   *
   * A guard has to contain specimens of what it bans — an import line to prove
   * the reader sees one, a call to prove the pattern fires — so scanning
   * itself would flag itself. The two tests below are what stop that exemption
   * from being a hole: one requires the pattern to match a real file, the
   * other requires it to match the specimens.
   */
  const EXEMPT = [join("compiler", "model.ts"), "package-boundaries.test.ts"];

  function reachesOut(path: string): boolean {
    const source = readFileSync(path, "utf8");
    if (REACHES_OUT.test(stripCommentsAndStrings(source))) return true;
    return importsOf(source).some((specifier) => REQUEST_LIBRARIES.includes(specifier));
  }

  it("no file outside the model client reaches out", () => {
    const scanned = allFiles().filter((path) => !EXEMPT.some((allowed) => path.endsWith(allowed)));
    // An empty scan passes trivially, which is the shape this guard would rot
    // into if the walk ever stopped finding anything.
    expect(scanned.length, "the scan found no files at all").toBeGreaterThan(20);

    const offenders = scanned.filter(reachesOut).map((path) => relative(SRC, path));
    expect(offenders, "only the model client may reach the network; these do").toEqual([]);
  });

  it("scans the files most likely to acquire an endpoint", () => {
    // The docstring says a test is the likeliest way this happens, and a
    // source-only walk could not see one. Nor could it see the script that
    // spends money.
    const scanned = allFiles().map((path) => relative(SRC, path));
    expect(scanned.some((path) => path.endsWith("model.test.ts"))).toBe(true);
    expect(scanned.some((path) => path.includes("eval-compiler.ts"))).toBe(true);
  });

  it("matches the one real file that reaches out", () => {
    // Anti-vacuity against a real file rather than an inline string: a pattern
    // that matches nothing anywhere in the package passes by matching nothing,
    // which is how the first version of this guard passed.
    const client = readFileSync(join(SRC, "compiler", "model.ts"), "utf8");
    expect(REACHES_OUT.test(stripCommentsAndStrings(client))).toBe(true);
  });

  it("is not fooled by a call inside a string, nor by the word in prose", () => {
    expect(REACHES_OUT.test(stripCommentsAndStrings('const s = "fetch(url)";'))).toBe(false);
    expect(REACHES_OUT.test(stripCommentsAndStrings("// fetch(url)"))).toBe(false);
    expect(REACHES_OUT.test("expected 3, got 4")).toBe(false);
    expect(REACHES_OUT.test("await fetch(url)")).toBe(true);
    expect(REACHES_OUT.test("globalThis.fetch")).toBe(true);
    // A type annotation is not a way out, and the fake-client tests write one.
    expect(REACHES_OUT.test("fetchImpl?: typeof globalThis.fetch")).toBe(false);
  });

  it("catches the ways round a naive import check", () => {
    // Dynamic import, require, and any quote style — the reader this file
    // already uses for its cross-package rule handles all three.
    for (const source of [
      'import got from "got";',
      "const x = await import('undici');",
      'const http = require("node:http");',
    ]) {
      expect(
        importsOf(source).some((specifier) => REQUEST_LIBRARIES.includes(specifier)),
        source,
      ).toBe(true);
    }
  });
});
