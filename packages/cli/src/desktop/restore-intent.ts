// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { readDesktopPrivateRecord, writeDesktopPrivateRecord } from "./private-record.js";
import type { DesktopProfile } from "./environment.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const desktopRestoreIntentSchema = z
  .object({
    version: z.literal(1),
    owner: z.literal("omnesis-desktop"),
    instance: z.string().min(1),
    secretService: z.string().min(1),
    operationId: z.string().uuid(),
    phase: z.enum([
      "stopping",
      "backed-up",
      "staged",
      "publishing",
      "published",
      "verifying",
      "committed",
      "starting",
      "complete",
      "rolling-back",
      "rolled-back",
      "recovery-required",
    ]),
    root: z
      .object({ device: z.string().regex(/^\d+$/u), inode: z.string().regex(/^\d+$/u) })
      .strict(),
    targetKeyDigest: digest,
    archiveSha256: digest,
    archiveBytes: z
      .number()
      .int()
      .positive()
      .safe()
      .max(1024 ** 4),
    review: z
      .object({
        sourcesPaused: z.number().int().nonnegative().safe(),
        watchesPaused: z.number().int().nonnegative().safe(),
        previousLabChoices: z
          .object({ brain: z.boolean(), tasks: z.boolean(), watches: z.boolean() })
          .strict(),
      })
      .strict()
      .optional(),
    verification: z
      .object({
        schemaVersion: z.number().int().positive(),
        documents: z.number().int().nonnegative().safe(),
        sources: z.number().int().nonnegative().safe(),
        tokenDigest: digest,
        configDigest: digest,
        verifiedAt: z.string().datetime().optional(),
      })
      .strict()
      .optional(),
    activation: z
      .object({
        attemptId: z.string().uuid(),
        epoch: z.string().min(1).max(256).nullable(),
        claimed: z.boolean(),
      })
      .strict()
      .optional(),
    backup: z
      .object({ manifestSha256: digest, bytes: z.number().int().nonnegative().safe() })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (value) =>
      ![
        "backed-up",
        "staged",
        "publishing",
        "published",
        "verifying",
        "committed",
        "starting",
        "complete",
        "rolling-back",
      ].includes(value.phase) || value.backup !== null,
    "Restoring a managed library requires its original recovery snapshot",
  );

export type DesktopRestoreIntent = z.infer<typeof desktopRestoreIntentSchema>;

/** Independent of restored stores so interrupted publication remains fenced at boot. */
export async function readDesktopRestoreIntent(
  profile: DesktopProfile,
): Promise<DesktopRestoreIntent | null> {
  const record = await readDesktopPrivateRecord(profile, "restore.json", (value) =>
    desktopRestoreIntentSchema.parse(value),
  );
  if (record) assertProfile(profile, record);
  return record;
}

/** Malformed or foreign records throw; an interrupted restore never permits automatic startup. */
export async function desktopRestoreBlocked(profile: DesktopProfile): Promise<boolean> {
  const record = await readDesktopRestoreIntent(profile);
  return record !== null && record.phase !== "complete" && record.phase !== "rolled-back";
}

/** Caller holds the external installation lease and the runtime leases while publishing stores. */
export async function writeDesktopRestoreIntent(
  profile: DesktopProfile,
  value: DesktopRestoreIntent,
): Promise<void> {
  const record = desktopRestoreIntentSchema.parse(value);
  assertProfile(profile, record);
  await writeDesktopPrivateRecord(profile, "restore.json", record);
}

function assertProfile(profile: DesktopProfile, record: DesktopRestoreIntent): void {
  if (record.instance !== profile.instance || record.secretService !== profile.secretService) {
    throw new Error("The restore record belongs to another managed library");
  }
}
