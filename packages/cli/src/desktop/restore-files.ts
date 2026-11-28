// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

/** Descriptor validation is repeated after reading; no pathname-only authority. */
export async function readDesktopRestoreFile(path: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024)
    throw new Error("The managed restore file bound is invalid");
  if ((await realpath(path)) !== resolve(path))
    throw new Error("The managed restore file is not canonical");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Buffer | undefined,
    accepted = false;
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      (process.getuid && before.uid !== BigInt(process.getuid())) ||
      before.size > BigInt(maxBytes)
    )
      throw new Error("The managed restore file must remain private and bounded");
    data = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        Math.min(64 * 1024, data.length - offset),
        offset,
      );
      if (!bytesRead) throw new Error("The managed restore file changed");
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      data.fill(0);
      throw new Error("The managed restore file changed");
    }
    const published = await lstat(path, { bigint: true });
    if (
      published.isSymbolicLink() ||
      published.dev !== before.dev ||
      published.ino !== before.ino ||
      (await realpath(path)) !== resolve(path)
    )
      throw new Error("The managed restore file changed");
    accepted = true;
    return data;
  } finally {
    if (!accepted) data?.fill(0);
    await handle.close();
  }
}
