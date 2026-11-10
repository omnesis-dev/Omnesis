// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { groupVoices, packVectors, unpackVectors, voiceWindows } from "./voices.js";

/** A unit-ish vector near `base` (one of a few orthogonal voices), with a little noise. */
function voice(base: number, noise: number, dim = 16): Float32Array {
  const v = new Float32Array(dim);
  v[base] = 1;
  v[(base + 7) % dim] = noise;
  return v;
}

describe("voiceWindows", () => {
  test("drops stretches too short for a voice vector and splits long ones evenly", () => {
    expect(
      voiceWindows([
        { startMs: 0, endMs: 600 },
        { startMs: 1_000, endMs: 4_000 },
        { startMs: 5_000, endMs: 22_000 },
      ]),
    ).toEqual([
      { startMs: 1_000, endMs: 4_000 },
      { startMs: 5_000, endMs: 10_667 },
      { startMs: 10_667, endMs: 16_333 },
      { startMs: 16_333, endMs: 22_000 },
    ]);
  });
});

describe("groupVoices", () => {
  test("groups windows of one voice together and numbers speakers by first appearance", () => {
    const labels = groupVoices([
      voice(3, 0.1),
      voice(5, 0.2),
      voice(3, 0.3),
      voice(9, 0.1),
      voice(5, 0.0),
      voice(3, 0.2),
    ]);
    expect(labels).toEqual([0, 1, 0, 2, 1, 0]);
  });

  test("keeps every window apart above any similarity, and together below it", () => {
    const vectors = [voice(1, 0.5), voice(1, 0.4), voice(2, 0.5)];
    expect(groupVoices(vectors, 1.01)).toEqual([0, 1, 2]);
    expect(groupVoices(vectors, -1)).toEqual([0, 0, 0]);
  });

  test("an empty recording or a single window", () => {
    expect(groupVoices([])).toEqual([]);
    expect(groupVoices([voice(0, 0)])).toEqual([0]);
  });
});

describe("packVectors", () => {
  test("round-trips vectors through one buffer", () => {
    const vectors = [voice(1, 0.5, 4), voice(2, 0.25, 4)];
    expect(unpackVectors(packVectors(vectors)!, 2)).toEqual(vectors);
    expect(packVectors([])).toBeNull();
  });
});
