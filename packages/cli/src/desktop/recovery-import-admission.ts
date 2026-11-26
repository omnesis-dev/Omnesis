// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { installRootKeyBytes, type ManagedDesktopKeyRecoveryContext } from "@omnesis/core";
import { readDesktopInstall, withDesktopInstallLease } from "./bootstrap.js";
import { assertDesktopProfileGeneration } from "./generation.js";
import { assertDesktopProcessAuthority } from "./process-authority.js";
import { readDesktopRestoreIntent } from "./restore-intent.js";
import { withDesktopRestoreOperationLease } from "./restore-owner.js";
import { desktopRootIdentity, readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import { desktopSourceDevelopment, readDesktopActiveRuntime } from "./update-active.js";
import { desktopRuntimeEpoch, readDesktopUpdateState } from "./update-state.js";
import type { DesktopProfile } from "./environment.js";

const refused = () =>
  new Error("The library recovery context changed. Review its protection before retrying.");
async function binding(profile: DesktopProfile) {
  assertDesktopProfileGeneration(profile);
  await assertDesktopProcessAuthority(profile);
  if (await readDesktopRetirement(profile))
    throw new Error("This installation has retired; recovery cannot revive it");
  const install = await readDesktopInstall(profile);
  if (!install || install.phase !== "configured" || install.mode !== "home")
    throw new Error("Restore recovery protection on the Mac that owns this library.");
  const root = await desktopRootIdentity(profile);
  if (!root) throw refused();
  const update = await readDesktopUpdateState(profile);
  const restore = await readDesktopRestoreIntent(profile);
  const active = await readDesktopActiveRuntime(profile);
  if (
    (update && !sameDesktopRoot(root, update.root)) ||
    (restore && !sameDesktopRoot(root, restore.root))
  )
    throw refused();
  const epoch = desktopRuntimeEpoch();
  if (epoch === null) {
    if (!desktopSourceDevelopment()) throw refused();
  } else if (update) {
    if (
      ![update.oldEpoch, update.candidateEpoch].includes(epoch) ||
      (active && ![update.oldEpoch, update.candidateEpoch].includes(active.epoch))
    )
      throw refused();
  } else if (active ? active.epoch !== epoch : restore !== null) throw refused();
  const context: ManagedDesktopKeyRecoveryContext = {
    version: 1,
    scope: { format: 1, ...profile },
    root,
    update: update ? { operationId: update.operationId, phase: update.phase } : null,
    restore: restore
      ? {
          operationId: restore.operationId,
          phase: restore.phase,
          targetKeyDigest: restore.targetKeyDigest,
        }
      : null,
  };
  return { context, witness: JSON.stringify({ install, root, update, restore, active, epoch }) };
}

/** Explicit original-key import only; ordinary publication/startup fences stay unchanged. */
export async function withDesktopKeyRecoveryAdmission<T>(
  profile: DesktopProfile,
  signal: AbortSignal,
  work: (admission: {
    context: ManagedDesktopKeyRecoveryContext;
    assertCurrent(): Promise<void>;
    assertKey(candidate: string): void;
  }) => Promise<T>,
): Promise<T> {
  return withDesktopRestoreOperationLease(profile, signal, () =>
    withDesktopInstallLease(profile, signal, async () => {
      signal.throwIfAborted();
      const selected = await binding(profile);
      return work({
        context: selected.context,
        async assertCurrent() {
          if ((await binding(profile)).witness !== selected.witness) throw refused();
        },
        assertKey(candidate) {
          const expected = selected.context.restore?.targetKeyDigest;
          if (!expected) return;
          const bytes = installRootKeyBytes(candidate);
          try {
            if (createHash("sha256").update(bytes).digest("hex") !== expected) throw refused();
          } finally {
            bytes.fill(0);
          }
        },
      });
    }),
  );
}
