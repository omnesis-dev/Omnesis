// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertManagedDesktopDataAuthority } from "@omnesis/core";
import { runDesktopDataOperation } from "./data-operation-channel.js";
import { assertDesktopConfigSecretsProtected } from "./config-protection.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { stopDesktopDaemon } from "./daemon-control.js";
import { desktopRestoreBlocked } from "./restore-intent.js";
import { desktopRootIdentity, readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { writeDesktopActiveRuntime } from "./update-active.js";
import {
  createDesktopUpdateSnapshot,
  restoreDesktopUpdateSnapshot,
  verifyDesktopUpdateSnapshot,
} from "./update-snapshot.js";
import {
  desktopUpdateStateSchema,
  readDesktopUpdateState,
  writeDesktopUpdateState,
  type DesktopUpdateState,
} from "./update-state.js";
import type { DesktopProfile } from "./environment.js";

interface UpdateDataOperations {
  authorize: typeof assertManagedDesktopDataAuthority;
  stop: typeof stopDesktopDaemon;
  reserve: typeof acquireDesktopRuntimeLeases;
  snapshot: typeof createDesktopUpdateSnapshot;
  restore: typeof restoreDesktopUpdateSnapshot;
  verify: typeof verifyDesktopUpdateSnapshot;
}
const defaults: UpdateDataOperations = {
  authorize: assertManagedDesktopDataAuthority,
  stop: stopDesktopDaemon,
  reserve: acquireDesktopRuntimeLeases,
  snapshot: createDesktopUpdateSnapshot,
  restore: restoreDesktopUpdateSnapshot,
  verify: verifyDesktopUpdateSnapshot,
};

/** Fixed host entry: the native EX descriptor remains held through every byte and durable transition. */
export async function finishDesktopUpdateSnapshot(
  profile: DesktopProfile,
  operationId: string,
  signal: AbortSignal,
  overrides: Partial<UpdateDataOperations> = {},
): Promise<DesktopUpdateState> {
  const deps = { ...defaults, ...overrides };
  deps.authorize(profile, "update-snapshot", operationId);
  return withDesktopInstallLease(profile, signal, async () => {
    let state = await operationState(profile, operationId, "stopping");
    await assertDesktopConfigSecretsProtected(profile, signal);
    const stopped = await deps.stop(profile, signal);
    const leases = await deps.reserve(profile, {
      expectedRoot: state.root,
      signal,
      runtimeWaitMs: stopped ? 5_000 : 0,
    });
    try {
      const backup = await deps.snapshot(profile, { operationId, leases, signal });
      await deps.verify(profile, { operationId, manifestSha256: backup.manifestSha256, signal });
      signal.throwIfAborted();
      state = { ...state, phase: "backed-up", backup };
      await writeDesktopUpdateState(profile, state);
      return state;
    } finally {
      leases.release();
    }
  });
}

/** No presentation callback, arbitrary module or recovery key can select the native operation. */
export async function finishDesktopUpdateRollback(
  profile: DesktopProfile,
  operationId: string,
  signal: AbortSignal,
  overrides: Partial<UpdateDataOperations> = {},
): Promise<DesktopUpdateState> {
  const deps = { ...defaults, ...overrides };
  deps.authorize(profile, "update-rollback", operationId);
  return withDesktopInstallLease(profile, signal, async () => {
    let state = await operationState(profile, operationId, "recovery-required");
    const stopped = await deps.stop(profile, signal);
    const leases = await deps.reserve(profile, {
      expectedRoot: state.root,
      signal,
      runtimeWaitMs: stopped ? 5_000 : 0,
    });
    try {
      if (state.backup) {
        await deps.verify(profile, {
          operationId,
          manifestSha256: state.backup.manifestSha256,
          signal,
        });
        await deps.restore(profile, { operationId, snapshot: state.backup, leases, signal });
      }
      signal.throwIfAborted();
      await writeDesktopActiveRuntime(profile, state.oldEpoch, state.oldVersion);
      state = { ...state, phase: "resumed" };
      await writeDesktopUpdateState(profile, state);
      return state;
    } finally {
      leases.release();
    }
  });
}

async function operationState(
  profile: DesktopProfile,
  operationId: string,
  phase: "stopping" | "recovery-required",
): Promise<DesktopUpdateState> {
  if ((await readDesktopRetirement(profile)) || (await desktopRestoreBlocked(profile)))
    throw new Error("Finish the pending removal or backup restore before updating");
  const state = await readDesktopUpdateState(profile);
  if (
    !state ||
    state.operationId !== operationId ||
    state.phase !== phase ||
    !sameDesktopRoot(await desktopRootIdentity(profile), state.root)
  )
    throw new Error("The requested update data operation changed");
  return state;
}

export async function runDesktopUpdateDataOperation(
  profile: DesktopProfile,
  operationId: string,
  purpose: "update-snapshot" | "update-rollback",
  signal: AbortSignal,
): Promise<DesktopUpdateState> {
  const result = desktopUpdateStateSchema.parse(
    await runDesktopDataOperation(
      { version: 1, purpose, operationId, profile, payload: {} },
      signal,
    ),
  );
  if (
    result.instance !== profile.instance ||
    result.secretService !== profile.secretService ||
    result.operationId !== operationId
  )
    throw new Error("The update data operation returned another installation");
  return result;
}
