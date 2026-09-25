// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

// @ts-expect-error — portal modules are plain JS.
import {
  PeopleView,
  personMergeRuleBoundaryState,
  shouldShowPersonAnnotations,
} from "./people.js";

describe("person detail request ownership", () => {
  test("keys the detail component by person id so navigation remounts its async state owner", () => {
    const first = PeopleView({ personId: "person-1" });
    const second = PeopleView({ personId: "person-2" });

    expect(first.key).toBe("person-1");
    expect(second.key).toBe("person-2");
  });
});

describe("person detail paging surfaces", () => {
  test("keeps empty observations mounted while their page can still load or retry", () => {
    expect(shouldShowPersonAnnotations([], { hasMore: true })).toBe(true);
    expect(shouldShowPersonAnnotations([], { loading: true })).toBe(true);
    expect(
      shouldShowPersonAnnotations([], { error: new Error("fictional failure") }),
    ).toBe(true);
    expect(shouldShowPersonAnnotations([], {})).toBe(false);
    expect(shouldShowPersonAnnotations([{ id: "memory-1" }], {})).toBe(true);
  });

  test("retries an initial merge-rule failure with reload rather than a cursor no-op", () => {
    const reload = () => "reload";
    const loadMore = () => "load-more";
    const error = new Error("fictional merge-rule failure");
    const boundary = personMergeRuleBoundaryState({
      hasMore: false,
      error,
      reload,
      loadMore,
    });

    expect(boundary.visible).toBe(true);
    expect(boundary.hasMore).toBe(true);
    expect(boundary.error).toBe(error);
    expect(boundary.onLoadMore).toBe(reload);
  });
});
