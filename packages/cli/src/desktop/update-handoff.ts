// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { withDesktopInstallLease } from "./bootstrap.js";
import { stopDesktopDaemon } from "./daemon-control.js";
import { desktopRestoreBlocked } from "./restore-intent.js";
import { desktopRootIdentity, readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { createDesktopUpdateSnapshot, verifyDesktopUpdateSnapshot } from "./update-snapshot.js";
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
  reserve: typeof acquireDesktopRuntimeLeases;
  snapshot: typeof createDesktopUpdateSnapshot;
  verifySnapshot: typeof verifyDesktopUpdateSnapshot;
  /** Native rechecks its signed artifact receipt and opens only the verified installer volume. */
  openInstaller(state: DesktopUpdateState, signal: AbortSignal): Promise<void>;
}

/** No old or candidate store can open between the durable stop intent and the completed snapshot. */
export async function handoffDesktopUpdate(
  profile: DesktopProfile,
  options: { confirmationId: string; currentEpoch: string; signal: AbortSignal },
  operations: Pick<HandoffOperations, "openInstaller"> & Partial<HandoffOperations>,
): Promise<DesktopUpdateState> {
  const deps: HandoffOperations = {
    stop: stopDesktopDaemon,
    reserve: acquireDesktopRuntimeLeases,
    snapshot: createDesktopUpdateSnapshot,
    verifySnapshot: verifyDesktopUpdateSnapshot,
    ...operations,
  };
  return withDesktopInstallLease(profile, options.signal, async () => {
    if (await readDesktopRetirement(profile))
      throw new Error("This installation has retired; finish removal before updating");
    if (await desktopRestoreBlocked(profile))
      throw new Error("Finish restoring the pending backup before updating");
    let state = await readDesktopUpdateState(profile);
    if (!state || desktopUpdateConfirmation(state) !== options.confirmationId)
      throw new Error("The reviewed update changed. Review it again before installing");
    if (state.oldEpoch !== options.currentEpoch)
      throw new Error("Prepare this update from the currently active application");
    if (state.phase !== "verified")
      throw new Error("This update already started. Use its explicit recovery choices");
    if (!sameDesktopRoot(await desktopRootIdentity(profile), state.root))
      throw new Error("The managed library folder changed before updating");
    options.signal.throwIfAborted();
    state = { ...state, phase: "stopping" };
    await writeDesktopUpdateState(profile, state);
    let leases: Awaited<ReturnType<typeof acquireDesktopRuntimeLeases>> | undefined;
    try {
      const stopped = await deps.stop(profile, options.signal);
      // A missing listener is not proof. Actual supervisor, component and store leases are required.
      leases = await deps.reserve(profile, {
        expectedRoot: state.root,
        signal: options.signal,
        runtimeWaitMs: stopped ? 5_000 : 0,
      });
      const backup = await deps.snapshot(profile, {
        operationId: state.operationId,
        leases,
        signal: options.signal,
      });
      await deps.verifySnapshot(profile, {
        operationId: state.operationId,
        manifestSha256: backup.manifestSha256,
        signal: options.signal,
      });
      options.signal.throwIfAborted();
      state = { ...state, phase: "backed-up", backup };
      await writeDesktopUpdateState(profile, state);
      await deps.openInstaller(state, options.signal);
      options.signal.throwIfAborted();
      state = { ...state, phase: "installer-opened" };
      await writeDesktopUpdateState(profile, state);
      return state;
    } catch (error) {
      // Do not restart or clear the fence after cancellation, failed drain, or a native handoff error.
      await writeDesktopUpdateState(profile, { ...state, phase: "recovery-required" });
      throw error;
    } finally {
      leases?.release();
    }
  });
}
