// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDesktopInstallLease } from "./bootstrap.js";
import { assertDesktopProcessAuthority } from "./process-authority.js";
import { assertDesktopSnapshotCleanupReady } from "./snapshot-retention-phase-one.js";
import { prepareDesktopSnapshotCleanupLocked } from "./snapshot-retention-prepare.js";
import { desktopSnapshotCleanupBinding } from "./snapshot-retention-request.js";
import { runDesktopSnapshotCleanupHost } from "./snapshot-retention-channel.js";
import { cancelDesktopSnapshotCleanup } from "./snapshot-retention.js";
import {
  desktopRecoveryCopiesCatalog,
  type DesktopRecoveryCopiesCatalog,
} from "./snapshot-retention-catalog.js";
import { desktopRuntimeEpoch } from "./update-state.js";
import type { DesktopProfile } from "./environment.js";

export type DesktopRecoveryCleanupCommand =
  "recoveryCopyPreview" | "recoveryCopyRemove" | "recoveryCopyRetry" | "recoveryCopyCancel";
export function isDesktopRecoveryCleanupCommand(
  command: string,
): command is DesktopRecoveryCleanupCommand {
  return (
    command === "recoveryCopyPreview" ||
    command === "recoveryCopyRemove" ||
    command === "recoveryCopyRetry" ||
    command === "recoveryCopyCancel"
  );
}
export type DesktopRecoveryCleanupResult =
  | {
      kind: "desktopRecoveryCleanup";
      phase: "preview";
      id: string;
      confirmationId: string;
      bytes: number | null;
      mode: "redundant-snapshot" | "last-copy-old-epoch" | "incomplete-owned";
      message: string;
      selected?: DesktopRecoveryCopySummary;
      keeper?: DesktopRecoveryCopySummary;
    }
  | {
      kind: "desktopRecoveryCleanup";
      phase: "removed";
      id: string;
      operationId: string;
      bytes: number | null;
    };
interface DesktopRecoveryCopySummary {
  id: string;
  purpose: "update" | "restore";
  oldVersion: string;
  registeredAt: string;
  bytes: number;
  order: number;
}
const selection = z
  .object({ id: z.string().uuid(), incompleteStaging: z.boolean().optional() })
  .strict();
const confirmation = selection
  .extend({ confirmationId: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
const pending = z.object({ operationId: z.string().uuid() }).strict();
interface CleanupOperations {
  ready: typeof assertDesktopSnapshotCleanupReady;
  epoch: typeof desktopRuntimeEpoch;
  host: typeof runDesktopSnapshotCleanupHost;
  cancel: typeof cancelDesktopSnapshotCleanup;
}

/** Fixed native entry owns every destructive step; previews expose no server paths or code identities. */
export async function handleDesktopRecoveryCleanup(
  profile: DesktopProfile,
  command: DesktopRecoveryCleanupCommand,
  params: unknown,
  signal: AbortSignal,
  overrides: Partial<CleanupOperations> = {},
): Promise<DesktopRecoveryCleanupResult | DesktopRecoveryCopiesCatalog> {
  signal.throwIfAborted();
  await assertDesktopProcessAuthority(profile);
  const operations: CleanupOperations = {
    ready: assertDesktopSnapshotCleanupReady,
    epoch: desktopRuntimeEpoch,
    host: runDesktopSnapshotCleanupHost,
    cancel: cancelDesktopSnapshotCleanup,
    ...overrides,
  };
  if (command === "recoveryCopyPreview") {
    const input = selection.parse(params),
      epoch = operations.epoch();
    if (!epoch) throw new Error("Recovery cleanup requires the installed application runtime");
    await operations.ready(profile, signal);
    return withDesktopInstallLease(
      profile,
      signal,
      async (): Promise<DesktopRecoveryCleanupResult> => {
        const prepared = await prepareDesktopSnapshotCleanupLocked(
          profile,
          {
            snapshotId: input.id,
            incompleteStaging: input.incompleteStaging,
            currentEpoch: epoch,
          },
          signal,
        );
        const row = prepared.ledger.records.find((entry) => entry.operationId === input.id);
        const keeper = prepared.ledger.records.find(
          (entry) => entry.operationId === prepared.receipt.keeper?.operationId,
        );
        const summary = (entry: NonNullable<typeof row>): DesktopRecoveryCopySummary => ({
          id: entry.operationId,
          purpose: entry.purpose,
          oldVersion: entry.oldVersion,
          registeredAt: entry.registeredAt,
          bytes: entry.bytes,
          order: entry.order,
        });
        return {
          kind: "desktopRecoveryCleanup",
          phase: "preview",
          id: input.id,
          confirmationId: desktopSnapshotCleanupBinding(profile, prepared),
          bytes: prepared.receipt.mode === "incomplete-owned" ? null : (row?.bytes ?? null),
          mode: prepared.receipt.mode,
          ...(row && prepared.receipt.mode !== "incomplete-owned"
            ? { selected: summary(row) }
            : {}),
          ...(keeper ? { keeper: summary(keeper) } : {}),
          message:
            prepared.receipt.mode === "incomplete-owned"
              ? "Remove this unfinished automatic recovery copy. Personal backups and exports are kept."
              : "Remove this automatic recovery copy. Returning to that saved library state will no longer be available. Personal backups and exports are kept.",
        };
      },
    );
  }
  if (command === "recoveryCopyCancel") {
    const input = pending.parse(params);
    await operations.cancel(profile, input.operationId, signal);
    return withDesktopInstallLease(profile, signal, () =>
      desktopRecoveryCopiesCatalog(profile, signal),
    );
  }
  const retry = command === "recoveryCopyRetry";
  const input = retry ? pending.parse(params) : confirmation.parse(params);
  const operationId = "operationId" in input ? input.operationId : randomUUID();
  const result = await operations.host(
    operationId,
    {
      version: 1,
      profile,
      ...("operationId" in input
        ? { retry: true }
        : {
            snapshotId: input.id,
            expectedBinding: input.confirmationId,
            incompleteStaging: input.incompleteStaging,
          }),
    },
    signal,
  );
  return {
    kind: "desktopRecoveryCleanup",
    phase: "removed",
    id: result.snapshotId,
    operationId: result.operationId,
    bytes: result.bytes,
  };
}
