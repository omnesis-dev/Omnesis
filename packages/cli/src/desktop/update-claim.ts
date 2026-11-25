// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  desktopSourceDevelopment,
  readCurrentDesktopMetadata,
  readDesktopActiveRuntime,
  writeDesktopActiveRuntime,
} from "./update-active.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopRestoreBlocked } from "./restore-intent.js";
import { desktopRootIdentity, readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import { verifyDesktopUpdateSnapshot } from "./update-snapshot.js";
import {
  desktopRuntimeEpoch,
  desktopUpdateEpochDisposition,
  readDesktopUpdateState,
  writeDesktopUpdateState,
} from "./update-state.js";
import type { DesktopProfile } from "./environment.js";

/** Caller owns runtime-owner. Record the migration boundary BEFORE spawning code that can open stores. */
export async function claimDesktopUpdateEpoch(
  profile: DesktopProfile,
  signal: AbortSignal,
  epoch: string | null = desktopRuntimeEpoch(),
): Promise<boolean> {
  return withDesktopInstallLease(profile, signal, async () => {
    if (await desktopRestoreBlocked(profile)) return false;
    if (await readDesktopRetirement(profile)) return false;
    const state = await readDesktopUpdateState(profile);
    const active = await readDesktopActiveRuntime(profile);
    if (!state) {
      if (active && active.epoch !== epoch) return false;
      if (epoch === null) return active === null && desktopSourceDevelopment();
      const current = await readCurrentDesktopMetadata();
      await writeDesktopActiveRuntime(profile, epoch, current.productVersion);
      return true;
    }
    const admission = desktopUpdateEpochDisposition(state, epoch);
    if (admission === "block") return false;
    if (epoch === null) return false;
    const changingCandidate =
      epoch === state.candidateEpoch &&
      ["backed-up", "installer-opened", "candidate-started"].includes(state.phase);
    const restoringPrevious = epoch === state.oldEpoch && state.phase === "resumed";
    if (
      active &&
      active.epoch !== epoch &&
      !(changingCandidate && active.epoch === state.oldEpoch) &&
      !(restoringPrevious && active.epoch === state.candidateEpoch)
    )
      return false;
    if (admission === "allow") {
      await writeDesktopActiveRuntime(
        profile,
        epoch,
        epoch === state.oldEpoch ? state.oldVersion : state.candidateVersion,
      );
      return true;
    }
    if (!state.backup || !sameDesktopRoot(await desktopRootIdentity(profile), state.root))
      throw new Error("The desktop update's recovery snapshot is unavailable");
    await verifyDesktopUpdateSnapshot(profile, {
      operationId: state.operationId,
      manifestSha256: state.backup.manifestSha256,
      signal,
    });
    signal.throwIfAborted();
    await writeDesktopUpdateState(profile, { ...state, phase: "candidate-started" });
    await writeDesktopActiveRuntime(profile, epoch, state.candidateVersion);
    return true;
  });
}
