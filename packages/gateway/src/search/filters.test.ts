// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { mergeArrays, mergeFilters, mergePersonFilters } from "./filters.js";

describe("mergeArrays", () => {
  test("returns undefined when both args are absent", () => {
    expect(mergeArrays(undefined, undefined)).toBeUndefined();
  });

  test("returns the second when the first is absent", () => {
    expect(mergeArrays(undefined, ["x"])).toEqual(["x"]);
  });

  test("returns the first when the second is absent", () => {
    expect(mergeArrays(["x"], undefined)).toEqual(["x"]);
  });

  test("concatenates both when both are present", () => {
    expect(mergeArrays(["a", "b"], ["c"])).toEqual(["a", "b", "c"]);
  });
});

describe("mergeFilters", () => {
  test("returns a clone of `a` when `b` is undefined", () => {
    const a = { sourceIds: ["s1"], dateFrom: "2026-01-01" };
    const out = mergeFilters(a);
    expect(out).toEqual(a);
    expect(out).not.toBe(a);
  });

  test("scalar fields from `b` win over `a`", () => {
    const a = { dateFrom: "2026-01-01", dateTo: "2026-12-31" };
    const b = { dateFrom: "2026-06-01" };
    const out = mergeFilters(a, b);
    expect(out.dateFrom).toBe("2026-06-01");
    expect(out.dateTo).toBe("2026-12-31");
  });

  test("array fields concatenate (preserves dedup-by-callee semantics)", () => {
    const out = mergeFilters(
      { sourceIds: ["s1"], tags: ["a"] },
      { sourceIds: ["s2"], tags: ["b"] },
    );
    expect(out.sourceIds).toEqual(["s1", "s2"]);
    expect(out.tags).toEqual(["a", "b"]);
  });

  test("absent fields from one side don't drop the other side's values", () => {
    const out = mergeFilters({ sourceIds: ["s1"], tags: ["t1"] }, { documentTypes: ["email"] });
    expect(out.sourceIds).toEqual(["s1"]);
    expect(out.tags).toEqual(["t1"]);
    expect(out.documentTypes).toEqual(["email"]);
  });

  test("empty `a` + populated `b` returns `b`'s values", () => {
    const out = mergeFilters({}, { sourceIds: ["s1"], dateFrom: "2026-01-01" });
    expect(out.sourceIds).toEqual(["s1"]);
    expect(out.dateFrom).toBe("2026-01-01");
  });

  test("personFilters with matching role buckets collapse (refs OR)", () => {
    const out = mergeFilters(
      {
        personFilters: [{ refs: ["alice"], roles: ["sender", "author", "owner"] }],
      },
      {
        personFilters: [{ refs: ["bob"], roles: ["sender", "author", "owner"] }],
      },
    );
    expect(out.personFilters).toEqual([
      { refs: ["alice", "bob"], roles: ["sender", "author", "owner"] },
    ]);
  });

  test("personFilters with different role buckets stay separate (AND)", () => {
    const out = mergeFilters(
      {
        personFilters: [{ refs: ["alice"], roles: ["sender", "author", "owner"] }],
      },
      {
        personFilters: [{ refs: ["bob"], roles: ["recipient"] }],
      },
    );
    expect(out.personFilters).toEqual([
      { refs: ["alice"], roles: ["sender", "author", "owner"] },
      { refs: ["bob"], roles: ["recipient"] },
    ]);
  });
});

describe("mergePersonFilters", () => {
  test("returns undefined when both inputs are absent", () => {
    expect(mergePersonFilters(undefined, undefined)).toBeUndefined();
  });

  test("collapses identical role buckets across inputs", () => {
    const out = mergePersonFilters(
      [{ refs: ["alice"], roles: ["sender", "author", "owner"] }],
      [{ refs: ["bob"], roles: ["sender", "author", "owner"] }],
    );
    expect(out).toEqual([{ refs: ["alice", "bob"], roles: ["sender", "author", "owner"] }]);
  });

  test("any-role bucket (roles undefined) stays distinct from from-role bucket", () => {
    const out = mergePersonFilters(
      [{ refs: ["alice"] }],
      [{ refs: ["bob"], roles: ["sender", "author", "owner"] }],
    );
    expect(out).toEqual([
      { refs: ["alice"] },
      { refs: ["bob"], roles: ["sender", "author", "owner"] },
    ]);
  });
});
