// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { BigIntStats } from "node:fs";

/** Filesystem identifiers can exceed Number's exact integer range. */
export function exactNoteIdentity(stat: Pick<BigIntStats, "dev" | "ino">): string {
  if (stat.dev < 0n || stat.ino < 0n)
    throw new Error("Cannot verify Obsidian note identity on this filesystem");
  return `${stat.dev}:${stat.ino}`;
}

export function isNoteIdentity(value: unknown): value is string {
  return typeof value === "string" && /^\d+:\d+$/u.test(value);
}

/** Numeric identities are retained only for reading installed cursors. */
export function noteIdentityKey(file: { inode: number; fileIdentity?: string }): string {
  return file.fileIdentity ?? `legacy:${file.inode}`;
}
