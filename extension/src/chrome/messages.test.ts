// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { CAPTURE_PENDING_PREFIX, isCaptureMessage } from "./messages.js";

const valid = {
  type: "capture",
  handoffKey: `${CAPTURE_PENDING_PREFIX}instance.visit.1`,
  pairingId: "a".repeat(64),
  emission: {
    kind: "visit",
    normalizedUrl: "https://example.com/article",
    title: "Example article",
    text: "Fictional body",
    contentHash: "a".repeat(64),
    visitedAt: "2026-01-01T00:00:00.000Z",
    dwellMs: 5_000,
    contentChanged: true,
  },
};

describe("capture message boundary", () => {
  it("accepts a bounded HTTPS emission", () => {
    expect(isCaptureMessage(valid)).toBe(true);
  });

  it.each([
    { ...valid, emission: { ...valid.emission, normalizedUrl: "javascript:alert(1)" } },
    {
      ...valid,
      emission: {
        ...valid.emission,
        normalizedUrl: "https://user:password@example.com/article",
      },
    },
    { ...valid, emission: { ...valid.emission, dwellMs: Number.NaN } },
    { ...valid, emission: { ...valid.emission, contentHash: "not-a-sha256" } },
    { ...valid, emission: { ...valid.emission, text: "x".repeat(250_001) } },
    { ...valid, handoffKey: "unrelated-storage-key" },
  ])("rejects malformed or over-limit privileged input", (message) => {
    expect(isCaptureMessage(message)).toBe(false);
  });
});
