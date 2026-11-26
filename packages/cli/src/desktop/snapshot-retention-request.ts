// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DesktopProfile } from "./environment.js";
import type {
  DesktopSnapshotCleanupReceipt,
  DesktopSnapshotRetentionRecord,
} from "./snapshot-retention-record.js";

export const desktopSnapshotGcRequestSchema = z
  .object({
    version: z.literal(1),
    profile: z
      .object({
        configDir: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (value) => isAbsolute(value) && resolve(value) === value && !value.includes("\0"),
          ),
        instance: z.string().regex(/^desktop-[a-f0-9]{16}$/u),
        secretService: z.string().regex(/^dev\.omnesis\.desktop\.[a-f0-9]{64}$/u),
      })
      .strict(),
    snapshotId: z.string().uuid().optional(),
    incompleteStaging: z.boolean().optional(),
    expectedBinding: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    retry: z.boolean().optional(),
  })
  .strict();
export type DesktopSnapshotGcRequest = z.infer<typeof desktopSnapshotGcRequestSchema>;
export function desktopSnapshotCleanupBinding(
  profile: DesktopProfile,
  prepared: { ledger: DesktopSnapshotRetentionRecord; receipt: DesktopSnapshotCleanupReceipt },
): string {
  const { operationId: _nonce, ...receipt } = prepared.receipt;
  return createHash("sha256")
    .update(JSON.stringify({ profile, ledger: prepared.ledger, receipt }))
    .digest("hex");
}
