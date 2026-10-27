// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { MAX_TRANSCRIPTION_MS } from "@omnesis/core";
import { computeTranscriptionTimeoutMs } from "./deadline.js";

describe("computeTranscriptionTimeoutMs", () => {
  test("floors tiny / zero / negative clips at the minimum", () => {
    expect(computeTranscriptionTimeoutMs(0)).toBe(180_000);
    expect(computeTranscriptionTimeoutMs(1)).toBe(180_000); // 90_000 + 15_000 < 180_000 floor
    expect(computeTranscriptionTimeoutMs(-5)).toBe(180_000);
  });

  test("scales above the floor with clip duration", () => {
    // A 112s note: 90_000 + 112*15_000 = 1_770_000.
    expect(computeTranscriptionTimeoutMs(112)).toBe(1_770_000);
    // A five-minute note already reaches the ceiling.
    expect(computeTranscriptionTimeoutMs(300)).toBe(MAX_TRANSCRIPTION_MS);
  });

  test("ceils absurd durations at the hang-catcher maximum", () => {
    expect(computeTranscriptionTimeoutMs(100_000)).toBe(MAX_TRANSCRIPTION_MS);
  });

  test("a caller's minimum raises the deadline, within the same ceiling", () => {
    expect(computeTranscriptionTimeoutMs(13, 300_000)).toBe(300_000);
    expect(computeTranscriptionTimeoutMs(300, 300_000)).toBe(MAX_TRANSCRIPTION_MS);
    expect(computeTranscriptionTimeoutMs(13, 10 * 60 * 60_000)).toBe(MAX_TRANSCRIPTION_MS);
  });
});
