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
  chmodSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { open, writeFile, rename, chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

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
 * `wx` fails rather than truncating if the scratch name is somehow
 * already taken, so a name collision surfaces as EEXIST instead of two
 * writes silently corrupting one another's payload.
 */
function scratchWriteOptions(opts: AtomicWriteOptions): { flag: "wx"; mode?: number } {
  return opts.mode != null ? { flag: "wx", mode: opts.mode } : { flag: "wx" };
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
  const tmp = scratchPath(path);
  if (opts.ensureDir) {
    mkdirSync(dirname(path), { recursive: true });
  }
  try {
    // writeFileSync handles open+write+close internally — but we then
    // need to re-open to fsync. The double-open is unavoidable on the
    // sync path without dropping to fs.openSync ourselves.
    writeFileSync(tmp, data, scratchWriteOptions(opts));
    if (opts.mode != null) {
      // umask can mask the mode on some systems; force.
      chmodSync(tmp, opts.mode);
    }
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    discardScratchSync(tmp);
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
  const tmp = scratchPath(path);
  if (opts.ensureDir) {
    await mkdir(dirname(path), { recursive: true });
  }
  try {
    await writeFile(tmp, data, scratchWriteOptions(opts));
    if (opts.mode != null) {
      await chmod(tmp, opts.mode);
    }
    const handle = await open(tmp, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await discardScratch(tmp);
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

function fsyncDirSync(dir: string): void {
  // Directory fsync is unsupported on Windows. Skip silently — the
  // file is already durable, only the rename atomicity is at risk.
  if (process.platform === "win32") return;
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Some filesystem types (FAT-on-USB, certain FUSE backends) reject
    // fsync on directory fds. The write itself is already durable.
  } finally {
    closeSync(fd);
  }
}

async function fsyncDir(dir: string): Promise<void> {
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
