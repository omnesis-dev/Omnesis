// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { isExactDupe, isSameThread, shouldSuppress, type FilterDocMeta } from "./edge-filters.js";

const baseEmail = (overrides: Partial<FilterDocMeta> = {}): FilterDocMeta => ({
  contentHash: null,
  extractedContentHash: null,
  docType: "email",
  threadId: null,
  ...overrides,
});

describe("isExactDupe", () => {
  it("matches when content hashes agree", () => {
    const a = baseEmail({ contentHash: "deadbeef" });
    const b = baseEmail({ contentHash: "deadbeef" });
    expect(isExactDupe(a, b)).toBe(true);
  });
  it("matches when extracted-content hashes agree (and content hashes differ)", () => {
    const a = baseEmail({ contentHash: "AAA", extractedContentHash: "EXTRACTED" });
    const b = baseEmail({ contentHash: "BBB", extractedContentHash: "EXTRACTED" });
    expect(isExactDupe(a, b)).toBe(true);
  });
  it("does not match when hashes differ", () => {
    const a = baseEmail({ contentHash: "x" });
    const b = baseEmail({ contentHash: "y" });
    expect(isExactDupe(a, b)).toBe(false);
  });
  it("does not match on null hashes (no false positive on missing data)", () => {
    expect(isExactDupe(baseEmail(), baseEmail())).toBe(false);
  });
});

describe("isSameThread", () => {
  it("matches two emails with the same threadId", () => {
    const a = baseEmail({ threadId: "T1" });
    const b = baseEmail({ threadId: "T1" });
    expect(isSameThread(a, b)).toBe(true);
  });
  it("does not match if either side is not an email", () => {
    const email = baseEmail({ threadId: "T1" });
    const attachment: FilterDocMeta = { ...email, docType: "attachment" };
    expect(isSameThread(email, attachment)).toBe(false);
  });
  it("does not match on null thread IDs", () => {
    expect(isSameThread(baseEmail(), baseEmail())).toBe(false);
  });
  it("does not match on differing thread IDs", () => {
    const a = baseEmail({ threadId: "T1" });
    const b = baseEmail({ threadId: "T2" });
    expect(isSameThread(a, b)).toBe(false);
  });
});

describe("shouldSuppress", () => {
  it("prefers exact-dupe reason when both rules fire", () => {
    const a = baseEmail({ contentHash: "x", threadId: "T1" });
    const b = baseEmail({ contentHash: "x", threadId: "T1" });
    expect(shouldSuppress(a, b)).toBe("exact-dupe");
  });
  it("falls through to same-thread when only that rule fires", () => {
    const a = baseEmail({ contentHash: "x", threadId: "T1" });
    const b = baseEmail({ contentHash: "y", threadId: "T1" });
    expect(shouldSuppress(a, b)).toBe("same-thread");
  });
  it("returns null when neither rule fires", () => {
    expect(
      shouldSuppress(baseEmail({ contentHash: "x" }), baseEmail({ contentHash: "y" })),
    ).toBeNull();
  });
});
