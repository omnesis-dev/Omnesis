// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "@omnesis/core";
import { assertDesktopProfileGeneration } from "./generation.js";
import type { DesktopProfile } from "./environment.js";

type RecordName =
  | "update.json"
  | "active-runtime.json"
  | "restore.json"
  | "code-retention.json"
  | "process-authority.json"
  | "retirement.json";
const limit = 16_384;
export async function readDesktopPrivateRecord<T>(
  profile: DesktopProfile,
  name: RecordName,
  parse: (value: unknown) => T,
): Promise<T | null> {
  try {
    await privateParent(profile);
    const file = await open(
      join(`${profile.configDir}.bootstrap`, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await file.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o077) !== 0 ||
        (process.getuid && metadata.uid !== process.getuid())
      )
        throw new Error("The desktop lifecycle record must be private and owned by you");
      const bytes = Buffer.alloc(limit + 1);
      const read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > limit) throw new Error("The desktop lifecycle record is too large");
      return parse(JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
/** Caller holds the external installation lease. */
export async function writeDesktopPrivateRecord(
  profile: DesktopProfile,
  name: RecordName,
  value: unknown,
): Promise<void> {
  await privateParent(profile);
  const body = JSON.stringify(value);
  if (body === undefined) throw new Error("The desktop lifecycle record is invalid");
  if (Buffer.byteLength(body) > limit) throw new Error("The desktop lifecycle record is too large");
  await atomicWriteFile(join(`${profile.configDir}.bootstrap`, name), body, { mode: 0o600 });
}
async function privateParent(profile: DesktopProfile): Promise<void> {
  assertDesktopProfileGeneration(profile);
  const path = `${profile.configDir}.bootstrap`,
    metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("The desktop lifecycle journal folder must be private and owned by you");
}
