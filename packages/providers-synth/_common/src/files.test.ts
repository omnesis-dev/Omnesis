// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { materializeSyntheticFiles } from "./files.js";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "synthetic-materializer-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
describe("isolated synthetic input files", () => {
  test("unchanged contents retain mtime for real source incremental scans", () => {
    const path = materializeSyntheticFiles(root, "fixture", [
      { path: "notes/sample.txt", content: "Invented sample text" },
    ]);
    const at = statSync(join(path, "notes/sample.txt")).mtimeMs;
    materializeSyntheticFiles(root, "fixture", [
      { path: "notes/sample.txt", content: "Invented sample text" },
    ]);
    expect(readFileSync(join(path, "notes/sample.txt"), "utf8")).toBe("Invented sample text");
    expect(statSync(join(path, "notes/sample.txt")).mtimeMs).toBe(at);
  });
  test("removed fixtures retire only previously owned files", () => {
    const path = materializeSyntheticFiles(root, "fixture", [
      { path: "retired.txt", content: "Invented old input" },
    ]);
    materializeSyntheticFiles(root, "fixture", []);
    expect(existsSync(join(path, "retired.txt"))).toBe(false);
  });
  test.each(["../escape", "/absolute", "nested/../escape", ".", "nested//file"])(
    "rejects escaping or ambiguous path %s",
    (path) => {
      expect(() =>
        materializeSyntheticFiles(root, "fixture", [{ path, content: "forbidden" }]),
      ).toThrow();
    },
  );
  test("existing symlink cannot redirect a file write outside owned tree", () => {
    const path = materializeSyntheticFiles(root, "fixture", []);
    symlinkSync(root, join(path, "redirect"));
    expect(() =>
      materializeSyntheticFiles(root, "fixture", [
        { path: "redirect/escape.txt", content: "forbidden" },
      ]),
    ).toThrow("owned directory");
  });
  test("missing state dir refuses operator-default fallback", () => {
    expect(() => materializeSyntheticFiles(undefined, "fixture", [])).toThrow(
      "host state directory",
    );
  });
});
