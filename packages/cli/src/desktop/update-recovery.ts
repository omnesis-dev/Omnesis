// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { withDesktopInstallLease } from "./bootstrap.js";
import { stopDesktopDaemon } from "./daemon-control.js";
import { desktopRestoreBlocked } from "./restore-intent.js";
import { desktopRootIdentity, readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { writeDesktopActiveRuntime } from "./update-active.js";
import { desktopUpdateConfirmation } from "./update-handoff.js";
import { restoreDesktopUpdateSnapshot, verifyDesktopUpdateSnapshot } from "./update-snapshot.js";
import {
  readDesktopUpdateState,
  writeDesktopUpdateState,
  type DesktopUpdateState,
} from "./update-state.js";
import type { DesktopProfile } from "./environment.js";

/** Restore data before selecting old code; no backward migration or implicit daemon restart. */
export async function recoverDesktopUpdate(
  profile: DesktopProfile,
  options: { confirmationId: string; signal: AbortSignal },
  operations: {
    stop?: typeof stopDesktopDaemon;
    /** Validate the full retained signed application BEFORE any library bytes can be replaced. */
    verifyPrevious(state: DesktopUpdateState, signal: AbortSignal): Promise<void>;
    /** Strict native adapter opens only the retained complete app matching this old epoch/version. */
    openPrevious(state: DesktopUpdateState, signal: AbortSignal): Promise<void>;
  },
): Promise<DesktopUpdateState> {
  return withDesktopInstallLease(profile, options.signal, async () => {
    if ((await readDesktopRetirement(profile)) || (await desktopRestoreBlocked(profile)))
      throw new Error("Finish the pending removal or backup restore before update recovery");
    let state = await readDesktopUpdateState(profile);
    if (!state || desktopUpdateConfirmation(state) !== options.confirmationId)
      throw new Error("The reviewed recovery changed. Review it again before continuing");
    if (!sameDesktopRoot(await desktopRootIdentity(profile), state.root))
      throw new Error("The managed library folder changed before update recovery");
    await operations.verifyPrevious(state, options.signal);
    options.signal.throwIfAborted();
    if (state.phase === "resumed") {
      // A retry of presentation launch must not restore again over newly collected old-version data.
      await operations.openPrevious(state, options.signal);
      return state;
    }
    // A candidate cannot have been admitted without a published verified backup.
    const restoring = state.backup !== null;
    if (
      !restoring &&
      !["verified", "stopping", "recovery-required", "resumed"].includes(state.phase)
    )
      throw new Error("The update's recovery snapshot is unavailable");
    if (state.backup)
      await verifyDesktopUpdateSnapshot(profile, {
        operationId: state.operationId,
        manifestSha256: state.backup.manifestSha256,
        signal: options.signal,
      });
    state = { ...state, phase: "recovery-required" };
    await writeDesktopUpdateState(profile, state);
    const stopped = await (operations.stop ?? stopDesktopDaemon)(profile, options.signal);
    const leases = await acquireDesktopRuntimeLeases(profile, {
      expectedRoot: state.root,
      signal: options.signal,
      runtimeWaitMs: stopped ? 5_000 : 0,
    });
    try {
      if (state.backup)
        await restoreDesktopUpdateSnapshot(profile, {
          operationId: state.operationId,
          snapshot: state.backup,
          leases,
          signal: options.signal,
        });
      options.signal.throwIfAborted();
      // Claim publication also needs the installation lease; no candidate can cross this transition.
      await writeDesktopActiveRuntime(profile, state.oldEpoch, state.oldVersion);
      state = { ...state, phase: "resumed" };
      await writeDesktopUpdateState(profile, state);
    } finally {
      leases.release();
    }
    // Failure to open old presentation leaves explicit resumed state: it never undoes restored data.
    await operations.openPrevious(state, options.signal);
    return state;
  });
}
