// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { BigIntStats } from "node:fs";

export function isExactFileIdentity(value: unknown): value is string {
  return typeof value === "string" && /^\d+:[1-9]\d*$/u.test(value);
}

/** Preserve the filesystem's full-width identity without a Number conversion. */
export function exactFileIdentity(stat: Pick<BigIntStats, "dev" | "ino">): string {
  if (stat.dev < 0n || stat.ino <= 0n)
    throw new Error("Cannot verify local file identity on this filesystem");
  return `${stat.dev}:${stat.ino}`;
}

/** Installed cursors without an exact identity retain their numeric key. */
export function fileIdentityKey(file: {
  fileIdentity?: string;
  device: number;
  inode: number;
}): string {
  return file.fileIdentity ?? `${file.device}:${file.inode}`;
}
