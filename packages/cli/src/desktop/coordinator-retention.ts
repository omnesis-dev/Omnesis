// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { readDesktopInstall, withDesktopInstallLease } from "./bootstrap.js";
import {
  desktopRecoveryCopiesCatalog,
  type DesktopRecoveryCopiesCatalog,
} from "./snapshot-retention-catalog.js";
import { MAX_RETAINED_DESKTOP_SNAPSHOTS } from "./snapshot-retention-record.js";
import { pinRetainedDesktopSnapshot } from "./snapshot-retention.js";
import {
  handleDesktopRecoveryCleanup,
  isDesktopRecoveryCleanupCommand,
  type DesktopRecoveryCleanupCommand,
  type DesktopRecoveryCleanupResult,
} from "./coordinator-retention-cleanup.js";
import type { DesktopProfile } from "./environment.js";

export type DesktopRetentionCommand =
  "recoveryCopies" | "recoveryCopyPin" | DesktopRecoveryCleanupCommand;
export function isDesktopRetentionCommand(command: string): command is DesktopRetentionCommand {
  return (
    command === "recoveryCopies" ||
    command === "recoveryCopyPin" ||
    isDesktopRecoveryCleanupCommand(command)
  );
}
/** Lifecycle commands share configured ownership; destructive work stays in its fixed native host. */
export async function handleDesktopRetention(
  profile: DesktopProfile,
  command: DesktopRetentionCommand,
  params: unknown,
  signal: AbortSignal,
): Promise<DesktopRecoveryCopiesCatalog | DesktopRecoveryCleanupResult> {
  signal.throwIfAborted();
  const install = await readDesktopInstall(profile);
  if (isDesktopRecoveryCleanupCommand(command)) {
    if (install?.phase !== "configured") throw new Error("The managed installation is unavailable");
    return handleDesktopRecoveryCleanup(profile, command, params, signal);
  }
  if (command === "recoveryCopyPin") {
    const input = z.object({ id: z.string().uuid(), pinned: z.boolean() }).strict().parse(params);
    if (install?.phase !== "configured") throw new Error("The managed installation is unavailable");
    await pinRetainedDesktopSnapshot(profile, input.id, input.pinned, signal);
  } else
    z.object({})
      .strict()
      .parse(params ?? {});
  if (install?.phase !== "configured")
    return {
      kind: "desktopRecoveryCopies",
      limit: MAX_RETAINED_DESKTOP_SNAPSHOTS,
      items: [],
      partialCopies: [],
      pending: null,
      unregisteredCopies: 0,
    };
  return withDesktopInstallLease(profile, signal, () =>
    desktopRecoveryCopiesCatalog(profile, signal),
  );
}
