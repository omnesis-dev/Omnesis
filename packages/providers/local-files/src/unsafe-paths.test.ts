// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createUnsafePathMatcher } from "./unsafe-paths.js";

const root = join(process.cwd(), "invented-folders");
const refused = join(root, "foo");
const previous = join(root, "Foo");
const file = join(previous, "note.txt");

describe("refused local alias prefixes", () => {
  test.each(["linux", "darwin"] as const)(
    "keeps exact %s spelling and avoids metadata reads",
    (platform) => {
      const read = vi.fn();
      const matches = createUnsafePathMatcher([refused], platform, read);
      expect(matches(join(refused, "note.txt"))).toBe(true);
      expect(matches(file)).toBe(false);
      expect(read).not.toHaveBeenCalled();
    },
  );

  test("an exact Windows alias spelling also needs no metadata lookup", () => {
    const read = vi.fn();
    expect(createUnsafePathMatcher([refused], "win32", read)(join(refused, "note.txt"))).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  test("default Windows case-only spelling retains the same alias by exact identity", () => {
    const read = vi.fn((path: string) => {
      expect([previous, refused]).toContain(path);
      return "42:9007199254740992";
    });
    const matches = createUnsafePathMatcher([refused], "win32", read);
    expect(matches(file)).toBe(true);
    expect(matches(join(previous, "sibling.txt"))).toBe(true);
    expect(read.mock.calls.map(([path]) => path)).toEqual([previous, refused]);
  });

  test("case-sensitive sibling identities stay distinct even when Number IDs collide", () => {
    const first = 9_007_199_254_740_992n;
    const second = first + 1n;
    expect(Number(first)).toBe(Number(second));
    const read = vi.fn((path: string) => `42:${path === refused ? first : second}`);
    expect(createUnsafePathMatcher([refused], "win32", read)(file)).toBe(false);
    expect(read.mock.calls.map(([path]) => path)).toEqual([previous, refused]);
  });

  test.each(["ENOENT", "ENOTDIR"])(
    "a truly absent prior prefix (%s) does not inherit its sibling's refusal",
    (code) => {
      const read = vi.fn(() => {
        throw Object.assign(new Error("Invented missing folder"), { code });
      });
      expect(createUnsafePathMatcher([refused], "win32", read)(file)).toBe(false);
    },
  );

  test.each(["EACCES", "EIO"])(
    "unverifiable case-only prefix (%s) conservatively retains only that prefix",
    (code) => {
      const read = vi.fn(() => {
        throw Object.assign(new Error("Invented unavailable metadata"), { code });
      });
      const matches = createUnsafePathMatcher([refused], "win32", read);
      expect(matches(file)).toBe(true);
      expect(matches(join(root, "unrelated", "gone.txt"))).toBe(false);
    },
  );

  test("unverifiable refused-entry identity remains conservative after a readable prior spelling", () => {
    const read = (path: string) => {
      if (path === refused)
        throw Object.assign(new Error("Invented metadata failure"), { code: "EIO" });
      return "42:7";
    };
    expect(createUnsafePathMatcher([refused], "win32", read)(file)).toBe(true);
  });
});
