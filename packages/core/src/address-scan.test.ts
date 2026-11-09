// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  addressMatches,
  splitAddressParenName,
  splitNameAngleAddress,
  withoutClosingBracketTail,
} from "./address-scan.js";

const OLD_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const OLD_ANGLE = /^(.+?)\s*<([^>]*)>$/;
const OLD_PAREN = /^([^\s(]+@[^\s(]+)\s*\((.+?)\)$/;
const OLD_TAIL = />.*$/;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomStrings(alphabet: string[], count: number, maxLength: number, seed: number) {
  const next = seeded(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = Math.floor(next() * (maxLength + 1));
    let s = "";
    for (let j = 0; j < length; j += 1) s += alphabet[Math.floor(next() * alphabet.length)];
    out.push(s);
  }
  return out;
}

function elapsedMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

const TIME_BOUND_MS = 1_000;
const RUN = 200_000;

describe("addressMatches", () => {
  test("finds what the expression it replaces finds", () => {
    const alphabet = ["a", "b", "Z", "7", ".", ".", "-", "_", "%", "+", "@", "@", " ", "/", "é"];
    for (const text of randomStrings(alphabet, 20_000, 24, 1)) {
      const expected = [...text.matchAll(OLD_EMAIL)].map((m) => ({ index: m.index, match: m[0] }));
      expect(addressMatches(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  test("finds ordinary addresses in prose", () => {
    const text = "Write to maya.reeves@example.com, cc ops+alerts@mail.example.org.";
    expect(addressMatches(text)).toEqual([
      { index: 9, match: "maya.reeves@example.com" },
      { index: 37, match: "ops+alerts@mail.example.org" },
    ]);
  });

  test.each([
    ["a run of dots", ".".repeat(RUN)],
    ["a run of hyphens", "-".repeat(RUN)],
    ["a huge local part with no @", "x".repeat(RUN)],
    ["a huge local part before a domain with no TLD", `${"x".repeat(RUN)}@${"-.".repeat(RUN / 2)}`],
    ["an @ before a long numeric dotted run", `x@${"1.".repeat(RUN / 2)}`],
    ["alternating local characters and @", "a@".repeat(RUN / 2)],
    ["dots between every @", ".@".repeat(RUN / 2)],
  ])("stays linear on %s", (_label, text) => {
    expect(elapsedMs(() => addressMatches(text))).toBeLessThan(TIME_BOUND_MS);
  });
});

describe("splitNameAngleAddress", () => {
  test("splits what the expression it replaces splits", () => {
    const alphabet = ["a", "Z", "@", ".", "<", "<", ">", ">", " ", "\t", "\n", '"', "(", ")"];
    for (const text of randomStrings(alphabet, 20_000, 14, 2)) {
      const m = text.match(OLD_ANGLE);
      const expected = m ? { name: m[1], inner: m[2] } : null;
      expect(splitNameAngleAddress(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  test.each([
    ["a header full of <", `a${"<".repeat(RUN)}x`],
    ["a name of whitespace before the address", `a${" ".repeat(RUN)}x>`],
  ])("stays linear on %s", (_label, text) => {
    expect(elapsedMs(() => splitNameAngleAddress(text))).toBeLessThan(TIME_BOUND_MS);
  });
});

describe("splitAddressParenName", () => {
  test("splits what the expression it replaces splits", () => {
    const alphabet = ["a", "Z", "@", "@", ".", "(", "(", ")", ")", " ", "\n", "<", ">"];
    for (const text of randomStrings(alphabet, 20_000, 14, 3)) {
      const m = text.match(OLD_PAREN);
      const expected = m ? { address: m[1], name: m[2] } : null;
      expect(splitAddressParenName(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  test("stays linear on a header full of @", () => {
    const text = `${"@".repeat(RUN)}x`;
    expect(elapsedMs(() => splitAddressParenName(text))).toBeLessThan(TIME_BOUND_MS);
  });
});

describe("withoutClosingBracketTail", () => {
  test("cuts what the expression it replaces cuts", () => {
    const alphabet = ["a", "@", ".", ">", ">", "<", " ", "\n", "\r", " "];
    for (const text of randomStrings(alphabet, 20_000, 14, 4)) {
      expect(withoutClosingBracketTail(text), JSON.stringify(text)).toBe(
        text.replace(OLD_TAIL, ""),
      );
    }
  });

  test("stays linear on a line of > before a line break", () => {
    const text = `a@example.com${">".repeat(RUN)}\nx`;
    expect(elapsedMs(() => withoutClosingBracketTail(text))).toBeLessThan(TIME_BOUND_MS);
  });
});
