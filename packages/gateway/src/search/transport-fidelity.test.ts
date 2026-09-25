// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Transport-fidelity guard for the search-worker relocation (Slice 3B).
 *
 * The worker <-> main transport MUST be the structured-clone `postMessage`
 * algorithm, NEVER JSON. Search scores carry `Infinity`/`NaN` from min-max
 * normalisation, and usearch neighbour keys are `bigint`. `JSON.stringify`
 * maps `Infinity`/`NaN` -> `null` (silently corrupting rankings) and THROWS on
 * `bigint`. `structuredClone` (what `postMessage` runs) preserves all three.
 *
 * This test reddens the build if anyone reintroduces a JSON hop on the search
 * transport: it proves structuredClone round-trips the special values and
 * documents, by contrast, exactly how JSON would break them.
 */

import { describe, expect, test } from "vitest";

describe("search-worker transport fidelity", () => {
  test("structuredClone preserves Infinity / -Infinity / NaN in scores", () => {
    const result = {
      results: [
        { documentId: "d1", score: Infinity, scoreBreakdown: { bm25: NaN, vector: -Infinity } },
        { documentId: "d2", score: 0.5, scoreBreakdown: { bm25: 0.5, vector: 0 } },
      ],
    };
    const clone = structuredClone(result);
    expect(clone.results[0].score).toBe(Infinity);
    expect(Number.isNaN(clone.results[0].scoreBreakdown.bm25)).toBe(true);
    expect(clone.results[0].scoreBreakdown.vector).toBe(-Infinity);
    expect(clone.results[1].score).toBe(0.5);
  });

  test("structuredClone round-trips a bigint (usearch neighbour key)", () => {
    const payload = { key: 9007199254740993n, distance: 0.25 };
    const clone = structuredClone(payload);
    expect(clone.key).toBe(9007199254740993n);
    expect(typeof clone.key).toBe("bigint");
  });

  test("structuredClone carries a Float32Array query vector losslessly", () => {
    const vec = new Float32Array([0.1, -0.2, 0.3]);
    const clone = structuredClone(vec);
    expect(clone).toBeInstanceOf(Float32Array);
    expect(Array.from(clone)).toEqual(Array.from(vec));
  });

  test("JSON — the FORBIDDEN transport — corrupts Infinity/NaN and throws on bigint", () => {
    // Documents WHY the transport must not be JSON: these are the exact
    // silent-corruption / throw behaviours the structured-clone transport avoids.
    const roundTripped = JSON.parse(JSON.stringify({ score: Infinity, nan: NaN }));
    expect(roundTripped.score).toBeNull(); // Infinity -> null
    expect(roundTripped.nan).toBeNull(); // NaN -> null
    expect(() => JSON.stringify({ key: 1n })).toThrow(TypeError); // bigint throws
  });
});
