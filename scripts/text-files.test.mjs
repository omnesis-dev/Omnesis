// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every source file in the repo has to be readable as text.
 *
 * A single literal control byte — a NUL used as a map-key separator, say —
 * makes git classify the whole file as binary. It then shows no diff for any
 * change to that file, and `grep` skips it silently rather than reporting it.
 * A reviewer sees "1 file changed" with nothing under it, and a search for the
 * symbol they are checking returns nothing, so both of the habits that would
 * catch a mistake there stop working at once. An audit that greps the tree is
 * simply blind to the file.
 *
 * Escapes carry the same value without the consequence: `"\\u0000"` is the byte
 * the runtime wants and the four characters git can diff.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");

/** Extensions whose files are source we author and read as text. */
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".gradle",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".mts",
  ".py",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

/**
 * Third-party bundles we vendor verbatim. Their bytes are upstream's business;
 * rewriting them would defeat the point of vendoring a known artifact.
 */
const isVendored = (file) => file.split(path.sep).includes("vendor");

/**
 * Tab, newline and carriage return are the legitimate control characters in a
 * text file; anything else below 0x20, plus DEL, makes it binary.
 */
const isBinaryByte = (byte) =>
  byte < 9 || byte === 11 || byte === 12 || (byte >= 14 && byte <= 31) || byte === 127;

function trackedTextFiles() {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split("\0")
    .filter(Boolean)
    .filter((file) => TEXT_EXTENSIONS.has(path.extname(file)))
    .filter((file) => !isVendored(file));
}

describe("tracked source files", () => {
  const files = trackedTextFiles();

  it("finds files to check", () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it("contain no literal control bytes, so git and grep treat them as text", () => {
    const offenders = files.filter((file) => {
      let bytes;
      try {
        bytes = readFileSync(path.join(ROOT, file));
      } catch {
        // Tracked but not present in this checkout (a sparse or partial
        // worktree). Nothing to judge.
        return false;
      }
      return bytes.some(isBinaryByte);
    });
    expect(
      offenders,
      "write the byte as an escape (`\\u0000`) instead of embedding it literally",
    ).toEqual([]);
  });
});
