// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { withDesktopInstallLease } from "./bootstrap.js";
import { assertDesktopConfigSecretsProtected } from "./config-protection.js";
import { stopDesktopDaemon } from "./daemon-control.js";
import { desktopRestoreBlocked } from "./restore-intent.js";
import { acquireDesktopRestoreSessionLease } from "./restore-owner.js";
import { desktopRootIdentity, readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import { runDesktopUpdateDataOperation } from "./update-data-operation.js";
import {
  readDesktopUpdateState,
  writeDesktopUpdateState,
  type DesktopUpdateState,
} from "./update-state.js";
import type { DesktopProfile } from "./environment.js";

/** Bind the deliberate confirmation to the exact reviewed operation, root and current phase. */
export function desktopUpdateConfirmation(state: DesktopUpdateState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
interface HandoffOperations {
  stop: typeof stopDesktopDaemon;
  executeSnapshot(
    profile: DesktopProfile,
    operationId: string,
    signal: AbortSignal,
  ): Promise<DesktopUpdateState>;
  /** Native rechecks its signed artifact receipt and opens only the verified installer volume. */
  openInstaller(state: DesktopUpdateState, signal: AbortSignal): Promise<void>;
}
/** The durable intent fences startup while ownership moves from controller to the native EX host. */
export async function handoffDesktopUpdate(
  profile: DesktopProfile,
  options: { confirmationId: string; currentEpoch: string; signal: AbortSignal },
  operations: Pick<HandoffOperations, "openInstaller"> & Partial<HandoffOperations>,
): Promise<DesktopUpdateState> {
  const deps: HandoffOperations = {
    stop: stopDesktopDaemon,
    executeSnapshot: (profile, id, signal) =>
      runDesktopUpdateDataOperation(profile, id, "update-snapshot", signal),
    ...operations,
  };
  const session = await acquireDesktopRestoreSessionLease(profile, options.signal);
  let operationId: string | undefined;
  try {
    const requested = await withDesktopInstallLease(profile, options.signal, async () => {
      if ((await readDesktopRetirement(profile)) || (await desktopRestoreBlocked(profile)))
        throw new Error("Finish pending removal or backup recovery before updating");
      const state = await readDesktopUpdateState(profile);
      if (!state || desktopUpdateConfirmation(state) !== options.confirmationId)
        throw new Error("The reviewed update changed. Review it again before installing");
      if (state.oldEpoch !== options.currentEpoch)
        throw new Error("Prepare this update from the currently active application");
      if (state.phase !== "verified")
        throw new Error("This update already started. Use its explicit recovery choices");
      if (!sameDesktopRoot(await desktopRootIdentity(profile), state.root))
        throw new Error("The managed library folder changed before updating");
      await assertDesktopConfigSecretsProtected(profile, options.signal);
      const stopping = { ...state, phase: "stopping" as const };
      await writeDesktopUpdateState(profile, stopping);
      operationId = state.operationId;
      await deps.stop(profile, options.signal);
      return stopping;
    });
    // The host independently validates this exact intent and acquires its own install/store leases.
    await deps.executeSnapshot(profile, requested.operationId, options.signal);
    return await withDesktopInstallLease(profile, options.signal, async () => {
      const state = await readDesktopUpdateState(profile);
      if (
        !state ||
        state.operationId !== requested.operationId ||
        !sameDesktopRoot(await desktopRootIdentity(profile), state.root) ||
        (await readDesktopRetirement(profile)) ||
        (await desktopRestoreBlocked(profile))
      )
        throw new Error("The update handoff changed before installer presentation");
      // A deliberately launched candidate may have claimed the verified backup first.
      if (state.phase === "candidate-started" || state.phase === "complete") return state;
      if (state.phase !== "backed-up" || !state.backup)
        throw new Error("The update host did not publish a verified recovery snapshot");
      await deps.openInstaller(state, options.signal);
      options.signal.throwIfAborted();
      const opened = { ...state, phase: "installer-opened" as const };
      await writeDesktopUpdateState(profile, opened);
      return opened;
    });
  } catch (error) {
    if (operationId) {
      await withDesktopInstallLease(profile, AbortSignal.timeout(5_000), async () => {
        const state = await readDesktopUpdateState(profile);
        if (
          state &&
          state.operationId === operationId &&
          ["stopping", "backed-up", "installer-opened"].includes(state.phase)
        )
          await writeDesktopUpdateState(profile, { ...state, phase: "recovery-required" });
      }).catch(() => {
        /* The original durable stop intent remains fenced if recovery publication cannot finish. */
      });
    }
    throw error;
  } finally {
    session.release();
  }
}
