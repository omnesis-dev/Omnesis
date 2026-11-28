// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  readEncryptedArtifactStream,
  decryptEncryptedArtifactStream,
  isEncryptedArtifactBuffer,
} from "@omnesis/core";

export interface SealedRestoreEntry {
  path: string;
  scope: string;
  targetRootKey: string;
  sourceRootKey: string;
  logicalName: string;
  sourceScope: string | null;
  bytes: number;
}
export async function* streamRestoredEntry(
  entry: SealedRestoreEntry,
  signal: AbortSignal,
): AsyncGenerator<Buffer, void, void> {
  const outer = readEncryptedArtifactStream(entry.path, {
    rootKey: entry.targetRootKey,
    expectedScope: entry.scope,
    signal,
    maxBytes: entry.bytes + 16_384,
  });
  const iterator = outer[Symbol.asyncIterator]();
  let prefix = Buffer.alloc(0);
  while (prefix.length < 64) {
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
  if (isEncryptedArtifactBuffer(prefix)) {
    const inner = decryptEncryptedArtifactStream(replay, {
      rootKey: entry.sourceRootKey,
      expectedScope: entry.sourceScope ?? undefined,
      signal,
      maxBytes: entry.bytes,
    });
    yield* inner;
    const name = entry.logicalName.endsWith(".enc")
      ? entry.logicalName.slice(0, -4)
      : entry.logicalName;
    const scope = inner.authentication().scope;
    if (!scope.startsWith("backup:") || !scope.endsWith(`:${name}`))
      throw new Error("The backup database encryption scope is invalid");
  } else {
    yield* replay;
  }
  outer.authentication();
}
