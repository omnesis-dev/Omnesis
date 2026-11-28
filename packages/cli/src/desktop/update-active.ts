// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { valid } from "semver";
import { desktopUpdateMetadataSchema } from "./update-plan.js";
import { readDesktopPrivateRecord, writeDesktopPrivateRecord } from "./private-record.js";
import type { DesktopProfile } from "./environment.js";

const activeSchema = z
  .object({
    format: z.literal(1),
    owner: z.literal("omnesis-desktop"),
    instance: z.string().min(1),
    secretService: z.string().min(1),
    epoch: z.string().regex(/^[a-f0-9]{64}$/),
    productVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .refine((value) => valid(value) !== null),
  })
  .strict();
export type DesktopActiveRuntime = z.infer<typeof activeSchema>;
/** Source development is a code-layout distinction; no production environment bypass exists. */
export function desktopSourceDevelopment(): boolean {
  return /[/\\]src[/\\]desktop[/\\]update-active\.ts$/.test(fileURLToPath(import.meta.url));
}
export async function readDesktopActiveRuntime(
  profile: DesktopProfile,
): Promise<DesktopActiveRuntime | null> {
  const record = await readDesktopPrivateRecord(profile, "active-runtime.json", (value) =>
    activeSchema.parse(value),
  );
  if (record) identity(profile, record);
  return record;
}
/** Caller owns runtime-owner and the external installation lease before crossing a store-open boundary. */
export async function writeDesktopActiveRuntime(
  profile: DesktopProfile,
  epoch: string,
  productVersion: string,
): Promise<void> {
  const record = activeSchema.parse({
    format: 1,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
    epoch,
    productVersion,
  });
  await writeDesktopPrivateRecord(profile, "active-runtime.json", record);
}
export async function readCurrentDesktopMetadata() {
  const file = await open(
    join(dirname(process.execPath), "desktop-update.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 1024 * 1024)
      throw new Error("The installed runtime metadata is invalid");
    const bytes = Buffer.alloc(1024 * 1024 + 1),
      read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 1024 * 1024)
      throw new Error("The installed runtime metadata is too large");
    return desktopUpdateMetadataSchema.parse(
      JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")),
    );
  } finally {
    await file.close();
  }
}
function identity(profile: DesktopProfile, record: DesktopActiveRuntime): void {
  if (record.instance !== profile.instance || record.secretService !== profile.secretService)
    throw new Error("The active desktop runtime belongs to another installation");
}
