// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { desktopSourceDevelopment, readDesktopActiveRuntime } from "./update-active.js";
import { readDesktopRetirement } from "./retirement.js";
import { desktopRestoreBlocked } from "./restore-intent.js";
import {
  verifyDesktopRestoreActivation,
  type DesktopRestoreActivation,
} from "./restore-activation.js";
import {
  desktopRuntimeEpoch,
  desktopUpdateEpochDisposition,
  readDesktopUpdateState,
} from "./update-state.js";
import type { DesktopProfile } from "./environment.js";

export async function desktopUpdateBlocked(
  profile: DesktopProfile,
  epoch: string | null = desktopRuntimeEpoch(),
  restoreActivation?: DesktopRestoreActivation,
): Promise<boolean> {
  if (await desktopRestoreBlocked(profile)) {
    if (
      !restoreActivation ||
      restoreActivation.epoch !== epoch ||
      !(await verifyDesktopRestoreActivation(profile, restoreActivation))
    )
      return true;
  }
  if (desktopUpdateEpochDisposition(await readDesktopUpdateState(profile), epoch) !== "allow")
    return true;
  const active = await readDesktopActiveRuntime(profile);
  if (active) return active.epoch !== epoch;
  return epoch === null && !desktopSourceDevelopment();
}
export async function assertDesktopMutationAllowed(
  profile: DesktopProfile,
  epoch: string | null = desktopRuntimeEpoch(),
): Promise<void> {
  if (await readDesktopRetirement(profile))
    throw new Error("This installation has retired; reconnect explicitly before saving changes");
  if (await desktopRestoreBlocked(profile))
    throw new Error("Finish restoring the pending backup before saving changes");
  if (await desktopUpdateBlocked(profile, epoch))
    throw new Error(
      "Finish installing or recovering the pending desktop update before saving changes",
    );
}
export async function desktopEpochMayStart(
  profile: DesktopProfile,
  epoch: string | null = desktopRuntimeEpoch(),
  restoreActivation?: DesktopRestoreActivation,
): Promise<boolean> {
  if (await desktopRestoreBlocked(profile)) {
    if (
      !restoreActivation ||
      restoreActivation.epoch !== epoch ||
      !(await verifyDesktopRestoreActivation(profile, restoreActivation, { mode: "pending" }))
    )
      return false;
  }
  const state = await readDesktopUpdateState(profile);
  if (state) return desktopUpdateEpochDisposition(state, epoch) !== "block";
  const active = await readDesktopActiveRuntime(profile);
  if (active) return active.epoch === epoch;
  return epoch !== null || desktopSourceDevelopment();
}
