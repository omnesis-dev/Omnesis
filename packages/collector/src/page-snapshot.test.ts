// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a page is allowed to assert about what still exists.
 *
 * A snapshot deletes everything it does not name, so the cases here are the
 * ones where forwarding it would delete data: a page that is not the last, and
 * a page that makes the assertion twice in two shapes that disagree.
 */

import { describe, expect, test, vi } from "vitest";
import { assertsPresence, pageSnapshot } from "./page-snapshot.js";

const log = () => ({ error: vi.fn() });

describe("a completed page's assertion", () => {
  test("only attempted assertions report assessment, including successful recovery", () => {
    const assessed = vi.fn();
    pageSnapshot("example:local", { hasMore: false }, log(), assessed);
    expect(assessed).not.toHaveBeenCalled();
    pageSnapshot("example:local", { hasMore: true, presentExternalIds: [] }, log(), assessed);
    expect(assessed).toHaveBeenLastCalledWith(expect.any(String));
    pageSnapshot("example:local", { hasMore: false, presentExternalIds: [] }, log(), assessed);
    expect(assessed).toHaveBeenLastCalledWith();
  });
  test("a whole-source snapshot on the final page is forwarded", () => {
    const l = log();
    expect(pageSnapshot("apple-notes", { hasMore: false, presentExternalIds: ["a"] }, l)).toEqual({
      presentExternalIds: ["a"],
    });
    expect(l.error).not.toHaveBeenCalled();
  });

  test("claims on the final page are forwarded", () => {
    const claims = [{ partition: "books/home", ids: ["a"] }];
    expect(
      pageSnapshot("apple-contacts", { hasMore: false, presentClaims: claims }, log()),
    ).toEqual({ presentClaims: claims });
  });

  test("a page that says nothing forwards nothing, silently", () => {
    const l = log();
    expect(pageSnapshot("apple-notes", { hasMore: false }, l)).toEqual({});
    expect(l.error).not.toHaveBeenCalled();
  });

  test("a partial page's snapshot is refused and named in the log", () => {
    // It names a fraction of what exists, so acting on it deletes the rest.
    const l = log();
    expect(pageSnapshot("apple-notes", { hasMore: true, presentExternalIds: ["a"] }, l)).toEqual(
      {},
    );
    expect(l.error).toHaveBeenCalledOnce();
    expect(vi.mocked(l.error).mock.calls[0][0]).toContain("apple-notes");
  });

  test("a partial page's claims are refused for the same reason", () => {
    const l = log();
    expect(
      pageSnapshot(
        "apple-contacts",
        { hasMore: true, presentClaims: [{ partition: "books/home", ids: [] }] },
        l,
      ),
    ).toEqual({});
    expect(vi.mocked(l.error).mock.calls[0][0]).toContain("partial page");
  });

  test("both shapes at once is refused rather than one of them chosen", () => {
    const l = log();
    expect(
      pageSnapshot(
        "apple-contacts",
        {
          hasMore: false,
          presentExternalIds: ["a"],
          presentClaims: [{ partition: "books/home", ids: ["a"] }],
        },
        l,
      ),
    ).toEqual({});
    expect(vi.mocked(l.error).mock.calls[0][0]).toContain("two answers");
  });

  test("an empty claim list is still an assertion", () => {
    // The source read no partitions and says so. It reconciles nothing, but it
    // is a completed enumeration and carries an observation id.
    const snapshot = pageSnapshot("apple-contacts", { hasMore: false, presentClaims: [] }, log());
    expect(snapshot).toEqual({ presentClaims: [] });
    expect(assertsPresence(snapshot)).toBe(true);
  });

  test("a document in a partition the page did not claim refuses the claim", () => {
    // The document would never be reachable by any sweep: no claim names its
    // partition, so nothing ever judges it. Silent, and permanent.
    const l = log();
    expect(
      pageSnapshot(
        "apple-contacts",
        {
          hasMore: false,
          presentClaims: [{ partition: "books/home", ids: ["a"] }],
          documents: [{ partitionKey: "books/work" }],
        },
        l,
      ),
    ).toEqual({});
    expect(vi.mocked(l.error).mock.calls[0][0]).toContain("books/work");
  });

  test("documents in the claimed partitions are fine", () => {
    const claims = [
      { partition: "books/home", ids: ["a"] },
      { partition: "books/work", ids: ["b"] },
    ];
    const l = log();
    expect(
      pageSnapshot(
        "apple-contacts",
        {
          hasMore: false,
          presentClaims: claims,
          documents: [{ partitionKey: "books/home" }, { partitionKey: "books/work" }],
        },
        l,
      ),
    ).toEqual({ presentClaims: claims });
    expect(l.error).not.toHaveBeenCalled();
  });

  test("an unstamped document is in the unnamed partition, and needs it claimed", () => {
    // The commonest way to get this wrong: adopt claims, forget the key. Every
    // document then sits in `""`, which the claims do not name.
    const l = log();
    expect(
      pageSnapshot(
        "apple-contacts",
        {
          hasMore: false,
          presentClaims: [{ partition: "books/home", ids: ["a"] }],
          documents: [{}],
        },
        l,
      ),
    ).toEqual({});
    expect(l.error).toHaveBeenCalledOnce();
  });

  test("a whole-source snapshot is not held to the claim rule", () => {
    const l = log();
    expect(
      pageSnapshot(
        "apple-notes",
        { hasMore: false, presentExternalIds: ["a"], documents: [{ partitionKey: "anything" }] },
        l,
      ),
    ).toEqual({ presentExternalIds: ["a"] });
    expect(l.error).not.toHaveBeenCalled();
  });

  test("nothing asserted carries no observation", () => {
    expect(assertsPresence(pageSnapshot("apple-notes", { hasMore: false }, log()))).toBe(false);
  });
});
