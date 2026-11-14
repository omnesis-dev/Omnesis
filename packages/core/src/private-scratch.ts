// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirSync, ensurePrivateDirs } from "./security-files.js";
import type { Stats } from "node:fs";

export interface PrivateScratch {
  path: string;
  cleanup(): void;
}

export interface AsyncPrivateScratch {
  path: string;
  cleanup(): Promise<void>;
}

function scratchRoot(namespace: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) throw new Error("Invalid scratch namespace");
  return join(tmpdir(), `omnesis-owned-scratch-${process.getuid?.() ?? "user"}`);
}

function validateRoot(info: Stats): void {
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()) ||
    (process.platform !== "win32" && (info.mode & 0o777) !== 0o700)
  )
    throw new Error("Unsafe private scratch directory");
}

function* deadOwnerEntries(names: readonly string[]): Generator<string> {
  for (const name of names) {
    const match = /^([1-9][0-9]*)-[a-zA-Z0-9_-]+$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid > 2147483647) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") yield name;
    }
  }
}

/**
 * Plaintext working space, private to the current OS user. The caller owns its
 * lifetime and must clean up after all readers/writers stop (including workers).
 * Recovery only removes directories whose owning process is certainly gone.
 * Reused PIDs and permission-denied probes are deliberately retained; this is
 * not secure erasure and does not protect against the same user or root.
 */
export function createPrivateScratch(namespace: string): PrivateScratch {
  const root = scratchRoot(namespace);
  mkdirSync(root, { mode: 0o700, recursive: true });
  validateRoot(lstatSync(root));

  // Windows ignores POSIX modes. Secure the parent before any scratch child
  // can inherit access controls or receive plaintext snapshots.
  if (process.platform === "win32") ensurePrivateDirSync(root);

  // Names are immutable and never reused; concurrent recovery is idempotent.
  for (const name of deadOwnerEntries(readdirSync(root)))
    rmSync(join(root, name), { recursive: true, force: true });
  const path = mkdtempSync(join(root, `${process.pid}-${namespace}-`));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** Prepare private plaintext scratch without blocking a request on Windows ACL setup. */
export async function createPrivateScratchAsync(namespace: string): Promise<AsyncPrivateScratch> {
  const root = scratchRoot(namespace);
  await mkdir(root, { mode: 0o700, recursive: true });
  validateRoot(await lstat(root));
  if (process.platform === "win32") await ensurePrivateDirs([root]);
  for (const name of deadOwnerEntries(await readdir(root)))
    await rm(join(root, name), { recursive: true, force: true });
  const path = await mkdtemp(join(root, `${process.pid}-${namespace}-`));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
