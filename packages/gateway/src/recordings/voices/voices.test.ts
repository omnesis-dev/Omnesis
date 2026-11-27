// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  groupVoices,
  matchSelf,
  meanVoice,
  packVectors,
  SAME_SPEAKER_SIMILARITY,
  SELF_VOICE_SIMILARITY,
  unpackVectors,
  voiceWindows,
} from "./voices.js";

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

  test("folds a speaker too short to be a person into the most similar larger one", () => {
    // Two voices of 20 s each, and a 2 s window the model placed apart from both.
    const stray = new Float32Array(16);
    stray[3] = 0.4;
    stray[11] = 1;
    const vectors = [voice(3, 0.1), voice(5, 0.1), stray, voice(3, 0.2), voice(5, 0.2)];
    const durations = [10_000, 10_000, 2_000, 10_000, 10_000];
    expect(groupVoices(vectors, 0.9)).toEqual([0, 1, 2, 0, 1]);
    expect(groupVoices(vectors, 0.9, durations)).toEqual([0, 1, 0, 0, 1]);
  });

  test("keeps a short speaker when the whole recording is short", () => {
    // 6 s of speech: the floor is 15% of it, so a 2 s speaker stays a speaker.
    const vectors = [voice(3, 0.1), voice(5, 0.1), voice(3, 0.2)];
    expect(groupVoices(vectors, 0.9, [2_000, 2_000, 2_000])).toEqual([0, 1, 0]);
  });

  test("in a long session, folds stray windows that add up past the flat floor", () => {
    // Two voices of 15 min each, and 40 s of stray windows the model kept apart:
    // more than 8 s, but less than 5% of the half hour.
    const stray = new Float32Array(16);
    stray[3] = 0.4;
    stray[11] = 1;
    const vectors: Float32Array[] = [];
    const durations: number[] = [];
    for (let i = 0; i < 90; i += 1) {
      vectors.push(voice(3, 0.1), voice(5, 0.1));
      durations.push(10_000, 10_000);
    }
    for (let i = 0; i < 10; i += 1) {
      vectors.push(stray);
      durations.push(4_000);
    }
    expect(groupVoices(vectors, 0.9).includes(2)).toBe(true);
    expect(new Set(groupVoices(vectors, 0.9, durations))).toEqual(new Set([0, 1]));
  });

  test("keeps the longest speaker when every speaker is below the floor", () => {
    const vectors = [voice(3, 0.1), voice(5, 0.1), voice(9, 0.1)];
    expect(groupVoices(vectors, 0.9, [500, 100, 100])).toEqual([0, 0, 0]);
  });

  test("an empty recording or a single window", () => {
    expect(groupVoices([])).toEqual([]);
    expect(groupVoices([voice(0, 0)])).toEqual([0]);
  });
});

describe("matchSelf", () => {
  const profile = meanVoice([voice(5, 0.1), voice(5, 0.3)]);

  test("names the speaker whose mean voice is the enrolled one", () => {
    const vectors = [voice(3, 0.1), voice(5, 0.2), voice(3, 0.2), voice(5, 0.0)];
    expect(matchSelf(vectors, [0, 1, 0, 1], profile)).toEqual({
      label: 1,
      similarity: expect.closeTo(1, 1),
    });
  });

  test("names nobody below the threshold, or when the profile is of another size", () => {
    const vectors = [voice(3, 0.1), voice(9, 0.1)];
    expect(matchSelf(vectors, [0, 1], profile)).toBeNull();
    expect(matchSelf([voice(5, 0.1, 8)], [0], profile)).toBeNull();
    expect(matchSelf([], [], profile)).toBeNull();
  });

  test("of two speakers above the threshold, only the more similar one is the owner", () => {
    // One voice split in two: both halves resemble the owner, one more closely.
    const closer = voice(5, 0.1);
    const looser = voice(5, 0.9);
    expect(matchSelf([looser, closer], [0, 1], profile, 0.5)).toMatchObject({ label: 1 });
  });

  test("the threshold sits above the one that groups a session's windows", () => {
    expect(SELF_VOICE_SIMILARITY).toBeGreaterThan(SAME_SPEAKER_SIMILARITY);
  });
});

describe("meanVoice", () => {
  test("is unit length whatever the vectors' lengths", () => {
    const mean = meanVoice([voice(1, 0, 4).map((x) => x * 10), voice(2, 0, 4)]);
    expect(Math.hypot(...mean)).toBeCloseTo(1, 6);
    expect(mean[1]).toBeCloseTo(mean[2]!, 6);
    expect(meanVoice([])).toEqual(new Float32Array(0));
  });
});

describe("packVectors", () => {
  test("round-trips vectors through one buffer", () => {
    const vectors = [voice(1, 0.5, 4), voice(2, 0.25, 4)];
    expect(unpackVectors(packVectors(vectors)!, 2)).toEqual(vectors);
    expect(packVectors([])).toBeNull();
  });
});
