// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  PRIVATE_UMASK,
  SecretPathUnreadableError,
  applyPrivateUmask,
  ensurePrivateDirSync,
  ensurePrivateFileSync,
  secretPathExists,
} from "./security-files.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("security file helpers", () => {
  test("ensurePrivateDirSync creates and tightens a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-secure-dir-"));
    dirs.push(root);
    const dir = join(root, "state");
    ensurePrivateDirSync(dir);
    expect(statSync(dir).mode & 0o777).toBe(PRIVATE_DIR_MODE);
  });

  test("ensurePrivateFileSync tightens an existing file", () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-secure-file-"));
    dirs.push(root);
    const file = join(root, "token");
    writeFileSync(file, "omn_test\n", { mode: 0o644 });
    ensurePrivateFileSync(file);
    expect(statSync(file).mode & 0o777).toBe(PRIVATE_FILE_MODE);
  });

  test("applyPrivateUmask sets umask 077 and returns the previous value", () => {
    const before = process.umask();
    try {
      process.umask(0o022);
      const previous = applyPrivateUmask();
      expect(previous).toBe(0o022);
      expect(process.umask()).toBe(PRIVATE_UMASK);
    } finally {
      process.umask(before);
    }
  });
});

describe("secretPathExists", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    const dirs = scratchDirs.splice(0);
    // Re-open every recorded directory before removing any of them: a nested
    // one left at 0000 makes the recursive removal of its parent fail.
    for (const dir of dirs) {
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* already traversable */
      }
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-secret-path-"));
    scratchDirs.push(dir);
    return dir;
  }

  // Root ignores the mode bits this fixture relies on.
  const asUnprivilegedUser = (process.getuid?.() ?? 0) !== 0;

  test("answers present and absent for paths it can see", () => {
    const dir = scratch();
    const file = join(dir, "key");
    expect(secretPathExists(file)).toBe(false);
    writeFileSync(file, "sealed");
    expect(secretPathExists(file)).toBe(true);
  });

  test("treats a path under a non-directory as absent", () => {
    // ENOTDIR is proven absence: nothing can exist below a regular file.
    const dir = scratch();
    const file = join(dir, "key");
    writeFileSync(file, "sealed");
    expect(secretPathExists(join(file, "nested"))).toBe(false);
  });

  test("answers absent for a dangling symlink rather than refusing", () => {
    // The regression this guard must not become: a healthy install whose paths
    // simply are not there has to stay cheap and quiet. A broken symlink is the
    // shape most likely to be mistaken for an error.
    const dir = scratch();
    const link = join(dir, "link");
    symlinkSync(join(dir, "nowhere"), link);
    expect(secretPathExists(link)).toBe(false);
  });

  test.skipIf(!asUnprivilegedUser)("refuses to answer when it may not look", () => {
    // The distinction the whole guard rests on: `existsSync` reports this exact
    // file as absent, which for key material reads as "nothing was ever armed".
    const dir = scratch();
    const inner = join(dir, "keyring");
    mkdirSync(inner);
    const file = join(inner, "key");
    writeFileSync(file, "sealed");
    chmodSync(inner, 0o000);
    scratchDirs.push(inner);

    expect(existsSync(file)).toBe(false);
    expect(() => secretPathExists(file)).toThrow(SecretPathUnreadableError);
    try {
      secretPathExists(file);
    } catch (err) {
      expect((err as SecretPathUnreadableError).path).toBe(file);
      expect((err as Error).message).toContain(file);
    }
  });
});
