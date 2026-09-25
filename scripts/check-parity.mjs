#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Cross-surface PARITY-drift guard (epic #804, C16).
//
// The agent transcript ships to three clients — the web portal, iOS, and
// Android — and a handful of lifecycle/timing constants MUST hold identical
// across all three or the ephemeral cards visibly desync. The codebase already
// cross-references these by hand ("Mirror this number on iOS/Android"); this
// guard makes a missed mirror reddable mechanically instead of trusting a code
// reviewer to spot a one-line edit.
//
// HOW IT WORKS (fail-loud, never false-green):
//   1. Reads the source-of-truth table at scripts/parity-constants.json — each
//      key carries a canonical value (in ms) and the surfaces that must carry it.
//   2. For each (key, surface), scans the surface's source file for a trailing
//      `// PARITY:<key>` marker, extracts the FIRST numeric literal on that line
//      (the real value in the code — NOT the table), and normalises it to ms by
//      the surface's declared unit.
//   3. Compares every surface's extracted value to each other AND to the table's
//      canonical value. Any divergence, a key with no marker in a surface it
//      lists, a duplicate marker, or a marker naming an unknown key → exit 1
//      naming the offending key + surfaces.
//
// A self-test (`--self-test`) drives both the in-sync PASS path and a
// deliberately-diverged FAIL path against throwaway fixtures, proving the guard
// actually reddens. scripts/check-parity.test.mjs wires it into the vitest lane.

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const TABLE_PATH = join(here, "parity-constants.json");

// Marker convention: a trailing `// PARITY:<key>` comment. `//` is the line
// comment token in all three surface languages (JS, Swift, Kotlin), so one
// regex covers them. Keys are kebab-case [a-z0-9-].
const MARKER_RE = /\/\/\s*PARITY:([a-z0-9-]+)\b/;

// The value literal is the number that immediately follows the assignment `=`
// — NOT the first number on the line, since a Swift type annotation
// (`: UInt64 = 450_000_000`) or a Kotlin name carries a digit ahead of the
// value. We strip the `// PARITY:` marker comment first, then take the literal
// after the last `=`. The literal allows `_` thousands separators
// (Swift/Kotlin) and an optional fractional part; a trailing `L`/`f`/`d`
// suffix is ignored. Only the LEADING literal of the RHS is captured, so a
// Swift `= 0.35 * AppBuild.multiplier` reads as 0.35.
const VALUE_RE = /=\s*([-+]?\d[\d_]*(?:\.\d[\d_]*)?)/;

