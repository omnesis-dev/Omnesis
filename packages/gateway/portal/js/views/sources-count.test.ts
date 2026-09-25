// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { pluralizeUnit, resolveSourceDisplayCount } from "./sources.js";

describe("pluralizeUnit", () => {
  test("singularizes plural descriptor nouns at a count of one", () => {
    expect(pluralizeUnit("conversation days", 1)).toBe("conversation day");
    expect(pluralizeUnit("activities", 1)).toBe("activity");
    expect(pluralizeUnit("messages", 1)).toBe("message");
  });

  test("preserves plural descriptor nouns and pluralizes singular fallbacks", () => {
    expect(pluralizeUnit("conversation days", 2)).toBe("conversation days");
    expect(pluralizeUnit("activities", 0)).toBe("activities");
    expect(pluralizeUnit("doc", 2)).toBe("docs");
  });
});

describe("resolveSourceDisplayCount", () => {
  test("honors a document primary count when documents carry many units", () => {
    const displayCount = resolveSourceDisplayCount({
      documents: 2,
      units: 17,
      analytics: undefined,
      primaryCount: "documents",
    });

    expect(displayCount).toBe(2);
  });

  test("retains the generic unit and analytics heuristics without an override", () => {
    expect(
      resolveSourceDisplayCount({
        documents: 2,
        units: 17,
        analytics: undefined,
        primaryCount: undefined,
      }),
    ).toBe(17);
    expect(
      resolveSourceDisplayCount({
        documents: 0,
        units: null,
        analytics: 24,
        primaryCount: undefined,
      }),
    ).toBe(24);
  });

  test("honors a zero analytics primary count instead of falling back to documents", () => {
    expect(
      resolveSourceDisplayCount({
        documents: 8,
        units: null,
        analytics: 0,
        primaryCount: "analytics",
      }),
    ).toBe(0);
  });
});
