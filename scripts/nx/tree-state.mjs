// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: options.encoding ?? "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function nul(args) {
  const value = git([...args, "-z"]);
  return value ? value.split("\0").filter(Boolean) : [];
}

function nameStatusFiles(args) {
  const records = nul(["diff", "--name-status", "--find-renames", ...args]);
  const files = [];
  for (let index = 0; index < records.length; index += 2) {
    const status = records[index];
    const path = records[index + 1];
    if (!status || !path) throw new Error("Git returned a malformed name-status record");
    files.push(path);
    if (/^[RC]/.test(status)) {
      const destination = records[index + 2];
      if (!destination) throw new Error("Git returned a rename without a destination");
      files.push(destination);
      index += 1;
    }
  }
  return files;
}

export function resolveBase(base) {
  try {
    return git(["merge-base", base, "HEAD"]).trim();
  } catch {
    throw new Error(
      `Cannot resolve merge base for ${base}. Fetch it or choose an available --base; selection will not continue with an empty plan.`,
    );
  }
}

export function changedFiles(base) {
  const mergeBase = resolveBase(base);
  const files = new Set(nameStatusFiles(["--diff-filter=ACDMRTUXB", mergeBase, "HEAD"]));
  for (const args of [["--diff-filter=ACDMRTUXB"], ["--cached", "--diff-filter=ACDMRTUXB"]])
    for (const file of nameStatusFiles(args)) files.add(file);
  for (const file of nul(["ls-files", "--others", "--exclude-standard"])) files.add(file);
  return { mergeBase, files: [...files].sort() };
}

function currentEntry(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    // A removed directory may now be a file, making its former children ENOTDIR.
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  }
}

export function treeFingerprint(base) {
  const { mergeBase, files } = changedFiles(base);
  const hash = createHash("sha256");
  hash.update(`base\0${mergeBase}\0head\0${git(["rev-parse", "HEAD"]).trim()}\0`);
  hash.update(git(["diff", "--binary"]));
  hash.update(git(["diff", "--cached", "--binary"]));
  for (const file of files) {
    hash.update(`${file}\0`);
    const stat = currentEntry(file);
    // Git tracks the link itself. Canonical files are fingerprinted separately;
    // following a directory link would try to read a directory as a file.
    if (stat?.isSymbolicLink()) hash.update(`symlink\0${readlinkSync(file)}`);
    else if (stat) hash.update(readFileSync(file));
    else hash.update("<deleted>");
    hash.update("\0");
  }
  return { mergeBase, files, fingerprint: hash.digest("hex") };
}

export function assertTreeFingerprint(base, expected) {
  const actual = treeFingerprint(base).fingerprint;
  if (actual !== expected)
    throw new Error(
      `Checkout inputs changed after planning (${expected.slice(0, 12)} -> ${actual.slice(0, 12)}). Re-run checks:plan/checks:affected.`,
    );
}
