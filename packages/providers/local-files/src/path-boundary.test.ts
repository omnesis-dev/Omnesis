// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { posix, win32 } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { containsLocalPath, sameLocalPath, type BoundaryEntry } from "./path-boundary.js";

const declared = "C:\\Invented\\Docs";
const alternate = "C:\\Invented\\docs";
function options(same: boolean, blocked?: string) {
  const readEntry = vi.fn((path: string): BoundaryEntry => {
    if (path === blocked) return { kind: "link" };
    return { kind: "directory", identity: path === alternate && !same ? "42:8" : "42:7" };
  });
  return { platform: "win32" as const, readEntry };
}

describe("canonical local file boundaries", () => {
  test("Windows case-distinct sibling roots are outside even when relative() equates them", () => {
    expect(win32.relative(declared, alternate)).toBe("");
    expect(containsLocalPath(declared, `${alternate}\\private.txt`, options(false))).toBe(false);
  });
  test("the same directory identity preserves default Windows case-only spellings", () => {
    const opts = options(true);
    expect(containsLocalPath(declared, `${alternate}\\note.txt`, opts)).toBe(true);
    expect(opts.readEntry.mock.calls.some(([path]) => path.endsWith("note.txt"))).toBe(false);
    expect(sameLocalPath(declared, alternate, "directory", opts)).toBe(true);
  });
  test("case-only roots redirected through a parent junction are not accepted by final-entry identity", () => {
    expect(
      containsLocalPath(declared, `${alternate}\\private.txt`, options(true, "C:\\Invented")),
    ).toBe(false);
  });
  test("an observed root junction cannot pass a root-change check", () => {
    expect(sameLocalPath(declared, alternate, "directory", options(true, declared))).toBe(false);
  });
  test("unverifiable case-only root identity fails closed", () => {
    const readEntry = () => {
      throw Object.assign(new Error("Invented denied metadata"), { code: "EACCES" });
    };
    expect(
      containsLocalPath(declared, `${alternate}\\private.txt`, { platform: "win32", readEntry }),
    ).toBe(false);
  });
  test("exact canonical paths keep their lexical fast path", () => {
    const readEntry = vi.fn();
    expect(
      containsLocalPath(declared, `${declared}\\note.txt`, { platform: "win32", readEntry }),
    ).toBe(true);
    expect(readEntry).not.toHaveBeenCalled();
    expect(
      containsLocalPath(declared, "D:\\Invented\\note.txt", { platform: "win32", readEntry }),
    ).toBe(false);
  });
  test.each(["linux", "darwin"] as const)(
    "preserves %s case and literal backslashes",
    (platform) => {
      const root = "/invented/Docs";
      expect(containsLocalPath(root, "/invented/docs/private.txt", { platform })).toBe(false);
      expect(containsLocalPath(root, posix.join(root, "literal\\name.txt"), { platform })).toBe(
        true,
      );
      expect(
        sameLocalPath("/invented/literal\\name", "/invented/literal/name", "file", { platform }),
      ).toBe(false);
    },
  );
});
