// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { cutoffMs, isOmatelCursor, planPage } from "./group-sync.js";

const current = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("planPage", () => {
  it("renders every group on a first run", () => {
    const plan = planPage(null, current({ b: "2", a: "1" }), 1, 10);

    expect(plan).toMatchObject({ render: ["a", "b"], removed: [], hasMore: false, dirty: true });
    expect(plan.next).toEqual({ render: 1, groups: { a: "1", b: "2" } });
  });

  it("renders changed and new groups, removes missing ones, keeps the rest", () => {
    const plan = planPage(
      { render: 1, groups: { a: "1", b: "2", c: "3" } },
      current({ a: "1", b: "changed", d: "4" }),
      1,
      10,
    );

    expect(plan.render).toEqual(["b", "d"]);
    expect(plan.removed).toEqual(["c"]);
    expect(plan.next.groups).toEqual({ a: "1", b: "changed", d: "4" });
  });

  it("is clean when nothing changed", () => {
    const plan = planPage({ render: 1, groups: { a: "1" } }, current({ a: "1" }), 1, 10);

    expect(plan).toMatchObject({ render: [], removed: [], hasMore: false, dirty: false });
  });

  it("carries a cycle's change across pages until its last one", () => {
    const first = planPage(null, current({ a: "1", b: "2", c: "3" }), 1, 2);
    expect(first).toMatchObject({ render: ["a", "b"], hasMore: true });
    expect(first.next.dirty).toBe(true);

    const second = planPage(first.next, current({ a: "1", b: "2", c: "3" }), 1, 2);
    expect(second).toMatchObject({ render: ["c"], hasMore: false, dirty: true });
    expect(second.next.dirty).toBeUndefined();
  });

  it("starts over when the rendering version changed", () => {
    const plan = planPage({ render: 1, groups: { a: "1" } }, current({ a: "1" }), 2, 10);

    expect(plan.render).toEqual(["a"]);
    expect(plan.removed).toEqual([]);
  });
});

describe("isOmatelCursor", () => {
  it("accepts the stored shape and refuses anything else", () => {
    expect(isOmatelCursor({ render: 1, groups: { a: "0a1b" } })).toBe(true);
    expect(isOmatelCursor({ render: 1, groups: {}, dirty: true })).toBe(true);
    expect(isOmatelCursor({ render: 1, groups: { a: 7 } })).toBe(false);
    expect(isOmatelCursor({ render: "1", groups: {} })).toBe(false);
    expect(isOmatelCursor({ render: 1, groups: [] })).toBe(false);
    expect(isOmatelCursor({ render: 1, groups: {}, dirty: false })).toBe(false);
    expect(isOmatelCursor(null)).toBe(false);
  });
});

describe("cutoffMs", () => {
  it("reads an ISO cutoff and ignores a missing or unreadable one", () => {
    expect(cutoffMs("2026-03-04T00:00:00.000Z")).toBe(Date.UTC(2026, 2, 4));
    expect(cutoffMs(undefined)).toBe(0);
    expect(cutoffMs("not a date")).toBe(0);
  });
});
