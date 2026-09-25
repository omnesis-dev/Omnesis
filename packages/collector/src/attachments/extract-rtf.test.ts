// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { extractRtfText } from "./extract-rtf.js";

const enc = (value: string) => new TextEncoder().encode(value);

describe("extractRtfText", () => {
  test("extracts paragraphs and tabs from simple RTF", () => {
    const result = extractRtfText(
      enc(String.raw`{\rtf1\ansi project brief\par owner:\tab unit alpha\par status: ready}`),
    );

    expect(result).not.toBeNull();
    expect(result!.text).toContain("project brief");
    expect(result!.text).toContain("owner:\tunit alpha");
    expect(result!.text).toContain("status: ready");
    expect(result!.truncated).toBe(false);
  });

  test("decodes unicode escapes and skips fallback characters", () => {
    const result = extractRtfText(enc(String.raw`{\rtf1\ansi Caf\u233? review}`));

    expect(result).not.toBeNull();
    expect(result!.text).toContain("Cafe review".replace("e", "é"));
    expect(result!.text).not.toContain("?");
  });

  test("replaces malformed unicode escapes instead of throwing", () => {
    const result = extractRtfText(enc(String.raw`{\rtf1\ansi Bad codepoint \u999999? after}`));

    expect(result).not.toBeNull();
    expect(result!.text).toContain("Bad codepoint");
    expect(result!.text).toContain("after");
    expect(result!.text).not.toContain("?");
  });

  test("ignores font tables and pictures", () => {
    const result = extractRtfText(
      enc(
        String.raw`{\rtf1{\fonttbl{\f0 hiddenfont;}}Visible text{\*\generator hidden}{\pict abcdef}}`,
      ),
    );

    expect(result).not.toBeNull();
    expect(result!.text).toContain("Visible text");
    expect(result!.text).not.toContain("hiddenfont");
    expect(result!.text).not.toContain("abcdef");
    expect(result!.text).not.toContain("hidden");
  });

  test("truncates at maxTextLength", () => {
    const result = extractRtfText(enc(`{\\rtf1 ${"long text ".repeat(80)}}`), {
      maxTextLength: 32,
    });

    expect(result).not.toBeNull();
    expect(result!.text.length).toBeLessThanOrEqual(32);
    expect(result!.truncated).toBe(true);
  });

  test("empty data returns null", () => {
    expect(extractRtfText(new Uint8Array(0))).toBeNull();
  });

  test("control-only RTF returns null", () => {
    expect(extractRtfText(enc(String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}}`))).toBeNull();
  });
});
