// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PrivateScratch {
  path: string;
  cleanup(): void;
}

/**
 * Plaintext working space, private to the current OS user. The caller owns its
 * lifetime and must clean up after all readers/writers stop (including workers).
 * Recovery only removes directories whose owning process is certainly gone.
 * Reused PIDs and permission-denied probes are deliberately retained; this is
 * not secure erasure and does not protect against the same user or root.
 */
export function createPrivateScratch(namespace: string): PrivateScratch {
  if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) throw new Error("Invalid scratch namespace");
  const root = join(tmpdir(), `omnesis-owned-scratch-${process.getuid?.() ?? "user"}`);
  mkdirSync(root, { mode: 0o700, recursive: true });
  const info = lstatSync(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()) ||
    (process.platform !== "win32" && (info.mode & 0o777) !== 0o700)
  )
    throw new Error("Unsafe private scratch directory");

  for (const name of readdirSync(root)) {
    const match = /^([1-9][0-9]*)-[a-zA-Z0-9_-]+$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid > 2147483647) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      // Names are immutable and never reused; concurrent recovery is idempotent.
      rmSync(join(root, name), { recursive: true, force: true });
    }
  }
  const path = mkdtempSync(join(root, `${process.pid}-${namespace}-`));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
