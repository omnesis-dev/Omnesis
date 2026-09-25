// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { computeContentDiff, DEFAULT_CONTENT_DIFF_LIMITS } from "./diff.js";

describe("computeContentDiff", () => {
  test("identical bodies yield no diff", () => {
    expect(computeContentDiff("a\nb\nc", "a\nb\nc")).toBeNull();
  });

  test("a localized edit produces one hunk with context", () => {
    const before = ["intro", "line one", "line two", "line three", "outro"].join("\n");
    const after = ["intro", "line one", "line 2 edited", "line three", "outro"].join("\n");
    const diff = computeContentDiff(before, after)!;
    expect(diff).toContain("-line two");
    expect(diff).toContain("+line 2 edited");
    expect(diff).toContain(" line one");
    expect(diff).toContain(" line three");
    expect(diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/);
    // Untouched far-away lines never appear.
    expect(diff.split("\n").some((l) => l.endsWith("intro") && l.startsWith("-"))).toBe(false);
  });

  test("pure insertion produces only + lines", () => {
    const before = ["a", "b"].join("\n");
    const after = ["a", "new line", "b"].join("\n");
    const diff = computeContentDiff(before, after)!;
    expect(diff).toContain("+new line");
    expect(diff).not.toContain("-a");
    expect(diff).not.toContain("-b");
  });

  test("two distant edits produce two hunks", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const beforeArr = [...lines];
    const afterArr = [...lines];
    afterArr[3] = "line 3 changed";
    afterArr[35] = "line 35 changed";
    const diff = computeContentDiff(beforeArr.join("\n"), afterArr.join("\n"))!;
    expect(diff.match(/@@ /g)?.length).toBe(2);
    expect(diff).toContain("-line 3");
    expect(diff).toContain("+line 3 changed");
    expect(diff).toContain("+line 35 changed");
  });

  test("oversized input yields null (no diff, agent reads the doc)", () => {
    const big = "x".repeat(DEFAULT_CONTENT_DIFF_LIMITS.maxInputBytes + 1);
    expect(computeContentDiff(big, "small")).toBeNull();
    expect(computeContentDiff("small", big)).toBeNull();
  });

  test("too many lines yields null", () => {
    const many = Array.from(
      { length: DEFAULT_CONTENT_DIFF_LIMITS.maxInputLines + 1 },
      (_, i) => `${i}`,
    ).join("\n");
    expect(computeContentDiff(many, "one")).toBeNull();
  });

  test("a huge changed middle degrades to a replace hunk instead of exact LCS", () => {
    const n = DEFAULT_CONTENT_DIFF_LIMITS.maxLcsLines + 10;
    const before = Array.from({ length: n }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: n }, (_, i) => `new ${i}`).join("\n");
    const diff = computeContentDiff(before, after)!;
    expect(diff).toContain("-old 0");
    expect(diff).toContain("+new 0");
  });

  test("oversized output is truncated with a marker", () => {
    const before = Array.from({ length: 300 }, (_, i) => `old line ${i}`).join("\n");
    const after = Array.from({ length: 300 }, (_, i) => `new line ${i}`).join("\n");
    const diff = computeContentDiff(before, after, {
      ...DEFAULT_CONTENT_DIFF_LIMITS,
      maxOutputBytes: 512,
    })!;
    expect(Buffer.byteLength(diff, "utf8")).toBeLessThan(512 + 64);
    expect(diff).toContain("[diff truncated]");
  });

  test("a diff spanning two sequential edits contains both", () => {
    // The fold path recomputes from the FIRST snapshot vs the LATEST
    // body — assert a v0→v2 diff carries both edits.
    const v0 = ["title", "alpha", "beta", "gamma", "delta", "epsilon"].join("\n");
    const v2 = ["title", "alpha edited", "beta", "gamma", "delta", "epsilon appended"].join("\n");
    const diff = computeContentDiff(v0, v2)!;
    expect(diff).toContain("+alpha edited");
    expect(diff).toContain("+epsilon appended");
  });
});
