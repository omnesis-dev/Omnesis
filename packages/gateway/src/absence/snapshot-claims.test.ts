// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { normalizeSnapshot } from "./snapshot-claims.js";

describe("collapsing the two spellings of a snapshot", () => {
  test("a whole-source enumeration claims no partition in particular", () => {
    expect(normalizeSnapshot({ presentExternalIds: ["a", "b"] })).toEqual({
      presentExternalIds: ["a", "b"],
      claimedPartitions: undefined,
    });
  });

  test("no assertion at all stays no assertion", () => {
    expect(normalizeSnapshot({})).toEqual({
      presentExternalIds: undefined,
      claimedPartitions: undefined,
    });
  });

  test("claims become one id set and the partitions they came from", () => {
    expect(
      normalizeSnapshot({
        presentClaims: [
          { partition: "books/home", ids: ["a", "b"] },
          { partition: "books/work", ids: ["c"] },
        ],
      }),
    ).toEqual({
      presentExternalIds: ["a", "b", "c"],
      claimedPartitions: ["books/home", "books/work"],
    });
  });

  test("an id in two partitions is one id, and both partitions are claimed", () => {
    // The same contact in two address books is one document; the gateway asks
    // "is it named anywhere?", not "how many times".
    expect(
      normalizeSnapshot({
        presentClaims: [
          { partition: "books/home", ids: ["shared"] },
          { partition: "books/work", ids: ["shared"] },
        ],
      }),
    ).toEqual({
      presentExternalIds: ["shared"],
      claimedPartitions: ["books/home", "books/work"],
    });
  });

  test("an empty claim is a claim: the partition was read and holds nothing", () => {
    // Distinct from claiming nothing at all. This one deletes that
    // partition's documents; the other touches nothing.
    expect(normalizeSnapshot({ presentClaims: [{ partition: "books/home", ids: [] }] })).toEqual({
      presentExternalIds: [],
      claimedPartitions: ["books/home"],
    });
  });

  test("claiming no partitions asserts nothing about any of them", () => {
    expect(normalizeSnapshot({ presentClaims: [] })).toEqual({
      presentExternalIds: [],
      claimedPartitions: [],
    });
  });

  test("both spellings at once is refused rather than resolved", () => {
    expect(() =>
      normalizeSnapshot({
        presentExternalIds: ["a"],
        presentClaims: [{ partition: "books/home", ids: ["a"] }],
      }),
    ).toThrow(/one question/);
  });

  test("one partition claimed twice is refused", () => {
    // Two answers about one store. The enumeration that builds claims cannot
    // produce this, so it means the list was assembled by hand.
    expect(() =>
      normalizeSnapshot({
        presentClaims: [
          { partition: "books/home", ids: ["a"] },
          { partition: "books/home", ids: ["b"] },
        ],
      }),
    ).toThrow(/twice/);
  });
});
