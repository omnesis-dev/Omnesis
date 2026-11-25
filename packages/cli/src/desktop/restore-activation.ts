// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { DesktopRestoreProtection } from "./restore-protection.js";
import { readDesktopRestoreIntent, writeDesktopRestoreIntent } from "./restore-intent.js";
import { sameDesktopRoot } from "./retirement.js";
import type { DesktopProfile } from "./environment.js";

export const desktopRestoreActivationSchema = z
  .object({
    operationId: z.string().uuid(),
    attemptId: z.string().uuid(),
    epoch: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type DesktopRestoreActivation = z.infer<typeof desktopRestoreActivationSchema>;
/** Read-only admission. Component callers additionally prove their existing parent IPC. */
export async function verifyDesktopRestoreActivation(
  profile: DesktopProfile,
  authorization: DesktopRestoreActivation,
  options: { mode?: "pending" | "claim" | "child"; signal?: AbortSignal } = {},
): Promise<boolean> {
  const parsed = desktopRestoreActivationSchema.safeParse(authorization);
  if (!parsed.success) return false;
  const record = await readDesktopRestoreIntent(profile),
    activation = record?.activation;
  if (
    !record ||
    record.phase !== "starting" ||
    !activation ||
    record.operationId !== authorization.operationId ||
    activation.attemptId !== authorization.attemptId ||
    activation.epoch !== authorization.epoch ||
    ((options.mode === "claim" || options.mode === "pending") && activation.claimed) ||
    ((options.mode === undefined || options.mode === "child") && !activation.claimed)
  )
    return false;
  const protection = await DesktopRestoreProtection.capture(
    profile,
    options.signal ?? new AbortController().signal,
  );
  try {
    const identity = protection.identity();
    if (
      !sameDesktopRoot(identity.root, record.root) ||
      identity.keyDigest !== record.targetKeyDigest
    )
      return false;
    // The daemon claim is serialized by the external install lease plus its owner lease.
    if (options.mode === "claim")
      await writeDesktopRestoreIntent(profile, {
        ...record,
        activation: { ...activation, claimed: true },
      });
    return true;
  } finally {
    protection.close();
  }
}
