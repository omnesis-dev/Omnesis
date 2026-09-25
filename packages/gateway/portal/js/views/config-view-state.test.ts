// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  isLatestConfigRefresh,
  markReviewStale,
  // @ts-expect-error — sibling .js modules, no .d.ts in the portal tree.
} from "./config.js";

describe("config view refresh arbitration", () => {
  it("allows only the newest overlapping refresh request to mutate success or error state", () => {
    expect(isLatestConfigRefresh(4, 5)).toBe(false);
    expect(isLatestConfigRefresh(5, 5)).toBe(true);
  });

  it("invalidates a refresh sequence when a mutation begins", () => {
    let latestSequence = 8;
    const inFlightRefresh = latestSequence;
    latestSequence += 1;
    expect(isLatestConfigRefresh(inFlightRefresh, latestSequence)).toBe(false);
  });
});

describe("stale save review", () => {
  it("keeps an open review open but marked stale instead of closing it", () => {
    // Reported QA bug: an external change dismissed the review modal. The
    // modal must stay open with confirming disabled until re-review.
    const review = { diffs: [], saveKind: "patch", payload: {}, beforeText: "", afterText: "" };
    const marked = markReviewStale(review);

    expect(marked).not.toBeNull();
    expect(marked.stale).toBe(true);
    // The stale diff/payload stay visible for inspection, not confirmable.
    expect(marked.payload).toBe(review.payload);
  });

  it("leaves a closed review closed", () => {
    expect(markReviewStale(null)).toBeNull();
  });
});
