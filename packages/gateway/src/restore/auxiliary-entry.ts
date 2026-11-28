// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { WATCH_JOURNAL_FILENAME, GATEWAY_ANALYTICS_STORE_FILE } from "@omnesis/core";
import { streamRestoredEntry, type SealedRestoreEntry } from "./entry-stream.js";
import { authenticateSqlCipherPages } from "./sqlcipher-page-auth.js";
import { authenticateDuckDbBlocks } from "./auxiliary-duckdb-auth.js";
import {
  rebuildRestoredWatchDatabase,
  type AuxiliaryRestoreResult,
  type RestoredAuxiliarySource,
} from "./auxiliary-watch.js";
import { rebuildRestoredAnalyticsDatabase } from "./auxiliary-analytics.js";

export interface RestoredAuxiliaryEntryOptions {
  kind: "watch" | "analytics";
  entry: SealedRestoreEntry;
  sourceKey: Buffer | null;
  sourceCipherPath: string;
  destinationPath: string;
  destinationKey: Buffer;
  signal?: AbortSignal;
}
/** Owned worker only. No plaintext source database or unverified ciphertext block reaches disk. */
export async function restoreAuxiliaryEntry(
  options: RestoredAuxiliaryEntryOptions,
): Promise<AuxiliaryRestoreResult> {
  const logical = options.entry.logicalName.replace(/\.enc$/, "");
  if (
    logical !== (options.kind === "watch" ? WATCH_JOURNAL_FILENAME : GATEWAY_ANALYTICS_STORE_FILE)
  )
    throw new Error("The auxiliary database entry does not match its declared store");
  const signal = options.signal ?? new AbortController().signal;
  const stream = streamRestoredEntry(options.entry, signal),
    iterator = stream[Symbol.asyncIterator]();
  let prefix = Buffer.alloc(0);
  while (prefix.length < 28) {
    const next = await iterator.next();
    if (next.done) break;
    prefix = Buffer.concat([prefix, next.value]);
  }
  const replay = (async function* () {
    try {
      if (prefix.length) yield prefix;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      await iterator.return();
    }
  })();
  const plaintext =
    options.kind === "watch"
      ? prefix.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))
      : prefix.length >= 28 &&
        prefix.subarray(8, 12).toString("ascii") === "DUCK" &&
        (prefix.readBigUInt64LE(20) & 1n) === 0n;
  const use = (source: RestoredAuxiliarySource) =>
    options.kind === "watch"
      ? rebuildRestoredWatchDatabase({
          ...source,
          destinationPath: options.destinationPath,
          destinationKey: options.destinationKey,
          signal,
        })
      : rebuildRestoredAnalyticsDatabase({
          ...source,
          destinationPath: options.destinationPath,
          destinationKey: options.destinationKey,
          signal,
        });
  if (plaintext) {
    let bytes = 0,
      image: Buffer | undefined;
    const chunks: Buffer[] = [];
    try {
      for await (const block of replay) {
        signal.throwIfAborted();
        bytes += block.length;
        if (bytes > 64 * 1024 ** 2)
          throw new Error("Legacy auxiliary database exceeds the memory-only restore limit");
        chunks.push(block);
      }
      image = Buffer.concat(chunks);
      return await use({ sourceImage: image });
    } finally {
      image?.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
  }
  if (!options.sourceKey || options.sourceKey.length !== 32) {
    await iterator.return();
    throw new Error("The auxiliary backup encryption key is unavailable");
  }
  let owned: { dev: bigint; ino: bigint } | undefined;
  let result: AuxiliaryRestoreResult | undefined;
  let failed = false,
    operationFailure: unknown;
  try {
    const file = await open(
      options.sourceCipherPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const identity = await file.stat({ bigint: true });
      owned = { dev: identity.dev, ino: identity.ino };
      const authenticated =
        options.kind === "watch"
          ? authenticateSqlCipherPages(replay, options.sourceKey, signal)
          : authenticateDuckDbBlocks(replay, options.sourceKey, signal);
      for await (const ciphertext of authenticated) await file.writeFile(ciphertext);
      await file.sync();
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    result = await use({ sourcePath: options.sourceCipherPath, sourceKey: options.sourceKey });
  } catch (error) {
    failed = true;
    operationFailure = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await iterator.return();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (owned) {
    try {
      const info = await lstat(options.sourceCipherPath, { bigint: true });
      if (!info.isFile() || info.dev !== owned.dev || info.ino !== owned.ino)
        throw new Error("The auxiliary restore staging file changed ownership");
      await unlink(options.sourceCipherPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failed ? [operationFailure, ...cleanupErrors] : cleanupErrors,
      "The owned auxiliary restore cleanup did not finish",
    );
  if (failed) throw operationFailure;
  if (!result) throw new Error("The owned auxiliary restore did not finish");
  return result;
}
