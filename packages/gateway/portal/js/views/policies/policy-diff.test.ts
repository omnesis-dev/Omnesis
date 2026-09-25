// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

// @ts-expect-error — portal modules are intentionally plain JavaScript.
import { characterDiff, compactPolicyDiff, policyDiff, policyDiffPage } from "./policy-diff.js";

describe("privacy policy diff", () => {
  test("keeps line numbers while marking added and removed lines", () => {
    const rows = policyDiff("first\nold\nlast", "first\nnew\nlast");
    expect(rows).toMatchObject([
      { kind: "same", oldLine: 1, newLine: 1, text: "first" },
      { kind: "remove", oldLine: 2, newLine: null, text: "old" },
      { kind: "add", oldLine: null, newLine: 2, text: "new" },
      { kind: "same", oldLine: 3, newLine: 3, text: "last" },
    ]);
  });

  test("identifies character-level changes inside a replaced line", () => {
    const changes = characterDiff("exact detail", "summary detail");
    expect(changes.some((part: { kind: string }) => part.kind === "remove")).toBe(true);
    expect(changes.some((part: { kind: string }) => part.kind === "add")).toBe(true);
    expect(changes.filter((part: { kind: string }) => part.kind !== "add").map((part: { value: string }) => part.value).join(""))
      .toBe("exact detail");
    expect(changes.filter((part: { kind: string }) => part.kind !== "remove").map((part: { value: string }) => part.value).join(""))
      .toBe("summary detail");
  });

  test("falls back safely for large dissimilar documents", () => {
    const before = Array.from({ length: 1_000 }, (_, index) => `before ${index}`).join("\n");
    const after = Array.from({ length: 1_000 }, (_, index) => `after ${index}`).join("\n");
    const rows = policyDiff(before, after);
    expect(rows.filter((row: { kind: string }) => row.kind === "remove")).toHaveLength(1_000);
    expect(rows.filter((row: { kind: string }) => row.kind === "add")).toHaveLength(1_000);
  });

  test("paginates a 64k diff without hiding changed rows", () => {
    const before = Array.from({ length: 16_000 }, (_, index) => `before ${index}`).join("\n").slice(0, 64_000);
    const after = Array.from({ length: 16_000 }, (_, index) => `after ${index}`).join("\n").slice(0, 64_000);
    const compact = compactPolicyDiff(before, after);
    const pages = Array.from(
      { length: policyDiffPage(before, after).totalPages },
      (_, page) => policyDiffPage(before, after, page).rows,
    ).flat();
    expect(pages).toEqual(compact);
    expect(pages.filter((row: { kind: string }) => row.kind === "add")).toHaveLength(
      policyDiff(before, after).filter((row: { kind: string }) => row.kind === "add").length,
    );

    const spans = characterDiff("a".repeat(32_000), "b".repeat(32_000));
    expect(spans).toHaveLength(2);
  });

  test("preserves Unicode characters in the bounded fallback", () => {
    const before = `${"🙂".repeat(250)}old${"🚀".repeat(250)}`;
    const after = `${"🙂".repeat(250)}new${"🚀".repeat(250)}`;
    const changes = characterDiff(before, after);
    expect(changes.filter((part: { kind: string }) => part.kind !== "add").map((part: { value: string }) => part.value).join(""))
      .toBe(before);
    expect(changes.filter((part: { kind: string }) => part.kind !== "remove").map((part: { value: string }) => part.value).join(""))
      .toBe(after);
  });
});
