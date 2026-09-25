// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { buildDfSab, dfLookupFromSab } from "./df-sab.js";

describe("buildDfSab / dfLookupFromSab", () => {
  test("returns a SharedArrayBuffer", () => {
    const sab = buildDfSab(
      [
        ["a", 1],
        ["b", 2],
      ],
      10,
    );
    expect(sab).toBeInstanceOf(SharedArrayBuffer);
  });

  test("round-trips df for present shingles and 0 for absent", () => {
    const entries: Array<[string, number]> = [
      ["the", 90],
      ["quick", 10],
      ["brown", 8],
      ["fox", 5],
    ];
    const lookup = dfLookupFromSab(buildDfSab(entries, 100));
    expect(lookup.totalDocs).toBe(100);
    for (const [shingle, df] of entries) expect(lookup.df(shingle)).toBe(df);
    expect(lookup.df("never-seen")).toBe(0);
    expect(lookup.df("")).toBe(0);
  });

  test("empty table: every lookup is 0, totalDocs preserved", () => {
    const lookup = dfLookupFromSab(buildDfSab([], 0));
    expect(lookup.totalDocs).toBe(0);
    expect(lookup.df("anything")).toBe(0);
  });

  test("matches a Map reference over a larger random-ish corpus", () => {
    // Deterministic pseudo-shingles (no Math.random — stable across runs).
    const ref = new Map<string, number>();
    const entries: Array<[string, number]> = [];
    let seed = 1234567;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 20000; i++) {
      const shingle = `s${next().toString(36)}_${i.toString(36)}`;
      const df = (next() % 500) + 1;
      ref.set(shingle, df);
      entries.push([shingle, df]);
    }
    const lookup = dfLookupFromSab(buildDfSab(entries, 99999));
    expect(lookup.totalDocs).toBe(99999);
    for (const [shingle, df] of ref) expect(lookup.df(shingle)).toBe(df);
    // Absent keys resolve to 0.
    expect(lookup.df("definitely-absent-shingle")).toBe(0);
  });

  test("last-writer semantics on a duplicate key are deterministic", () => {
    // The DB never produces duplicate (shingle) rows for one algo version,
    // but the lookup must at least be deterministic if one slips in.
    const lookup = dfLookupFromSab(
      buildDfSab(
        [
          ["dup", 3],
          ["dup", 7],
        ],
        5,
      ),
    );
    const v = lookup.df("dup");
    expect(v === 3 || v === 7).toBe(true);
    expect(lookup.df("dup")).toBe(v); // stable
  });
});
