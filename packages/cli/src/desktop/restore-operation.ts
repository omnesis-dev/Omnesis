// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { withDesktopInstallLease } from "./bootstrap.js";
import { assertDesktopMutationAllowed } from "./update-admission.js";
import { assertDesktopConfigSecretsProtected } from "./config-protection.js";
import { stopDesktopDaemon } from "./daemon-control.js";
import {
  DesktopRestoreProtection,
  type DesktopRestoreProtectionIdentity,
} from "./restore-protection.js";
import { readDesktopRestoreIntent, writeDesktopRestoreIntent } from "./restore-intent.js";
import { runDesktopDataOperation } from "./data-operation-channel.js";
import { withDesktopRestoreOperationLease } from "./restore-owner.js";
import { desktopRestoreExpandedBytes } from "./restore-capacity.js";
import type { DesktopProfile } from "./environment.js";
import type { DesktopBackupArchive } from "./restore-archive.js";
import type { DesktopRestoreEntries } from "./restore-entries.js";

export interface DesktopRestoreOperationPayload {
  expandedBytes: number;
  sourceRootKey: string;
  protection: DesktopRestoreProtectionIdentity;
  stagingRoot: string;
}
/** The caller retains the import-session lease until this native host physically exits. */
export async function runDesktopRestoreOperation(
  profile: DesktopProfile,
  input: {
    archive: DesktopBackupArchive;
    entries: DesktopRestoreEntries;
    protection: DesktopRestoreProtectionIdentity;
    stagingRoot: string;
  },
  signal: AbortSignal,
  dependencies: { execute?: typeof runDesktopDataOperation } = {},
): Promise<{ operationId: string; sourcesPaused: number; watchesPaused: number }> {
  const operationId = await withDesktopInstallLease(profile, signal, async () => {
    await assertDesktopMutationAllowed(profile);
    await assertDesktopConfigSecretsProtected(profile, signal);
    const protection = await DesktopRestoreProtection.capture(profile, signal);
    try {
      if (!protection.matches(input.protection))
        throw new Error("Preview the changed library again");
      const id = randomUUID();
      await writeDesktopRestoreIntent(profile, {
        version: 1,
        owner: "omnesis-desktop",
        instance: profile.instance,
        secretService: profile.secretService,
        operationId: id,
        phase: "stopping",
        root: input.protection.root,
        targetKeyDigest: input.protection.keyDigest,
        archiveSha256: input.archive.sha256,
        archiveBytes: input.archive.bytes,
        backup: null,
      });
      await stopDesktopDaemon(profile, signal);
      return id;
    } finally {
      protection.close();
    }
  });
  const payload: DesktopRestoreOperationPayload = {
    expandedBytes: desktopRestoreExpandedBytes(input.archive),
    sourceRootKey: input.entries.privateOperationSourceKey(),
    protection: input.protection,
    stagingRoot: input.stagingRoot,
  };
  try {
    const result = await (dependencies.execute ?? runDesktopDataOperation)(
      { version: 1, purpose: "restore", operationId, profile, payload },
      signal,
    );
    if (
      !result ||
      typeof result !== "object" ||
      !("operationId" in result) ||
      result.operationId !== operationId ||
      !("sourcesPaused" in result) ||
      !count(result.sourcesPaused) ||
      !("watchesPaused" in result) ||
      !count(result.watchesPaused)
    )
      throw new Error("The restore result could not be verified");
    return {
      operationId,
      sourcesPaused: result.sourcesPaused,
      watchesPaused: result.watchesPaused,
    };
  } finally {
    payload.sourceRootKey = "";
  }
}

export async function runDesktopRestoreRecovery(
  profile: DesktopProfile,
  operationId: string,
  signal: AbortSignal,
  dependencies: { execute?: typeof runDesktopDataOperation } = {},
): Promise<{ recoveryCopyRetained: boolean }> {
  return withDesktopRestoreOperationLease(profile, signal, async () => {
    await withDesktopInstallLease(profile, signal, async () => {
      const intent = await readDesktopRestoreIntent(profile);
      if (
        !intent ||
        intent.operationId !== operationId ||
        ["complete", "rolled-back"].includes(intent.phase)
      )
        throw new Error("There is no matching interrupted restore");
      await stopDesktopDaemon(profile, signal);
    });
    const result = await (dependencies.execute ?? runDesktopDataOperation)(
      { version: 1, purpose: "rollback", operationId, profile, payload: {} },
      signal,
    );
    if (
      !result ||
      typeof result !== "object" ||
      !("recoveryCopyRetained" in result) ||
      typeof result.recoveryCopyRetained !== "boolean"
    )
      throw new Error("Recovery could not be verified");
    return { recoveryCopyRetained: result.recoveryCopyRetained };
  });
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