function parseLiteral(line) {
  // Drop the trailing marker comment so a digit inside the key name can't be
  // mistaken for the value.
  const code = line.replace(/\/\/.*$/, "");
  // Last `=` wins (handles `==`-free simple assignments across all three langs).
  const lastEq = code.lastIndexOf("=");
  if (lastEq === -1) return null;
  const rhs = code.slice(lastEq);
  const m = rhs.match(VALUE_RE);
  if (!m) return null;
  const n = Number(m[1].replace(/_/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toMs(value, unit) {
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "ns":
      return value / 1_000_000;
    default:
      throw new Error(`unknown unit "${unit}" in parity table`);
  }
}

// Scans one file for `// PARITY:<key>` markers, returning a map
// key → { valueMs, line, raw } and a list of structural problems (unknown key,
// duplicate marker, marker present but no literal on the line).
function scanFile(absPath, fileLabel, unitForKey, knownKeys) {
  const text = readFileSync(absPath, "utf8");
  const lines = text.split("\n");
  const found = new Map();
  const problems = [];
  lines.forEach((line, i) => {
    const m = line.match(MARKER_RE);
    if (!m) return;
    const key = m[1];
    const lineNo = i + 1;
    if (!knownKeys.has(key)) {
      problems.push(
        `${fileLabel}:${lineNo} marker PARITY:${key} names a key absent from parity-constants.json`,
      );
      return;
    }
    if (found.has(key)) {
      problems.push(
        `${fileLabel}:${lineNo} duplicate marker PARITY:${key} (already seen at line ${found.get(key).line})`,
      );
      return;
    }
    const raw = parseLiteral(line);
    if (raw === null) {
      problems.push(
        `${fileLabel}:${lineNo} marker PARITY:${key} has no numeric literal on its line`,
      );
      return;
    }
    found.set(key, { valueMs: toMs(raw, unitForKey(key)), line: lineNo, raw });
  });
  return { found, problems };
}

// Core check over a table object + a resolver that maps a relative file path to
// an absolute one (so the self-test can point at fixture files). Returns
// { errors: string[] }. Pure-ish: only reads files.
export function checkParity(table, resolve = (rel) => join(repoRoot, rel)) {
  const errors = [];
  const keys = Object.keys(table.keys);
  const knownKeys = new Set(keys);

  // Group keys by surface file so each file is scanned once, and so a marker for
  // an unknown key (or a duplicate) is caught even if it lives in a file a key
  // references for an unrelated key.
  const surfaceFiles = new Map(); // fileLabel -> { absPath, unitByKey: Map }
  for (const key of keys) {
    const surfaces = table.keys[key].surfaces;
    for (const [, spec] of Object.entries(surfaces)) {
      const rel = spec.file;
      if (!surfaceFiles.has(rel)) {
        surfaceFiles.set(rel, { absPath: resolve(rel), unitByKey: new Map() });
      }
      surfaceFiles.get(rel).unitByKey.set(key, spec.unit);
    }
  }

  // Scan every surface file once.
  const scansByFile = new Map();
  for (const [rel, info] of surfaceFiles) {
    let scan;
    try {
      scan = scanFile(info.absPath, rel, (key) => info.unitByKey.get(key), knownKeys);
    } catch (err) {
      errors.push(`${rel}: ${err.message}`);
      continue;
    }
    scansByFile.set(rel, scan);
    errors.push(...scan.problems);
  }

  // For each key: assert every listed surface carries a marker, and that all
  // extracted values + the canonical table value agree (in ms).
  for (const key of keys) {
    const entry = table.keys[key];
    const canonicalMs = entry.canonicalMs;
    const observed = []; // { surface, valueMs, line }
    for (const [surface, spec] of Object.entries(entry.surfaces)) {
      const scan = scansByFile.get(spec.file);
      const hit = scan ? scan.found.get(key) : undefined;
      if (!hit) {
        errors.push(
          `key "${key}": surface "${surface}" (${spec.file}) is missing its // PARITY:${key} marker`,
        );
        continue;
      }
      observed.push({ surface, valueMs: hit.valueMs, line: hit.line });
    }
    const distinct = new Set(observed.map((o) => o.valueMs));
    distinct.add(canonicalMs);
    if (distinct.size > 1) {
      const detail = observed.map((o) => `${o.surface}=${o.valueMs}ms (line ${o.line})`).join(", ");
      errors.push(`key "${key}": surfaces diverge — canonical=${canonicalMs}ms; ${detail}`);
    }
  }

  return { errors };
}

function loadTable(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || !raw.keys) {
    throw new Error(`${path}: missing top-level "keys" object`);
  }
  return raw;
}

// ── Self-test: builds throwaway fixtures and proves the guard PASSES in-sync
// and FAILS on a deliberate divergence + on a missing marker.
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "parity-selftest-"));
  try {
    const table = {
      keys: {
        "demo-ms": {
          description: "self-test",
          canonicalMs: 350,
          surfaces: {
            portal: { file: "p.js", unit: "ms" },
            ios: { file: "i.swift", unit: "s" },
            android: { file: "a.kt", unit: "ms" },
          },
        },
      },
    };
    const resolve = (rel) => join(dir, rel);
    const write = (rel, body) => writeFileSync(join(dir, rel), body);

    // 1) In sync (350ms == 0.35s == 350ms) → PASS.
    write("p.js", "const REVEAL_MS = 350; // PARITY:demo-ms\n");
    write("i.swift", "let reveal: Double = 0.35 * mult // PARITY:demo-ms\n");
    write("a.kt", "private const val RevealMs = 350L // PARITY:demo-ms\n");
    const ok = checkParity(table, resolve);
    if (ok.errors.length) {
      throw new Error(`self-test PASS case unexpectedly failed: ${ok.errors.join("; ")}`);
    }

    // 2) Android diverged (351ms) → must FAIL naming android.
    write("a.kt", "private const val RevealMs = 351L // PARITY:demo-ms\n");
    const diverged = checkParity(table, resolve);
    if (!diverged.errors.some((e) => e.includes("diverge") && e.includes("android"))) {
      throw new Error(`self-test divergence not caught: ${JSON.stringify(diverged.errors)}`);
    }

    // 3) Missing marker (iOS marker removed) → must FAIL naming the missing surface.
    write("a.kt", "private const val RevealMs = 350L // PARITY:demo-ms\n");
    write("i.swift", "let reveal: Double = 0.35 * mult\n");
    const missing = checkParity(table, resolve);
    if (!missing.errors.some((e) => e.includes("missing") && e.includes("ios"))) {
      throw new Error(`self-test missing-marker not caught: ${JSON.stringify(missing.errors)}`);
    }
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    selfTest();
    process.stdout.write("check-parity self-test: OK (PASS + divergence + missing-marker)\n");
    return;
  }

  let tablePath = TABLE_PATH;
  const idx = args.indexOf("--table");
  if (idx !== -1) {
    const p = args[idx + 1];
    if (!p) {
      process.stderr.write("error: --table requires a path\n");
      process.exit(2);
    }
    tablePath = isAbsolute(p) ? p : join(process.cwd(), p);
  }

  let table;
  try {
    table = loadTable(tablePath);
  } catch (err) {
    process.stderr.write(`check-parity: ${err.message}\n`);
    process.exit(2);
  }

  const { errors } = checkParity(table);
  if (errors.length) {
    process.stderr.write("PARITY DRIFT — cross-surface constants out of sync:\n");
    for (const e of errors) process.stderr.write(`  ✗ ${e}\n`);
    process.stderr.write(
      "\nFix: mirror the literal in every listed surface file AND scripts/parity-constants.json in the same change.\n",
    );
    process.exit(1);
  }
  const n = Object.keys(table.keys).length;
  process.stdout.write(
    `check-parity: OK — ${n} cross-surface constant(s) in sync across all surfaces.\n`,
  );
}

// Run only when invoked as a script (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
