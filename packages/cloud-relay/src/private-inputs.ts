// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { readWindowsPrivateFile, readWindowsRegularFilePrefix } from "@omnesis/core";

/** Preserve the existing POSIX read while holding and bounding Windows private inputs. */
export function readPrivateInput(path: string): Promise<Buffer> {
  return process.platform === "win32" ? readWindowsPrivateFile(path, 65_536) : readFile(path);
}

export async function readPrivateText(path: string): Promise<string> {
  return (await readPrivateInput(path)).toString("utf8");
}

/** Signing tools with an existing byte limit retain it on both platforms. */
export async function readBoundedPrivateText(
  path: string,
  maximumBytes: number,
  tooLargeMessage: string,
): Promise<string> {
  if (process.platform === "win32")
    return (await readWindowsPrivateFile(path, maximumBytes)).toString("utf8");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error(tooLargeMessage);
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString("utf8");
}

/** An inaccessible, dangling, or malformed artifact cannot authorize another identity. */
export async function identityArtifactPresent(path: string): Promise<boolean> {
  try {
    if (process.platform === "win32") await readWindowsRegularFilePrefix(path, 0);
    else await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
