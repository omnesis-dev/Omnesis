// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { buildMetadataFilter, buildPostJoinFilter, hasPostJoinFilter } from "./metadata.js";
import { hiddenSourceIdsToExclude } from "./hidden-sources.js";

// Filters that don't explicitly name a hidden source carry a standing
// `source_id NOT IN (…)` exclusion (see hidden-sources.ts); the expected
// params below account for its trailing ids.
const HIDDEN = hiddenSourceIdsToExclude({});

describe("buildMetadataFilter", () => {
  test("empty filters emit only the hidden-source exclusion", () => {
    const { clause, params } = buildMetadataFilter({});
    expect(clause).toBe(`c.source_id NOT IN (${HIDDEN.map(() => "?").join(", ")})`);
    expect(params).toEqual(HIDDEN);
  });

  test("builds source ID filter", () => {
    const { clause, params } = buildMetadataFilter({
      sourceIds: ["gmail:test", "calendar:test"],
    });
    expect(clause).toContain("source_id IN");
    expect(params).toEqual(["gmail:test", "calendar:test", ...HIDDEN]);
  });

  test("builds document type filter", () => {
    const { clause, params } = buildMetadataFilter({
      documentTypes: ["email", "conversation"],
    });
    expect(clause).toContain("document_type IN");
    expect(params).toEqual(["email", "conversation", ...HIDDEN]);
  });

  test("builds date range filter", () => {
    const { clause, params } = buildMetadataFilter({
      dateFrom: "2026-01-01",
      dateTo: "2026-03-01",
    });
    expect(clause).toContain("source_created_at >=");
    expect(clause).toContain("source_created_at <=");
    expect(params).toEqual(["2026-01-01", "2026-03-01T23:59:59.999Z", ...HIDDEN]);
  });

  test("builds case-insensitive tag filter", () => {
    // Tag values land verbatim in `chunks.tags` JSON; some sources
    // (Gmail labels) emit upper-case, some emit lower-case, so the
    // filter MUST fold case on both sides. Without this fold the
    // user-typed `tag:inbox` returns zero results in a corpus where
    // Gmail stores labels as `INBOX`.
    const { clause, params } = buildMetadataFilter({
      tags: ["work"],
    });
    expect(clause).toContain("json_each");
    expect(clause).toContain("LOWER(json_each.value)");
    expect(clause).toContain("LOWER(?)");
    expect(params).toEqual(["work", ...HIDDEN]);
  });

  test("dateTo date-only normalizes to end-of-day for inclusive comparison", () => {
    // Regression: before:2026-05-19 used raw "2026-05-19" in the <= comparison,
    // which lexicographically excludes "2026-05-19T*" timestamps.
    const { clause, params } = buildMetadataFilter({ dateTo: "2026-05-19" });
    expect(clause).toContain("source_created_at <=");
    // The param should be end-of-day so "2026-05-19T23:59:59Z" <= param is true
    expect(params[0]).toBe("2026-05-19T23:59:59.999Z");
  });

  test("dateTo with full ISO timestamp passes through unchanged", () => {
    const { params } = buildMetadataFilter({ dateTo: "2026-05-19T15:00:00Z" });
    expect(params[0]).toBe("2026-05-19T15:00:00Z");
  });

  test("does not emit any author predicate", () => {
    // Regression for the author-LIKE bug — filters.personFilters
    // resolves via the people graph into a docId set in the pipeline,
    // never via `author LIKE`. The metadata builder must not emit
    // any author SQL even if a caller still supplies one.
    const { clause, params } = buildMetadataFilter({});
    expect(clause).not.toContain("author");
    expect(params).not.toContain("%alice%");
  });

  test("combines multiple filters with AND", () => {
    const { clause, params } = buildMetadataFilter({
      sourceIds: ["gmail:test"],
      documentTypes: ["email"],
      dateFrom: "2026-01-01",
    });
    // Three explicit conditions + the standing hidden-source exclusion.
    expect(clause.split(" AND ").length).toBe(4);
    expect(params.length).toBe(3 + HIDDEN.length);
  });

  test("uses custom table alias", () => {
    const { clause } = buildMetadataFilter({ sourceIds: ["gmail:test"] }, "chunks");
    expect(clause).toContain("chunks.source_id");
  });
});

describe("buildPostJoinFilter", () => {
  test("emits case-insensitive tag check, no author check", () => {
    const { clause, params } = buildPostJoinFilter({ tags: ["work"] });
    expect(clause).toContain("LOWER(json_each.value)");
    expect(params).toEqual(["work"]);
  });

  test("empty for filters that lack post-JOIN-needing fields", () => {
    const { clause, params } = buildPostJoinFilter({ sourceIds: ["s1"] });
    expect(clause).toBe("");
    expect(params).toEqual([]);
  });
});

describe("hasPostJoinFilter", () => {
  test("true only when tags are present", () => {
    expect(hasPostJoinFilter({})).toBe(false);
    expect(hasPostJoinFilter({ sourceIds: ["s1"] })).toBe(false);
    expect(hasPostJoinFilter({ tags: [] })).toBe(false);
    expect(hasPostJoinFilter({ tags: ["work"] })).toBe(true);
  });
});
