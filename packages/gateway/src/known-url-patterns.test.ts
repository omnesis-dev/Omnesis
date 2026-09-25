// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import {
  getKnownUrlPatterns,
  getKnownUrlPatternSources,
  knownUrlPatternsReady,
  resetKnownUrlPatterns,
  setExpectedKnownUrlPatternDeclarers,
  setKnownUrlPatterns,
} from "./known-url-patterns.js";

describe("known-url-patterns registry", () => {
  afterEach(() => {
    // The set is process-level module state; reset so tests don't leak into
    // each other or into pipeline tests that read the live registry.
    resetKnownUrlPatterns();
  });

  test("starts empty before any collector push", () => {
    expect(getKnownUrlPatterns()).toHaveLength(0);
  });

  test("setKnownUrlPatterns compiles case-insensitive regexes", () => {
    setKnownUrlPatterns("test", [{ regex: "notion\\.so/([a-f0-9]{32})$" }]);
    const patterns = getKnownUrlPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].regex.test("https://NOTION.so/0123456789abcdef0123456789abcdef")).toBe(true);
    expect(patterns[0].regex.test("https://example.com/article")).toBe(false);
  });

  test("re-pushing fully replaces the previous set", () => {
    setKnownUrlPatterns("test", [{ regex: "a\\.example\\.com" }]);
    setKnownUrlPatterns("test", [{ regex: "b\\.example\\.com" }]);
    const patterns = getKnownUrlPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].regex.test("https://b.example.com/x")).toBe(true);
    expect(patterns[0].regex.test("https://a.example.com/x")).toBe(false);
  });

  test("merges declarations while replacement remains isolated to one collector", () => {
    setKnownUrlPatterns("collector-a", [{ regex: "a\\.example\\.com" }]);
    setKnownUrlPatterns("collector-b", [{ regex: "b\\.example\\.com" }]);
    setKnownUrlPatterns("collector-a", [{ regex: "a2\\.example\\.com" }]);

    expect(getKnownUrlPatternSources()).toEqual(["a2\\.example\\.com", "b\\.example\\.com"]);
  });

  test("stays unready until every paired collector has declared", () => {
    setExpectedKnownUrlPatternDeclarers(["collector-a", "collector-b"]);
    setKnownUrlPatterns("collector-a", [{ regex: "a\\.example\\.com" }]);
    expect(knownUrlPatternsReady()).toBe(false);

    setKnownUrlPatterns("collector-b", [{ regex: "b\\.example\\.com" }]);
    expect(knownUrlPatternsReady()).toBe(true);
    expect(getKnownUrlPatternSources()).toEqual(["a\\.example\\.com", "b\\.example\\.com"]);
  });

  test("rejects an invalid replacement atomically", () => {
    setKnownUrlPatterns("test", [{ regex: "valid\\.example\\.com" }]);
    expect(() =>
      setKnownUrlPatterns("test", [
        { regex: "replacement\\.example\\.com" },
        { regex: "(unclosed" },
      ]),
    ).toThrow();
    const patterns = getKnownUrlPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].regex.test("https://valid.example.com/x")).toBe(true);
    expect(patterns[0].regex.test("https://replacement.example.com/x")).toBe(false);
  });

  test("overlapping repetition is linear-time under the RE2 matcher", () => {
    setKnownUrlPatterns("test", [{ regex: "(a|aa)+$" }]);
    const matcher = getKnownUrlPatterns()[0].regex;
    const started = performance.now();
    expect(matcher.test(`${"a".repeat(10_000)}b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("prunes declarations that no longer belong to the active roster", () => {
    setKnownUrlPatterns("collector-a", [{ regex: "a\\.example" }]);
    setKnownUrlPatterns("collector-b", [{ regex: "b\\.example" }]);
    setExpectedKnownUrlPatternDeclarers(["collector-a"]);
    expect(getKnownUrlPatternSources()).toEqual(["a\\.example"]);
  });

  test("getKnownUrlPatternSources returns the pushed strings verbatim", () => {
    // `RegExp.source` re-escapes forward slashes, so the registry keeps the
    // original string for a faithful round-trip on the debug GET.
    setKnownUrlPatterns("test", [{ regex: "notion\\.so/([a-f0-9]{32})$" }]);
    expect(getKnownUrlPatternSources()).toEqual(["notion\\.so/([a-f0-9]{32})$"]);
  });
});
