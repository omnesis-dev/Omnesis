// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { readWindowsRegularFilePrefix } from "@omnesis/core";

/** Bounded regular-file read, without following a link into another directory. */
export async function readMessagePrefix(
  path: string,
  maxBytes: number,
  platform = process.platform,
): Promise<{ bytes: Buffer; size: number }> {
  if (platform === "win32") {
    // The native worker opens each component relative to its held parent.
    // Repeated lstat snapshots cannot establish this boundary under renames.
    const result = await readWindowsRegularFilePrefix(path, maxBytes);
    return { bytes: result.bytes, size: Number(result.size) };
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw Object.assign(new Error("Not a regular file"), { code: "ENOTREGULAR" });
    const length = Math.min(stat.size, maxBytes);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, bytes, offset, length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return { bytes: bytes.subarray(0, offset), size: stat.size };
  } finally {
    closeSync(fd);
  }
}
