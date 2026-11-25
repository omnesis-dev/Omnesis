// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { withDesktopInstallLease, readDesktopInstall } from "./bootstrap.js";
import { readDesktopRetirement } from "./retirement.js";
import { assertDesktopMutationAllowed, desktopUpdateBlocked } from "./update-admission.js";
import type { DesktopProfile } from "./environment.js";

/** Publication shares removal's external lease, which survives deletion of the data root. */
export async function withDesktopPublication<T>(
  profile: DesktopProfile,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  return withDesktopInstallLease(profile, signal, async () => {
    signal.throwIfAborted();
    await assertDesktopMutationAllowed(profile);
    if ((await readDesktopInstall(profile))?.phase !== "configured")
      throw new Error("The managed installation is not ready");
    return work();
  });
}

/** Transport hints are optional and must never revive a retired installation. */
export async function publishDesktopHint(
  profile: DesktopProfile,
  work: () => Promise<void>,
): Promise<void> {
  if ((await readDesktopRetirement(profile)) || (await desktopUpdateBlocked(profile))) return;
  await withDesktopInstallLease(profile, AbortSignal.timeout(5_000), async () => {
    if ((await readDesktopRetirement(profile)) || (await desktopUpdateBlocked(profile))) return;
    if ((await readDesktopInstall(profile))?.phase !== "configured") return;
    await work();
  });
}
