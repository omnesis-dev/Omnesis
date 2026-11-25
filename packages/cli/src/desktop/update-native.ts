// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { desktopUpdateMetadataSchema } from "./update-plan.js";
import type { DesktopProtocolContext } from "./protocol.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().positive().safe();
export const desktopInstallerReceiptSchema = z
  .object({
    verified: z.literal(true),
    receiptId: z.string().uuid(),
    metadata: desktopUpdateMetadataSchema,
    candidateEpoch: digest,
    payloadBytes: bytes,
    applicationBytes: bytes,
    oldApplicationBytes: bytes,
    previousMetadata: desktopUpdateMetadataSchema.optional(),
    oldEpoch: digest.optional(),
  })
  .strict();
export type DesktopInstallerReceipt = z.infer<typeof desktopInstallerReceiptSchema>;

/** Receipt verification is a native trust boundary, never execution of a downloaded runtime. */
export function requestDesktopInstallerReceipt(
  context: DesktopProtocolContext,
  kind: "verifyDesktopInstaller" | "verifyCurrentDesktopApplication",
  payload: Record<string, unknown>,
): Promise<DesktopInstallerReceipt> {
  return context.interactions.ask(
    kind,
    payload,
    (value) => desktopInstallerReceiptSchema.parse(value),
    AbortSignal.any([context.signal, AbortSignal.timeout(5 * 60_000)]),
  );
}
export async function desktopInstallerAction(
  context: DesktopProtocolContext,
  kind: string,
  payload: Record<string, unknown>,
  field: "ready" | "opened" | "verified",
): Promise<void> {
  await context.interactions.ask(
    kind,
    payload,
    (value) =>
      z
        .object({ [field]: z.literal(true) })
        .strict()
        .parse(value),
    AbortSignal.any([context.signal, AbortSignal.timeout(30 * 60_000)]),
  );
}
