// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Atomic file writes with parent-directory fsync.
 *
 * Posix `rename(2)` is atomic, but a system crash between the rename
 * and the next implicit flush can lose either the new file or the
 * rename of an existing file — the directory entry can end up pointing
 * at no-content or stale content. The robust pattern is:
 *
 *   1. Write the payload to a scratch file next to `path`.
 *   2. fsync the scratch file's fd (durable on stable storage).
 *   3. rename scratch → path (atomic substitution within a filesystem).
 *   4. fsync the parent directory's fd (durable rename).
 *
 * On Windows step 4 can fail (directory fsync isn't supported); we
 * swallow that error rather than fail the write — the rest of the
 * sequence still gives us "scratch is durable, then atomic
 * substitution", which is strictly better than a bare writeFileSync.
 *
 * The scratch file gets a name unique to the individual write, never a
 * fixed `${path}.tmp` shared by every writer. Concurrent writes to one
 * path are routine here: an OAuth token cache is rewritten from each
 * in-flight API call, and the collector fans those calls out across
 * sources and workers. A shared scratch name makes them interleave
 * destructively — one writer renames the scratch file away while
 * another is still fsync'ing or chmod'ing it, and the loser fails with
 * a spurious ENOENT on a file it created moments earlier. Per-write
 * names reduce the interleaving to a last-writer-wins rename, which is
 * what an atomic write promises in the first place. A write that fails
 * removes its own scratch file so a transient error doesn't litter the
 * directory; a write killed outright (SIGKILL, power loss) cannot, and
 * leaves an orphan behind — see #53 for the boot-time sweep.
 *
 * Used by every credential, secret, certificate and config-file writer
 * in the tree — all of them want "if the user re-auths and pulls the
 * plug seconds later, the new file is durable, not the old one
 * resurrected."
 */

import { randomBytes } from "node:crypto";
import {
  openSync,
  fsyncSync,
  closeSync,
  writeFileSync,
  renameSync,
  fchmodSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { open, rename, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  writeWindowsPrivateFileAtomic,
  writeWindowsPrivateFileAtomicSync,
} from "./windows-private-file.js";

export interface AtomicWriteOptions {
  /** File mode to apply to the final file. */
  mode?: number;
  /** When true, mkdir the parent dir recursively first. Default: false. */
  ensureDir?: boolean;
}

/**
 * Scratch path for one write. The `omnesis` marker makes an orphan left
 * by a killed process attributable and sweepable without a regex that
 * could match a user's own file. The pid disambiguates processes sharing
 * the config tree (gateway, collector, CLI) and the random suffix
 * disambiguates concurrent writes within one process — worker threads
 * share a pid, so the random half is load-bearing, not belt-and-braces.
 */
function scratchPath(path: string): string {
  return `${path}.omnesis-${process.pid.toString(36)}${randomBytes(6).toString("hex")}.tmp`;
}

/**
 * Sync version. Writes to a scratch file, fsyncs, renames, then fsyncs
 * the parent dir.
 */
export function atomicWriteFileSync(
  path: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): void {
  if (opts.ensureDir) {
    mkdirSync(dirname(path), { recursive: true });
  }
  if (process.platform === "win32" && opts.mode != null && (opts.mode & 0o077) === 0) {
    writeWindowsPrivateFileAtomicSync(path, typeof data === "string" ? Buffer.from(data) : data, {
      readOnly: (opts.mode & 0o200) === 0,
    });
    return;
  }
  const tmp = scratchPath(path);
  let created = false;
  try {
    // Windows FlushFileBuffers requires a writable handle. Keep the handle
    // that created the scratch file through the flush on every platform.
    // Exclusive creation never truncates another writer's scratch file.
    const fd = openSync(tmp, "wx", opts.mode);
    created = true;
    try {
      writeFileSync(fd, data);
      if (opts.mode != null) fchmodSync(fd, opts.mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    if (created) discardScratchSync(tmp);
    throw err;
  }
  fsyncDirSync(dirname(path));
}

/**
 * Async version. Same shape as `atomicWriteFileSync`.
 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  if (opts.ensureDir) {
    await mkdir(dirname(path), { recursive: true });
  }
  if (process.platform === "win32" && opts.mode != null && (opts.mode & 0o077) === 0) {
    await writeWindowsPrivateFileAtomic(path, typeof data === "string" ? Buffer.from(data) : data, {
      readOnly: (opts.mode & 0o200) === 0,
    });
    return;
  }
  const tmp = scratchPath(path);
  let created = false;
  try {
    const handle = await open(tmp, "wx", opts.mode);
    created = true;
    try {
      await handle.writeFile(data);
      if (opts.mode != null) await handle.chmod(opts.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    if (created) await discardScratch(tmp);
    throw err;
  }
  await fsyncDir(dirname(path));
}

function discardScratchSync(tmp: string): void {
  try {
    unlinkSync(tmp);
  } catch {
    // Nothing to clean up (the write never got as far as creating it),
    // or the directory is gone. The original error is the one to report.
  }
}

async function discardScratch(tmp: string): Promise<void> {
  try {
    await unlink(tmp);
  } catch {
    // See `discardScratchSync` above.
  }
}

/** Flush a file's contents to stable storage. Throws if the flush fails. */
export function fsyncFileSync(path: string): void {
  const fd = openSync(path, process.platform === "win32" ? "r+" : "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Flush directory entries; strict callers retain recovery intent when a supported sync fails. */
export function fsyncDirSync(dir: string, opts: { strict?: boolean } = {}): void {
  // Directory fsync is unsupported on Windows. Skip silently — the
  // file is already durable, only the rename atomicity is at risk.
  if (process.platform === "win32") return;
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch (error) {
    if (opts.strict) throw error;
    return;
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    // Some filesystem types (FAT-on-USB, certain FUSE backends) reject
    // fsync on directory fds. The write itself is already durable.
    if (opts.strict) throw error;
  } finally {
    closeSync(fd);
  }
}

export async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(dir, "r");
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // See `fsyncDirSync` above.
  } finally {
    await handle.close();
  }
}
