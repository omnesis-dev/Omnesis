// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** Display source paths with slashes while preserving literal POSIX backslashes. */
export function displayLocalFilePath(
  absolutePath: string,
  {
    platform = process.platform,
    home = homedir(),
  }: { platform?: NodeJS.Platform; home?: string } = {},
): string {
  const api = platform === "win32" ? win32 : posix;
  const rel = api.relative(home, absolutePath);
  const insideHome = rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
  return (insideHome ? `~${api.sep}${rel}` : absolutePath).split(api.sep).join("/");
}
