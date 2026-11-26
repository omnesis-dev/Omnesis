// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Builtins-only phase two. This module is deliberately not a public bridge command.
import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { snapshotDirectoryIdentity } from "./snapshot-owner.js";
import {
  desktopSnapshotDisposition,
  readDesktopSnapshotRetention,
  writeDesktopSnapshotRetention,
  type DesktopSnapshotCleanupReceipt,
} from "./snapshot-retention-record.js";
import { assertDesktopSnapshotWitness, snapshotWitnessPath } from "./snapshot-retention-witness.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopSnapshotDeletionResult {
  status: "removed";
  operationId: string;
  snapshotId: string;
  bytes: number | null;
}
interface SnapshotDeletionAuthority {
  /** Fixed native host supplies its captured authority; source tests explicitly substitute the OS boundary. */
  assert(profile: DesktopProfile, receipt: DesktopSnapshotCleanupReceipt): void;
  remove?: typeof rm;
}
/** The fixed host must retain the actual install owner and native DATA/publication reservations through return. */
export async function finishDesktopSnapshotCleanup(
  profile: DesktopProfile,
  operationId: string,
  signal: AbortSignal,
  authority: SnapshotDeletionAuthority,
): Promise<DesktopSnapshotDeletionResult> {
  const ledger = await readDesktopSnapshotRetention(profile),
    receipt = ledger?.pending;
  if (!ledger || !receipt || receipt.operationId !== operationId)
    throw new Error("The reviewed recovery cleanup is unavailable");
  authority.assert(profile, receipt);
  const root = await snapshotDirectoryIdentity(profile.configDir);
  if (root.device !== ledger.root.device || root.inode !== ledger.root.inode)
    throw new Error("The managed library changed before recovery cleanup");
  if (receipt.mode !== "incomplete-owned") {
    const disposition = desktopSnapshotDisposition(
      ledger,
      receipt.snapshotId,
      new Set(
        [receipt.journals.updateId, receipt.journals.restoreId].filter(
          (id): id is string => id !== null,
        ),
      ),
    );
    if (
      disposition.kind !== receipt.mode ||
      (disposition.kind === "redundant-snapshot" &&
        disposition.keeper.operationId !== receipt.keeper?.operationId)
    )
      throw new Error("The retained recovery copy changed before cleanup");
  }
  if (receipt.keeper) await assertDesktopSnapshotWitness(profile, receipt.keeper, signal);
  if (receipt.phase === "planned") {
    await assertDesktopSnapshotWitness(profile, receipt.target, signal);
    signal.throwIfAborted();
    receipt.phase = "deleting";
    await writeDesktopSnapshotRetention(profile, ledger);
  }
  const path = snapshotWitnessPath(profile, receipt.target);
  let present = true;
  try {
    const directory = await snapshotDirectoryIdentity(path);
    if (
      directory.device !== receipt.target.directory.device ||
      directory.inode !== receipt.target.directory.inode
    )
      throw new Error("The selected recovery copy was replaced");
  } catch (error) {
    if (hasCode(error, "ENOENT")) present = false;
    else throw error;
  }
  signal.throwIfAborted();
  if (present) await (authority.remove ?? rm)(path, { recursive: true, force: false });
  try {
    await lstat(path);
    throw new Error("The recovery copy is still present after cleanup");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  await snapshotDirectoryIdentity(dirname(path));
  const parent = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  const after = await snapshotDirectoryIdentity(profile.configDir);
  if (root.device !== after.device || root.inode !== after.inode)
    throw new Error("The library changed before recovery cleanup completion");
  const bytes =
    receipt.mode === "incomplete-owned"
      ? null
      : (ledger.records.find((row) => row.operationId === receipt.snapshotId)?.bytes ?? null);
  if (receipt.mode !== "incomplete-owned")
    ledger.records = ledger.records.filter((row) => row.operationId !== receipt.snapshotId);
  ledger.pending = null;
  await writeDesktopSnapshotRetention(profile, ledger);
  return { status: "removed", operationId, snapshotId: receipt.snapshotId, bytes };
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
