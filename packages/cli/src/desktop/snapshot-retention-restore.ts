// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readDesktopActiveRuntime, desktopSourceDevelopment } from "./update-active.js";
import { desktopRuntimeEpoch, readDesktopUpdateState } from "./update-state.js";
import { readDesktopRestoreIntent, type DesktopRestoreIntent } from "./restore-intent.js";
import { desktopRootIdentity, sameDesktopRoot } from "./retirement.js";
import {
  assertDesktopSnapshotRetentionCapacity,
  assertDesktopSnapshotStageSettled,
  registerVerifiedDesktopRestoreSnapshot,
  registerVerifiedDesktopSnapshot,
} from "./snapshot-retention.js";
import type { DesktopProfile } from "./environment.js";

/** Source-mode fixtures have no packaged epoch. Managed copies never guess an application's identity. */
export async function captureDesktopRestoreBackupRuntime(
  profile: DesktopProfile,
  dependencies: {
    epoch?: typeof desktopRuntimeEpoch;
    source?: typeof desktopSourceDevelopment;
    readActive?: typeof readDesktopActiveRuntime;
  } = {},
): Promise<DesktopRestoreIntent["backupRuntime"]> {
  const epoch = (dependencies.epoch ?? desktopRuntimeEpoch)(),
    active = await (dependencies.readActive ?? readDesktopActiveRuntime)(profile);
  if (!epoch && (dependencies.source ?? desktopSourceDevelopment)()) return undefined;
  if (!epoch || !active || active.epoch !== epoch)
    throw new Error("The active application must own this library before making a recovery copy");
  return { epoch, version: active.productVersion };
}
/** Shared admission before any new automatic restore backstop or journal replacement. */
export async function retainDesktopRestoreBeforeReplacement(
  profile: DesktopProfile,
  signal: AbortSignal,
): Promise<void> {
  const previous = await readDesktopRestoreIntent(profile);
  if (previous) {
    if (
      !["complete", "rolled-back"].includes(previous.phase) ||
      !sameDesktopRoot(await desktopRootIdentity(profile), previous.root)
    )
      throw new Error("Finish the prior restore before preparing another");
    await assertDesktopSnapshotStageSettled(
      profile,
      previous.operationId,
      previous.backup !== null,
      signal,
    );
    await registerVerifiedDesktopRestoreSnapshot(profile, previous, signal);
  }
  const update = await readDesktopUpdateState(profile);
  if (update?.backup && ["complete", "resumed"].includes(update.phase))
    await registerVerifiedDesktopSnapshot(profile, update, signal);
  await assertDesktopSnapshotRetentionCapacity(profile);
}
