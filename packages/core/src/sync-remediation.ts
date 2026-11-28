// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import type { SyncRemediation } from "@omnesis/types";

export const permissionActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("open-system-settings"),
      category: z.enum(["full-disk-access", "files-and-folders", "privacy-security"]),
    })
    .strict(),
  z.object({ kind: z.literal("retry-access") }).strict(),
  z.object({ kind: z.literal("restart-collector") }).strict(),
  z.object({ kind: z.literal("choose-folder") }).strict(),
]);

/**
 * Wire and column shape of a `SyncRemediation`. The bounds are generous for
 * anything a provider would author and tight enough that a corrupt or hostile
 * status event cannot park a page of text on every client.
 */
export const syncRemediationSchema = z
  .object({
    actions: z.array(permissionActionSchema).max(8).optional(),
    access: z
      .object({
        status: z.literal("denied"),
        checkedAt: z.iso.datetime(),
        scopeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        target: z.literal("unverified"),
      })
      .strict()
      .optional(),
    summary: z.string().trim().min(1).max(200),
    steps: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
    executable: z.string().trim().min(1).max(1024).optional(),
    restartRequired: z.boolean(),
  })
  .strict() satisfies z.ZodType<SyncRemediation>;

/**
 * The remedy for a read macOS refused because the process lacks Full Disk
 * Access. One place authors it because every local source that reads a
 * protected database, and the installer that prints the grant ahead of
 * time, must tell the operator the same thing.
 *
 * Full Disk Access is unlike most macOS grants: attempting the read shows no
 * consent prompt, and no installer can give it. The operator lists the exact
 * binary in System Settings for a traditional headless install. Managed native
 * applications must separately verify responsible-code attribution: this field
 * is legacy guidance, not proof of which app/helper owns a TCC grant. After a
 * grant changes, newly launched collector processes must recheck capability.
 */
export function fullDiskAccessRemediation(executable: string): SyncRemediation {
  return {
    summary: "Full Disk Access is required",
    steps: [
      "Open System Settings › Privacy & Security › Full Disk Access.",
      "Add the executable running the collector to the list and switch it on.",
    ],
    executable,
    restartRequired: true,
  };
}
