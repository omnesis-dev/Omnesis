// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertDesktopProcessAuthority } from "./process-authority.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { stopDesktopDaemon } from "./daemon-control.js";
import { desktopRestoreBlocked } from "./restore-intent.js";
import { acquireDesktopRestoreSessionLease } from "./restore-owner.js";
import { desktopRootIdentity, readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import { desktopUpdateConfirmation } from "./update-handoff.js";
import { runDesktopUpdateDataOperation } from "./update-data-operation.js";
import { verifyDesktopUpdateSnapshot } from "./update-snapshot.js";
import {
  readDesktopUpdateState,
  writeDesktopUpdateState,
  type DesktopUpdateState,
} from "./update-state.js";
import type { DesktopProfile } from "./environment.js";

/** Restore data beneath native EX before selecting old code; no backward migration or implicit restart. */
export async function recoverDesktopUpdate(
  profile: DesktopProfile,
  options: { confirmationId: string; signal: AbortSignal },
  operations: {
    stop?: typeof stopDesktopDaemon;
    executeRollback?(
      profile: DesktopProfile,
      operationId: string,
      signal: AbortSignal,
    ): Promise<DesktopUpdateState>;
    verifyPrevious(state: DesktopUpdateState, signal: AbortSignal): Promise<void>;
    openPrevious(state: DesktopUpdateState, signal: AbortSignal): Promise<void>;
  },
): Promise<DesktopUpdateState> {
  const session = await acquireDesktopRestoreSessionLease(profile, options.signal);
  try {
    const requested = await withDesktopInstallLease(profile, options.signal, async () => {
      await assertDesktopProcessAuthority(profile);
      if ((await readDesktopRetirement(profile)) || (await desktopRestoreBlocked(profile)))
        throw new Error("Finish pending removal or backup restore before update recovery");
      let state = await readDesktopUpdateState(profile);
      if (!state || desktopUpdateConfirmation(state) !== options.confirmationId)
        throw new Error("The reviewed recovery changed. Review it again before continuing");
      if (!sameDesktopRoot(await desktopRootIdentity(profile), state.root))
        throw new Error("The managed library folder changed before update recovery");
      await operations.verifyPrevious(state, options.signal);
      options.signal.throwIfAborted();
      if (state.phase === "resumed") return state;
      if (!state.backup && !["verified", "stopping", "recovery-required"].includes(state.phase))
        throw new Error("The update's recovery snapshot is unavailable");
      if (state.backup)
        await verifyDesktopUpdateSnapshot(profile, {
          operationId: state.operationId,
          manifestSha256: state.backup.manifestSha256,
          signal: options.signal,
        });
      state = { ...state, phase: "recovery-required" };
      await writeDesktopUpdateState(profile, state);
      await (operations.stop ?? stopDesktopDaemon)(profile, options.signal);
      return state;
    });
    const recovered =
      requested.phase === "resumed"
        ? requested
        : await (
            operations.executeRollback ??
            ((profile, id, signal) =>
              runDesktopUpdateDataOperation(profile, id, "update-rollback", signal))
          )(profile, requested.operationId, options.signal);
    return await withDesktopInstallLease(profile, options.signal, async () => {
      const state = await readDesktopUpdateState(profile);
      if (
        !state ||
        state.operationId !== recovered.operationId ||
        state.phase !== "resumed" ||
        !sameDesktopRoot(await desktopRootIdentity(profile), state.root) ||
        (await readDesktopRetirement(profile)) ||
        (await desktopRestoreBlocked(profile))
      )
        throw new Error(
          "The recovered installation changed before opening its previous application",
        );
      // Recheck the signed complete app at presentation time; failure never re-restores data.
      await operations.openPrevious(state, options.signal);
      return state;
    });
  } finally {
    session.release();
  }
}
