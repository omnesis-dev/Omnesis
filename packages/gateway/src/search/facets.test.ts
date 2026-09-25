// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { buildFacets } from "./facets.js";
import type { SearchResultItem } from "./types.js";

function row(documentType: string, sourceId: string, documentId: string): SearchResultItem {
  return {
    documentId,
    sourceId,
    documentType,
    title: `t-${documentId}`,
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    chunkText: "",
    score: 0.5,
  };
}

describe("buildFacets", () => {
  test("empty input → both maps empty", () => {
    expect(buildFacets([])).toEqual({ byType: {}, bySource: {} });
  });

  test("counts by type and source independently", () => {
    const facets = buildFacets([
      row("email", "gmail:a", "1"),
      row("email", "gmail:a", "2"),
      row("note", "apple-notes:local", "3"),
      row("event", "google-calendar:a", "4"),
      row("email", "outlook:b", "5"),
    ]);
    expect(facets.byType).toEqual({ email: 3, note: 1, event: 1 });
    expect(facets.bySource).toEqual({
      "gmail:a": 2,
      "apple-notes:local": 1,
      "google-calendar:a": 1,
      "outlook:b": 1,
    });
  });

  test("does not synthesize zero-count buckets for absent types", () => {
    const facets = buildFacets([row("email", "gmail:a", "1")]);
    expect(Object.keys(facets.byType ?? {})).toEqual(["email"]);
  });
});
