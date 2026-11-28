// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { streamRestoredEntry, type SealedRestoreEntry } from "./entry-stream.js";
export type { SealedRestoreEntry } from "./entry-stream.js";
import { authenticateSqlCipherPages } from "./sqlcipher-page-auth.js";
import {
  reconcileRestoredMainDatabase,
  inspectRestoredMainDatabase,
  type RestoredMainDatabase,
  type RestoredMainSource,
  type RestoredMainInspection,
} from "./main-database.js";

export interface RestoredMainEntryOptions {
  entry: SealedRestoreEntry;
  sourceKey: Buffer | null;
  targetPath: string;
  targetKey: Buffer;
  sourceCipherPath: string;
  destinationPath: string;
  destinationKey: Buffer;
}

export type RestoredEntryInspectionOptions = Pick<
  RestoredMainEntryOptions,
  "entry" | "sourceKey" | "sourceCipherPath"
>;
export async function inspectRestoredMainEntry(
  options: RestoredEntryInspectionOptions,
): Promise<RestoredMainInspection> {
  return withMainSource(options, (source) => inspectRestoredMainDatabase(source));
}
/** Owned worker only: every persisted input page is authenticated ciphertext. */
export async function reconcileRestoredMainEntry(
  options: RestoredMainEntryOptions,
): Promise<RestoredMainDatabase> {
  return withMainSource(options, (source) =>
    reconcileRestoredMainDatabase({
      ...source,
      targetPath: options.targetPath,
      targetKey: options.targetKey,
      destinationPath: options.destinationPath,
      destinationKey: options.destinationKey,
    }),
  );
}
async function withMainSource<T>(
  options: RestoredEntryInspectionOptions,
  use: (source: RestoredMainSource) => T,
): Promise<T> {
  const signal = new AbortController().signal;
  const source = streamRestoredEntry(options.entry, signal),
    iterator = source[Symbol.asyncIterator]();
  let prefix = Buffer.alloc(0);
  while (prefix.length < 16) {
    const next = await iterator.next();
    if (next.done) break;
    prefix = Buffer.concat([prefix, next.value]);
  }
  const replay = (async function* () {
    try {
      if (prefix.length) yield prefix;
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      await iterator.return();
    }
  })();
  if (prefix.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) {
    const chunks: Buffer[] = [];
    let length = 0,
      image: Buffer | undefined;
    try {
      for await (const block of replay) {
        length += block.length;
        if (length > 64 * 1024 * 1024)
          throw new Error("Legacy database exceeds encrypted memory-only restore bound");
        chunks.push(block);
      }
      image = Buffer.concat(chunks);
      return use({ sourceImage: image });
    } finally {
      image?.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
  }
  if (!options.sourceKey) {
    await iterator.return();
    throw new Error("The backup database encryption key is missing");
  }
  let owned: { device: bigint; inode: bigint } | undefined;
  try {
    const file = await open(
      options.sourceCipherPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const metadata = await file.stat({ bigint: true });
      owned = { device: metadata.dev, inode: metadata.ino };
      for await (const page of authenticateSqlCipherPages(replay, options.sourceKey, signal))
        await file.writeFile(page);
      await file.sync();
    } finally {
      await file.close();
    }
    return use({ sourcePath: options.sourceCipherPath, sourceKey: options.sourceKey });
  } finally {
    await iterator.return();
    if (owned) {
      try {
        const file = await lstat(options.sourceCipherPath, { bigint: true });
        if (file.isFile() && file.dev === owned.device && file.ino === owned.inode)
          await unlink(options.sourceCipherPath);
      } catch {
        /* Never delete an adopted replacement. */
      }
    }
  }
}
