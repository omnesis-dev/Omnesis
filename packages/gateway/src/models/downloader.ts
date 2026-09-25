// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Resumable, sha-verifying GGUF downloader.
 *
 * Behaviour:
 *   - Stream the response into `<filename>.partial`. If a partial file
 *     exists, re-issue the request with `Range: bytes=N-` and append.
 *   - Compute SHA-256 incrementally as bytes land. When the catalog
 *     entry pins a sha (`entry.sha256`), reject on mismatch — pinned
 *     hashes are part of the bundled-catalog supply-chain story.
 *   - When the catalog doesn't pin (a forward-compat allowance), record
 *     the computed sha into the manifest so future verifications have a
 *     fixed point.
 *   - Atomic rename `.partial` → final on success; remove on cancel or
 *     failure (caller asks for a clean retry).
 *   - One progress callback fires on each chunk (no internal throttle).
 *     The gateway throttles by buffering and emitting every 250ms over
 *     the WS bus — keeps progress UIs smooth without flooding clients.
 *
 * Concurrency: a single Downloader instance runs one download at a
 * time. The caller (ModelManager) tracks active downloads in a map
 * keyed by catalog id, so multiple ids can run in parallel from
 * separate Downloader instances.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash, type Hash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { GgufCatalogEntry } from "@omnesis/core";

export interface DownloadProgress {
  /** Bytes already on disk after this chunk. */
  downloadedBytes: number;
  /** Total expected bytes (from catalog or Content-Length). */
  totalBytes: number;
  /** Bytes/second over the lifetime of this attempt. */
  speedBytesPerSec: number;
  /** Best-effort ETA in milliseconds; -1 when total is unknown. */
  etaMs: number;
}

export interface DownloadHandle {
  /** Promise that resolves with the computed sha256 (hex) on success. */
  done: Promise<{ sha256: string; sizeBytes: number; downloadedFrom: string }>;
  /** Cancel the download; cleans up the `.partial` file. */
  abort(): void;
}

export interface DownloadOptions {
  /** Base directory in which to write `<filename>` and `<filename>.partial`. */
  modelsDir: string;
  /** Fired on every chunk. The caller throttles to WS as needed. */
  onProgress: (progress: DownloadProgress) => void;
}

export class DownloadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

/**
 * Start a download for the given catalog entry. Returns a handle whose
 * `done` promise resolves with the manifest-ready metadata, or rejects
 * with a `DownloadError` whose `code` is one of:
 *   `network`, `http_status`, `sha_mismatch`, `aborted`, `disk`.
 */
export function startDownload(entry: GgufCatalogEntry, opts: DownloadOptions): DownloadHandle {
  const controller = new AbortController();
  const finalPath = join(opts.modelsDir, entry.filename);
  const partialPath = `${finalPath}.partial`;
  const startedAt = Date.now();

  const done = (async () => {
    mkdirSync(opts.modelsDir, { recursive: true });

    // Resume: if a partial exists, send Range and seed the running hash
    // with its bytes. We compute the prefix sha here so the final hash
    // covers the whole file even after a resume — without this, a
    // resumed download would only hash the bytes it actually fetched.
    let resumeFrom = 0;
    let runningHash: Hash = createHash("sha256");
    if (existsSync(partialPath)) {
      const size = statSync(partialPath).size;
      if (size > 0 && size < entry.sizeBytes) {
        await hashExistingPartial(partialPath, runningHash);
        resumeFrom = size;
      } else if (size >= entry.sizeBytes) {
        // Stale `.partial` — bigger than catalog says it should be. Start over.
        unlinkSync(partialPath);
        runningHash = createHash("sha256");
      }
    }

    const headers: Record<string, string> = {
      "User-Agent": "omnesis-gateway/model-downloader",
    };
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

    let res: Response;
    try {
      res = await fetch(entry.downloadUrl, { headers, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new DownloadError("aborted", "download cancelled");
      }
      throw new DownloadError(
        "network",
        `failed to start download: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok && res.status !== 206) {
      throw new DownloadError(
        "http_status",
        `download responded ${res.status} ${res.statusText} for ${entry.downloadUrl}`,
      );
    }
    if (!res.body) {
      throw new DownloadError("network", "response had no body");
    }

    const contentLength = Number(res.headers.get("content-length") ?? "0");
    const totalBytes = entry.sizeBytes || contentLength + resumeFrom;
    let downloadedBytes = resumeFrom;

    const out = createWriteStream(partialPath, { flags: resumeFrom > 0 ? "a" : "w" });
    const source = Readable.fromWeb(res.body as never);

    // Push chunks through the running hash + progress reporter while
    // the pipeline copies them to disk. Doing this with a Transform
    // would be cleaner, but a "before pipeline" tap keeps the hot path
    // free of allocations — a 1.5 GB GGUF makes the difference visible.
    source.on("data", (chunk: Buffer) => {
      runningHash.update(chunk);
      downloadedBytes += chunk.byteLength;
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      const speedBytesPerSec = ((downloadedBytes - resumeFrom) / elapsedMs) * 1000;
      const etaMs =
        totalBytes > 0 && speedBytesPerSec > 0
          ? Math.round(((totalBytes - downloadedBytes) / speedBytesPerSec) * 1000)
          : -1;
      opts.onProgress({ downloadedBytes, totalBytes, speedBytesPerSec, etaMs });
    });

    try {
      await pipeline(source, out);
    } catch (err) {
      try {
        unlinkSync(partialPath);
      } catch {
        /* best-effort */
      }
      if (controller.signal.aborted) {
        throw new DownloadError("aborted", "download cancelled");
      }
      throw new DownloadError(
        "network",
        `download interrupted: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const sha256 = runningHash.digest("hex");
    if (entry.sha256 && entry.sha256 !== sha256) {
      try {
        unlinkSync(partialPath);
      } catch {
        /* best-effort */
      }
      throw new DownloadError(
        "sha_mismatch",
        `sha256 mismatch for ${entry.filename}: catalog=${entry.sha256} downloaded=${sha256}`,
      );
    }

    try {
      renameSync(partialPath, finalPath);
    } catch (err) {
      throw new DownloadError(
        "disk",
        `failed to finalise ${entry.filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const sizeBytes = statSync(finalPath).size;
    return { sha256, sizeBytes, downloadedFrom: entry.downloadUrl };
  })();

  return {
    done,
    abort: () => controller.abort(),
  };
}

async function hashExistingPartial(path: string, hash: Hash): Promise<void> {
  // Stream-pipe the file into the hash so we keep bounded memory even on
  // a multi-gig GGUF. Resolves once the stream's `end` fires; rejects if
  // any read errors.
  const stream = createReadStream(path);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
}

/** For tests: hash an existing file from start to end. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await hashExistingPartial(path, hash);
  return hash.digest("hex");
}

/**
 * Best-effort cleanup of a half-finished download. Used by the manager
 * when a startup notices a `.partial` file with no in-progress
 * download (e.g. gateway crashed mid-fetch).
 *
 * Safe to call when the file doesn't exist.
 */
export function clearPartial(modelsDir: string, filename: string): void {
  const path = join(modelsDir, `${filename}.partial`);
  try {
    unlinkSync(path);
  } catch {
    /* best-effort */
  }
  // Make sure parent exists so a fresh download can write into it.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* best-effort */
  }
}
