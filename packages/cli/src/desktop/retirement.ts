// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "@omnesis/core";
import { assertDesktopProfileGeneration, readDesktopGeneration } from "./generation.js";
import type { DesktopProfile } from "./environment.js";

const rootIdentity = z
  .object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) })
  .strict();
const retirementSchema = z
  .object({
    version: z.literal(1),
    owner: z.literal("omnesis-desktop"),
    instance: z.string().min(1),
    secretService: z.string().min(1),
    operationId: z.string().uuid(),
    mode: z.enum(["keep-data", "erase-data"]),
    phase: z.enum(["requested", "stopped", "dataRemoved", "keyCleanupPending", "complete"]),
    root: rootIdentity,
  })
  .strict()
  .refine(
    (record) =>
      record.mode === "erase-data" || !["dataRemoved", "keyCleanupPending"].includes(record.phase),
    "Invalid retirement phase",
  );
export type DesktopRetirement = z.infer<typeof retirementSchema>;
export type DesktopRootIdentity = z.infer<typeof rootIdentity>;

/** The intent survives removal of data and protects a retained library from automatic restart. */
export function desktopRetirementPath(profile: DesktopProfile): string {
  return join(`${profile.configDir}.bootstrap`, "retirement.json");
}

export async function desktopRootIdentity(
  profile: DesktopProfile,
): Promise<DesktopRootIdentity | null> {
  try {
    const metadata = await lstat(profile.configDir, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077n) !== 0n ||
      (process.getuid && metadata.uid !== BigInt(process.getuid())) ||
      (await realpath(profile.configDir)) !== resolve(profile.configDir)
    )
      throw new Error("The managed library folder is not a private directory owned by you");
    return { device: String(metadata.dev), inode: String(metadata.ino) };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function readDesktopRetirement(
  profile: DesktopProfile,
): Promise<DesktopRetirement | null> {
  const path = desktopRetirementPath(profile);
  try {
    await assertParent(profile);
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const metadata = await file.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o077) !== 0 ||
        (process.getuid && metadata.uid !== process.getuid())
      )
        throw new Error("The desktop retirement record must be private and owned by you");
      const bytes = Buffer.alloc(8193);
      const result = await file.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > 8192) throw new Error("Invalid desktop retirement record");
      const record = retirementSchema.parse(
        JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8")),
      );
      const generation = readDesktopGeneration(profile.configDir);
      if (
        generation &&
        record.mode === "erase-data" &&
        record.phase === "complete" &&
        record.operationId === generation.previous.retirementId &&
        record.instance === generation.previous.instance &&
        record.secretService === generation.previous.secretService
      ) {
        assertDesktopProfileGeneration(profile);
        return null;
      }
      assertIdentity(profile, record);
      return record;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** The caller holds the installation lease while advancing this journal. */
export async function writeDesktopRetirement(
  profile: DesktopProfile,
  value: DesktopRetirement,
): Promise<void> {
  assertDesktopProfileGeneration(profile);
  const record = retirementSchema.parse(value);
  assertIdentity(profile, record);
  await assertParent(profile);
  await atomicWriteFile(desktopRetirementPath(profile), JSON.stringify(record), { mode: 0o600 });
}
export function sameDesktopRoot(
  first: DesktopRootIdentity | null,
  second: DesktopRootIdentity | null,
): boolean {
  return (
    first !== null &&
    second !== null &&
    first.device === second.device &&
    first.inode === second.inode
  );
}
async function assertParent(profile: DesktopProfile): Promise<void> {
  const directory = `${profile.configDir}.bootstrap`;
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    (await realpath(directory)) !== resolve(directory)
  )
    throw new Error("The desktop installation lease folder must be private and owned by you");
}
function assertIdentity(profile: DesktopProfile, record: DesktopRetirement): void {
  if (record.instance !== profile.instance || record.secretService !== profile.secretService)
    throw new Error("The desktop retirement record belongs to another installation");
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
