// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { deviceChunks } from "./chunking.js";

describe("deviceChunks", () => {
  test("cuts in the silence nearest the target length and covers the recording", () => {
    const silences = [10_000, 17_000, 30_000, 41_000].map((t) => ({ startMs: t, endMs: t + 400 }));
    const chunks = deviceChunks(50_000, silences, new Float32Array(1_000).fill(1));
    expect(chunks).toEqual([
      { startMs: 0, endMs: 17_200 },
      { startMs: 17_200, endMs: 30_200 },
      { startMs: 30_200, endMs: 50_000 },
    ]);
  });
  test("without a silence near the target, cuts at the quietest frame there", () => {
    const energy = new Float32Array(3_000).fill(1);
    energy[400] = 0; // 20 s
    energy[600] = 0; // 30 s: too far from the target
    const chunks = deviceChunks(150_000, [{ startMs: 29_800, endMs: 30_200 }], energy);
    expect(chunks[0]).toEqual({ startMs: 0, endMs: 20_025 });
    for (const c of chunks) expect(c.endMs - c.startMs).toBeLessThanOrEqual(24_000);
    expect(chunks.at(-1)!.endMs).toBe(150_000);
  });
});
