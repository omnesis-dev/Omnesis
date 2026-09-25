// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Standing check for the cross-surface PARITY-drift guard (epic #804, C16).
//
// Two halves, both required:
//   1. POSITIVE — the guard PASSES against the real in-tree constants table +
//      the actual portal/iOS/Android source. If a future edit diverges a
//      mirrored constant (or drops a marker), this reddens.
//   2. NEGATIVE CONTROL — the guard FAILS loud when a value is deliberately
//      diverged AND when a marker is missing. Proves the guard actually has
//      teeth and isn't a no-op that compares the table to itself.
//
// The negative control drives the guard's pure `checkParity(table, resolve)`
// over throwaway fixture files, so it never mutates the real source tree.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkParity } from "./check-parity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const script = join(here, "check-parity.mjs");

describe("scripts/check-parity.mjs", () => {
  it("PASSES against the real in-tree mirrored constants (exit 0)", () => {
    // Runs the script end-to-end against the real table + real source files.
    // A non-zero exit throws, failing the test — so a real divergence reddens.
    const out = execFileSync("node", [script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(out).toMatch(/in sync across all surfaces/);
  });

  it("self-test passes (PASS + divergence + missing-marker fixtures)", () => {
    const out = execFileSync("node", [script, "--self-test"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(out).toMatch(/self-test: OK/);
  });

  // ── Negative controls over throwaway fixtures ──────────────────────────
  function fixtureTable(dir) {
    const table = {
      keys: {
        "demo-ms": {
          description: "negative-control fixture",
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
    return { table, resolve, write };
  }

  it("FAILS loud naming the diverging surface when a value drifts", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-test-"));
    try {
      const { table, resolve, write } = fixtureTable(dir);
      write("p.js", "const X_MS = 350; // PARITY:demo-ms\n");
      write("i.swift", "let x: Double = 0.35 * m // PARITY:demo-ms\n");
      // Android diverged: 351ms instead of 350ms.
      write("a.kt", "private const val X = 351L // PARITY:demo-ms\n");
      const { errors } = checkParity(table, resolve);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join("\n")).toMatch(/diverge/);
      expect(errors.join("\n")).toMatch(/android=351ms/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS loud naming the surface that is missing its marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-test-"));
    try {
      const { table, resolve, write } = fixtureTable(dir);
      write("p.js", "const X_MS = 350; // PARITY:demo-ms\n");
      // iOS marker removed entirely — must NOT silently pass.
      write("i.swift", "let x: Double = 0.35 * m\n");
      write("a.kt", "private const val X = 350L // PARITY:demo-ms\n");
      const { errors } = checkParity(table, resolve);
      expect(errors.join("\n")).toMatch(/missing its \/\/ PARITY:demo-ms marker/);
      expect(errors.join("\n")).toMatch(/"ios"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS loud when a marker names a key absent from the table", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-test-"));
    try {
      const { table, resolve, write } = fixtureTable(dir);
      write("p.js", "const X_MS = 350; // PARITY:demo-ms\n");
      write("i.swift", "let x: Double = 0.35 * m // PARITY:demo-ms\n");
      // Typo'd marker key — caught so a fat-fingered rename can't silently pass.
      write("a.kt", "private const val X = 350L // PARITY:demo-typo\n");
      const { errors } = checkParity(table, resolve);
      const joined = errors.join("\n");
      expect(joined).toMatch(/demo-typo.*absent from/);
      // And the android surface still reads as missing its real marker.
      expect(joined).toMatch(/"android".*missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS loud on a duplicate marker in one surface", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-test-"));
    try {
      const { table, resolve, write } = fixtureTable(dir);
      write("p.js", "const X_MS = 350; // PARITY:demo-ms\nconst Y_MS = 350; // PARITY:demo-ms\n");
      write("i.swift", "let x: Double = 0.35 * m // PARITY:demo-ms\n");
      write("a.kt", "private const val X = 350L // PARITY:demo-ms\n");
      const { errors } = checkParity(table, resolve);
      expect(errors.join("\n")).toMatch(/duplicate marker PARITY:demo-ms/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
