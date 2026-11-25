// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { readDesktopInstall, withDesktopInstallLease } from "./bootstrap.js";
import { stopDesktopDaemon } from "./daemon-control.js";
import { desktopRestoreBlocked } from "./restore-intent.js";
import {
  desktopRootIdentity,
  readDesktopRetirement,
  sameDesktopRoot,
  writeDesktopRetirement,
  type DesktopRetirement,
} from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { readDesktopUpdateState } from "./update-state.js";
import type { DesktopProfile } from "./environment.js";

/** A native presenter observed its own app being deleted/trashed. This never erases library data. */
export async function retireDesktopApplication(
  profile: DesktopProfile,
  signal: AbortSignal,
  operations: { stop?: typeof stopDesktopDaemon } = {},
): Promise<"absent" | "stopped" | "retired"> {
  // Avoid creating installation state merely because an unused shell was moved to Trash.
  if (!(await readDesktopInstall(profile)) && !(await readDesktopRetirement(profile)))
    return "absent";
  return withDesktopInstallLease(profile, signal, async () => {
    const install = await readDesktopInstall(profile);
    let retirement = await readDesktopRetirement(profile);
    if (!install && !retirement) return "absent";
    const root = await desktopRootIdentity(profile);
    if (!root) return "absent";
    if (retirement && !sameDesktopRoot(retirement.root, root))
      throw new Error("The managed library folder changed after retirement");
    const update = await readDesktopUpdateState(profile);
    const recovering =
      (update !== null && !["verified", "complete", "resumed"].includes(update.phase)) ||
      (await desktopRestoreBlocked(profile));
    if (!retirement && !recovering) {
      retirement = {
        version: 1,
        owner: "omnesis-desktop",
        instance: profile.instance,
        secretService: profile.secretService,
        operationId: randomUUID(),
        mode: "keep-data",
        phase: "requested",
        root,
      } satisfies DesktopRetirement;
      await writeDesktopRetirement(profile, retirement);
    }
    signal.throwIfAborted();
    const stopped = await (operations.stop ?? stopDesktopDaemon)(profile, signal);
    const leases = await acquireDesktopRuntimeLeases(profile, {
      signal,
      expectedRoot: root,
      runtimeWaitMs: stopped ? 5_000 : 0,
    });
    try {
      // A pending erase/update/restore remains its own durable recovery operation.
      if (retirement?.mode === "keep-data") {
        await writeDesktopRetirement(profile, { ...retirement, phase: "complete" });
        return "retired";
      }
      return "stopped";
    } finally {
      leases.release();
    }
  });
}
