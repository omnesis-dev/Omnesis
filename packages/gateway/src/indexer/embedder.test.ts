// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { pickIndexerSlotIndex } from "./embedder.js";

describe("pickIndexerSlotIndex", () => {
  test("routes indexer tasks onto slots 1..N-1 (default pool of 4)", () => {
    const poolSize = 4;
    const assignments = Array.from({ length: 12 }, (_, i) => pickIndexerSlotIndex(poolSize, i));
    expect(assignments).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]);
    for (const slot of assignments) {
      expect(slot).toBeGreaterThanOrEqual(1);
      expect(slot).toBeLessThanOrEqual(3);
    }
  });

  test("never returns slot 0 when pool size > 1 (reserved for embedQuery)", () => {
    for (const poolSize of [2, 3, 4, 8, 16]) {
      for (let i = 0; i < 100; i++) {
        expect(pickIndexerSlotIndex(poolSize, i)).not.toBe(0);
      }
    }
  });

  test("falls back to slot 0 when pool size <= 1", () => {
    expect(pickIndexerSlotIndex(1, 0)).toBe(0);
    expect(pickIndexerSlotIndex(1, 7)).toBe(0);
    expect(pickIndexerSlotIndex(0, 0)).toBe(0);
  });

  test("distributes evenly across indexer slots", () => {
    const poolSize = 4;
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 300; i++) counts[pickIndexerSlotIndex(poolSize, i)]++;
    expect(counts[0]).toBe(0);
    expect(counts[1]).toBe(100);
    expect(counts[2]).toBe(100);
    expect(counts[3]).toBe(100);
  });
});
