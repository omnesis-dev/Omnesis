// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { normalizeContent } from "./normalize.js";

describe("normalizeContent", () => {
  test("strips zero-width non-joiners (ZWNJ U+200C)", () => {
    const input = "hello‌ ‌world‌";
    expect(normalizeContent(input)).toBe("hello world");
  });

  test("strips zero-width joiners (ZWJ U+200D)", () => {
    expect(normalizeContent("a‍b")).toBe("ab");
  });

  test("strips zero-width spaces (ZWS U+200B)", () => {
    expect(normalizeContent("foo​bar")).toBe("foobar");
  });

  test("strips soft hyphens (U+00AD)", () => {
    expect(normalizeContent("some­word")).toBe("someword");
  });

  test("strips combining grapheme joiner (U+034F)", () => {
    expect(normalizeContent("te͏st")).toBe("test");
  });

  test("strips word joiner (U+2060)", () => {
    expect(normalizeContent("no⁠break")).toBe("nobreak");
  });

  test("strips BOM (U+FEFF)", () => {
    expect(normalizeContent("﻿content")).toBe("content");
  });

  test("handles marketing email padding pattern", () => {
    const padding = " ‌​ ".repeat(50);
    const input = `Subject line${padding}Actual content`;
    const result = normalizeContent(input);
    expect(result).not.toContain("‌");
    expect(result).not.toContain("​");
    expect(result).toContain("Subject line");
    expect(result).toContain("Actual content");
  });

  test("collapses long whitespace runs to double-space", () => {
    expect(normalizeContent("a     b")).toBe("a  b");
    expect(normalizeContent("a          b")).toBe("a  b");
  });

  test("preserves single and double spaces", () => {
    expect(normalizeContent("a b")).toBe("a b");
    expect(normalizeContent("a  b")).toBe("a  b");
  });

  test("collapses 4+ blank lines to 3", () => {
    expect(normalizeContent("a\n\n\n\n\nb")).toBe("a\n\n\nb");
  });

  test("preserves up to 3 newlines", () => {
    expect(normalizeContent("a\n\n\nb")).toBe("a\n\n\nb");
  });

  test("preserves newlines within whitespace collapse", () => {
    expect(normalizeContent("a\n  \n  b")).toBe("a\n  \n  b");
  });

  test("returns empty string unchanged", () => {
    expect(normalizeContent("")).toBe("");
  });

  test("returns null/undefined unchanged", () => {
    expect(normalizeContent(null as unknown as string)).toBe(null);
    expect(normalizeContent(undefined as unknown as string)).toBe(undefined);
  });

  test("normal text passes through unchanged", () => {
    const text = "Hello world, this is a normal email.\n\nBest regards,\nJamie";
    expect(normalizeContent(text)).toBe(text);
  });

  test("strips NUL and C0 control characters", () => {
    const c = (...n: number[]) => String.fromCharCode(...n);
    expect(normalizeContent("a" + c(0) + "b" + c(1) + "c" + c(8) + "d")).toBe("abcd");
    expect(normalizeContent("x" + c(11, 12) + "y")).toBe("xy");
    expect(normalizeContent("p" + c(31) + "q")).toBe("pq");
  });

  test("strips DEL and C1 control characters", () => {
    const c = (...n: number[]) => String.fromCharCode(...n);
    expect(normalizeContent("a" + c(127) + "b" + c(128) + "c" + c(159) + "d")).toBe("abcd");
  });

  test("preserves tab, newline, and carriage return", () => {
    expect(normalizeContent("a\tb")).toBe("a\tb");
    expect(normalizeContent("a\nb")).toBe("a\nb");
    expect(normalizeContent("a\r\nb")).toBe("a\r\nb");
  });

  test("strips a lone high surrogate", () => {
    expect(normalizeContent("a\uD800b")).toBe("ab");
  });

  test("strips a lone low surrogate", () => {
    expect(normalizeContent("a\uDC00b")).toBe("ab");
  });

  test("preserves valid surrogate pairs (emoji)", () => {
    const emoji = "tea \u{1F375} time"; // 🍵
    expect(normalizeContent(emoji)).toBe(emoji);
  });

  test("preserves valid surrogate pairs (astral script)", () => {
    const astral = "deseret \u{10400}\u{10401}"; // 𐐀𐐁
    expect(normalizeContent(astral)).toBe(astral);
  });

  test("preserves accented and CJK text", () => {
    const text = "café résumé — 日本語のテキスト, naïve";
    expect(normalizeContent(text)).toBe(text);
  });

  test("strips a high surrogate left bare next to a valid pair", () => {
    // Lone high surrogate, then a valid pair — only the lone one goes.
    const input = "x\uD83Cy\u{1F375}z";
    expect(normalizeContent(input)).toBe("xy\u{1F375}z");
  });
});
