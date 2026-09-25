// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

// @ts-expect-error — portal modules are plain JS.
import {
  attachmentStatusLabel,
  shouldRenderGraphPageSection,
  shouldRenderGraphPanel,
} from "./graph-card.js";

describe("graph paging boundaries", () => {
  test("keeps an edge-less graph mounted for pageable, loading, and failed pages", () => {
    expect(shouldRenderGraphPanel(0, { hasMore: true })).toBe(true);
    expect(shouldRenderGraphPanel(0, { loading: true })).toBe(true);
    expect(
      shouldRenderGraphPanel(0, { error: new Error("fictional graph failure") }),
    ).toBe(true);
    expect(shouldRenderGraphPanel(0, {})).toBe(false);
  });

  test("keeps an empty edge section mounted until its own pager settles", () => {
    expect(shouldRenderGraphPageSection([], { hasMore: true })).toBe(true);
    expect(shouldRenderGraphPageSection([], { loadingMore: true })).toBe(true);
    expect(
      shouldRenderGraphPageSection([], {
        loadMoreError: new Error("fictional append failure"),
      }),
    ).toBe(true);
    expect(shouldRenderGraphPageSection([], {})).toBe(false);
    expect(shouldRenderGraphPageSection([{ id: "edge-example" }], {})).toBe(true);
  });
});

describe("attachment status labels", () => {
  test("distinguishes a successful blank extraction from a failure", () => {
    expect(attachmentStatusLabel("no-text")).toBe("No text found");
    expect(attachmentStatusLabel("extraction-failed")).toBe("Extraction failed");
  });
});
