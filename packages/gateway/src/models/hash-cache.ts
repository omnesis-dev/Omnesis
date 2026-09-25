// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Remembers the sha256 of a model file across gateway boots.
 *
 * Adopting a model into a fresh manifest reads the whole file to hash it, and a
 * model file is hundreds of megabytes. The cost is paid once per *config
 * directory*, and a config directory is exactly what a test spins up — so a
 * lane that boots dozens of isolated gateways against one shared model file
 * re-derives the same digest dozens of times. What that costs depends entirely
 * on the machine: a fraction of a second on a fast NVMe with the file already
 * in the page cache, seconds on a loaded box or a slower disk, and the boot
 * cannot serve `/health` until it finishes either way.
 *
 * The digest is a property of the file, not of the config directory that found
 * it, so the cache is keyed on the file's identity — its real path, size and
 * mtime — and lives outside any config directory. A file that changed under any
 * of those three misses the cache and is hashed again, which is the whole
 * invalidation rule: a rewritten model produces a different size or a newer
 * mtime, and a same-size same-mtime rewrite is a filesystem the gateway could
 * not detect by any means short of re-reading it.
 *
 * Every failure here is non-fatal. The cache is an optimisation over a
 * computation that is always available, so an unreadable, unwritable or
 * corrupt cache costs time and nothing else.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger } from "@omnesis/core";

const log = createLogger("gateway:models").child("hash-cache");

/** What a cache file records about the file it stands for. */
interface CachedHash {
  /** The real path hashed, so a key collision cannot serve the wrong digest. */
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

/**
 * Where cache entries live: one file per model file, under the user's cache
 * directory rather than a config directory.
 *
 * Deliberately not inside the models directory. A test instance points at its
 * own config directory and reaches the real model through a symlink; writing
 * the cache beside the model would mean a test writing into the operator's
 * live installation, and writing it beside the symlink would cache nothing,
 * since that directory is thrown away with the test.
 *
 * `OMNESIS_MODEL_HASH_CACHE_DIR` overrides it, for a test that wants a
 * hermetic cache of its own.
 */
export function modelHashCacheDir(): string {
  const override = process.env.OMNESIS_MODEL_HASH_CACHE_DIR;
  if (override) return override;
  const base =
    process.env.XDG_CACHE_HOME ??
    (homedir() ? join(homedir(), ".cache") : join(tmpdir(), ".cache"));
  return join(base, "omnesis", "model-hashes");
}

/** One file per hashed path — concurrent boots never contend on one document. */
function entryPath(realPath: string): string {
  const key = createHash("sha256").update(realPath).digest("hex").slice(0, 32);
  return join(modelHashCacheDir(), `${key}.json`);
}

function readEntry(file: string): CachedHash | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { path, sizeBytes, mtimeMs, sha256 } = parsed as Partial<CachedHash>;
    if (typeof path !== "string" || typeof sha256 !== "string") return null;
    if (typeof sizeBytes !== "number" || typeof mtimeMs !== "number") return null;
    return { path, sizeBytes, mtimeMs, sha256 };
  } catch {
    // Absent, unreadable, or half-written by a boot that died mid-rename.
    return null;
  }
}

/**
 * Write via a uniquely-named temp file and one rename, so a reader either sees
 * the previous entry or this one — never a partial document. Several gateways
 * booting at once each write their own temp file and the last rename wins,
 * which is fine: they all computed the same digest.
 */
function writeEntry(file: string, entry: CachedHash): void {
  try {
    mkdirSync(modelHashCacheDir(), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(entry)}\n`, "utf8");
    renameSync(temp, file);
  } catch (err) {
    log.warn(
      `could not cache the digest for ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The sha256 of `path`, from cache when the file is unchanged since it was
 * last hashed, otherwise computed with `hashFile` and remembered.
 *
 * `hashFile` is injected rather than imported so this module stays free of the
 * downloader's streaming machinery, and so a test can prove that a cache hit
 * really did skip the read.
 */
export async function sha256WithCache(
  path: string,
  hashFile: (path: string) => Promise<string>,
): Promise<string> {
  let realPath: string;
  let stat: { size: number; mtimeMs: number };
  try {
    realPath = realpathSync(path);
    stat = statSync(realPath);
  } catch {
    // Cannot identify the file, so cannot key on it. Hash what was asked for
    // and let the caller's own error handling deal with an unreadable path.
    return hashFile(path);
  }

  const file = entryPath(realPath);
  const cached = readEntry(file);
  if (
    cached &&
    cached.path === realPath &&
    cached.sizeBytes === stat.size &&
    cached.mtimeMs === stat.mtimeMs
  ) {
    log.info(`digest for ${realPath} read from cache (${cached.sha256.slice(0, 12)}…)`);
    return cached.sha256;
  }

  const sha256 = await hashFile(path);
  writeEntry(file, { path: realPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, sha256 });
  return sha256;
}
