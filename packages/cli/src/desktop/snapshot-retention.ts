// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { lstat, open, opendir, realpath, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withDesktopInstallLease } from "./bootstrap.js";
import { DesktopSnapshotRetentionFailure } from "./snapshot-retention-errors.js";
import { desktopRootIdentity, readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import {
  desktopRestoreBlocked,
  readDesktopRestoreIntent,
  type DesktopRestoreIntent,
} from "./restore-intent.js";
import {
  MAX_RETAINED_DESKTOP_SNAPSHOTS,
  readDesktopSnapshotRetention,
  writeDesktopSnapshotRetention,
  type DesktopSnapshotRetentionRecord,
  type RetainedDesktopSnapshot,
} from "./snapshot-retention-record.js";
import { desktopUpdateSnapshotPath, verifyDesktopUpdateSnapshot } from "./update-snapshot.js";
import { desktopSnapshotStagingPath, snapshotDirectoryIdentity } from "./snapshot-owner.js";
import { desktopRuntimeEpoch, type DesktopUpdateState } from "./update-state.js";
import { runDesktopSnapshotReservation } from "./snapshot-retention-native.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopRetainedSnapshotSummary {
  id: string;
  purpose: "update" | "restore";
  oldVersion: string;
  registeredAt: string;
  bytes: number;
  pinned: boolean;
  order: number;
}
interface RetentionDependencies {
  verify: typeof verifyDesktopUpdateSnapshot;
}
const defaults: RetentionDependencies = { verify: verifyDesktopUpdateSnapshot };

/** Caller holds the installation lease. Register before replacing a completed update journal. */
export async function registerVerifiedDesktopSnapshot(
  profile: DesktopProfile,
  state: DesktopUpdateState,
  signal: AbortSignal,
  dependencies: RetentionDependencies = defaults,
): Promise<void> {
  if (
    !["complete", "resumed"].includes(state.phase) ||
    !state.backup ||
    state.instance !== profile.instance ||
    state.secretService !== profile.secretService ||
    !sameDesktopRoot(await desktopRootIdentity(profile), state.root)
  )
    throw new Error(
      "Only a verified completed or recovered update can register a recovery snapshot",
    );
  return registerOwnedSnapshot(
    profile,
    { ...state, backup: state.backup, purpose: "update" },
    signal,
    dependencies,
  );
}
/** Missing historical runtime evidence remains unknown; it is never guessed from a filename. */
export async function registerVerifiedDesktopRestoreSnapshot(
  profile: DesktopProfile,
  state: DesktopRestoreIntent,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    state.instance !== profile.instance ||
    state.secretService !== profile.secretService ||
    !sameDesktopRoot(await desktopRootIdentity(profile), state.root)
  )
    throw new Error("The recovery copy belongs to another library");
  if (!["complete", "rolled-back"].includes(state.phase))
    throw new Error("Finish the restore before registering its recovery copy");
  if (!state.backup) return false;
  if (!state.backupRuntime) {
    await defaults.verify(profile, {
      operationId: state.operationId,
      manifestSha256: state.backup.manifestSha256,
      signal,
    });
    return false;
  }
  await registerOwnedSnapshot(
    profile,
    {
      operationId: state.operationId,
      root: state.root,
      backup: state.backup,
      oldEpoch: state.backupRuntime.epoch,
      oldVersion: state.backupRuntime.version,
      purpose: "restore",
    },
    signal,
    defaults,
  );
  return true;
}
async function registerOwnedSnapshot(
  profile: DesktopProfile,
  state: {
    operationId: string;
    root: { device: string; inode: string };
    backup: { manifestSha256: string; bytes: number };
    oldEpoch: string;
    oldVersion: string;
    purpose: "update" | "restore";
  },
  signal: AbortSignal,
  dependencies: RetentionDependencies,
): Promise<void> {
  signal.throwIfAborted();
  const ledger =
    (await readDesktopSnapshotRetention(profile)) ??
    ({
      format: 1,
      owner: "omnesis-desktop",
      instance: profile.instance,
      secretService: profile.secretService,
      root: state.root,
      sequence: 0,
      records: [],
      pending: null,
    } satisfies DesktopSnapshotRetentionRecord);
  assertRoot(ledger, state.root);
  if (ledger.pending) throw new DesktopSnapshotRetentionFailure("RECOVERY_CLEANUP_PENDING");
  const directory = await snapshotDirectory(profile, state.operationId);
  const existing = ledger.records.find((row) => row.operationId === state.operationId);
  if (
    existing &&
    (existing.purpose !== state.purpose ||
      existing.oldEpoch !== state.oldEpoch ||
      existing.oldVersion !== state.oldVersion ||
      existing.manifestSha256 !== state.backup.manifestSha256 ||
      existing.bytes !== state.backup.bytes ||
      !sameDesktopRoot(existing.directory, directory))
  )
    throw new Error("A registered recovery snapshot changed identity");
  if (!existing && ledger.records.length >= MAX_RETAINED_DESKTOP_SNAPSHOTS) capacity();
  await dependencies.verify(profile, {
    operationId: state.operationId,
    manifestSha256: state.backup.manifestSha256,
    signal,
  });
  if (
    !sameDesktopRoot(directory, await snapshotDirectory(profile, state.operationId)) ||
    !sameDesktopRoot(await desktopRootIdentity(profile), state.root)
  )
    throw new Error("The recovery snapshot changed while it was verified");
  signal.throwIfAborted();
  if (existing) return;
  if (!Number.isSafeInteger(ledger.sequence + 1)) capacity();
  ledger.sequence++;
  ledger.records.push({
    operationId: state.operationId,
    oldEpoch: state.oldEpoch,
    purpose: state.purpose,
    oldVersion: state.oldVersion,
    registeredAt: new Date().toISOString(),
    manifestSha256: state.backup.manifestSha256,
    bytes: state.backup.bytes,
    directory,
    order: ledger.sequence,
    pinned: false,
  });
  await writeDesktopSnapshotRetention(profile, ledger);
}
/** Never replace the sole operation binding for an incomplete automatic copy. */
export async function retainDesktopUpdateBeforeReplacement(
  profile: DesktopProfile,
  state: DesktopUpdateState | null,
  signal: AbortSignal,
): Promise<void> {
  if (state) {
    if (
      state.instance !== profile.instance ||
      state.secretService !== profile.secretService ||
      !sameDesktopRoot(state.root, await desktopRootIdentity(profile))
    )
      throw new Error("The earlier update belongs to a different library folder");
    await assertDesktopSnapshotStageSettled(
      profile,
      state.operationId,
      state.backup !== null,
      signal,
    );
    if (["complete", "resumed"].includes(state.phase) && state.backup)
      await registerVerifiedDesktopSnapshot(profile, state, signal);
    else if (state.backup) throw new DesktopSnapshotRetentionFailure("RECOVERY_COPY_INCOMPLETE");
  }
  const restore = await readDesktopRestoreIntent(profile);
  if (restore?.backup && ["complete", "rolled-back"].includes(restore.phase))
    await registerVerifiedDesktopRestoreSnapshot(profile, restore, signal);
  await assertDesktopSnapshotRetentionCapacity(profile);
}
/** Caller has already validated the journal's profile and physical root. */
export async function assertDesktopSnapshotStageSettled(
  profile: DesktopProfile,
  id: string,
  hasBackup: boolean,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (await discardEmptyStagingDirectory(profile, id))
    throw new DesktopSnapshotRetentionFailure("RECOVERY_COPY_INCOMPLETE");
  if (!hasBackup)
    try {
      await lstat(desktopUpdateSnapshotPath(profile, id));
      throw new DesktopSnapshotRetentionFailure("RECOVERY_COPY_INCOMPLETE");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
}
/** Refuse before staging/stopping another update if its automatic copy cannot be registered. */
export async function assertDesktopSnapshotRetentionCapacity(
  profile: DesktopProfile,
): Promise<void> {
  const ledger = await readDesktopSnapshotRetention(profile);
  if (!ledger) return;
  assertRoot(ledger, await desktopRootIdentity(profile));
  if (ledger.pending) throw new DesktopSnapshotRetentionFailure("RECOVERY_CLEANUP_PENDING");
  if (ledger.records.length >= MAX_RETAINED_DESKTOP_SNAPSHOTS) capacity();
}
export async function listRetainedDesktopSnapshots(
  profile: DesktopProfile,
): Promise<DesktopRetainedSnapshotSummary[]> {
  const ledger = await readDesktopSnapshotRetention(profile);
  if (!ledger) return [];
  assertRoot(ledger, await desktopRootIdentity(profile));
  return ledger.records
    .slice()
    .sort((a, b) => b.order - a.order)
    .map((row) => ({
      id: row.operationId,
      purpose: row.purpose,
      oldVersion: row.oldVersion,
      registeredAt: row.registeredAt,
      bytes: row.bytes,
      pinned: row.pinned,
      order: row.order,
    }));
}
/** Pinning never implies that a snapshot or old application is eligible for deletion. */
export async function pinRetainedDesktopSnapshot(
  profile: DesktopProfile,
  id: string,
  pinned: boolean,
  signal: AbortSignal,
): Promise<DesktopRetainedSnapshotSummary[]> {
  if (!/^[a-f0-9-]{36}$/u.test(id) || typeof pinned !== "boolean")
    throw new Error("Choose a registered recovery snapshot and its keep setting");
  return withDesktopInstallLease(profile, signal, async () => {
    if ((await readDesktopRetirement(profile)) || (await desktopRestoreBlocked(profile)))
      throw new Error("Finish removal or backup restore before changing recovery copies");
    const ledger = await readDesktopSnapshotRetention(profile);
    if (!ledger) throw new Error("This recovery snapshot is not registered");
    assertRoot(ledger, await desktopRootIdentity(profile));
    if (ledger.pending) throw new DesktopSnapshotRetentionFailure("RECOVERY_CLEANUP_PENDING");
    const record = ledger.records.find((row) => row.operationId === id);
    if (!record) throw new Error("This recovery snapshot is not registered");
    signal.throwIfAborted();
    record.pinned = pinned;
    await writeDesktopSnapshotRetention(profile, ledger);
    return listRetainedDesktopSnapshots(profile);
  });
}
export function latestRetainedDesktopSnapshot(
  record: DesktopSnapshotRetentionRecord,
): RetainedDesktopSnapshot | undefined {
  return record.records.reduce<RetainedDesktopSnapshot | undefined>(
    (latest, row) => (latest === undefined || row.order > latest.order ? row : latest),
    undefined,
  );
}
async function snapshotDirectory(profile: DesktopProfile, id: string) {
  const path = desktopUpdateSnapshotPath(profile, id),
    metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077n) !== 0n ||
    (process.getuid && metadata.uid !== BigInt(process.getuid())) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("The recovery snapshot must remain a private owned directory");
  return { device: String(metadata.dev), inode: String(metadata.ino) };
}
/** Only removes an empty metadata draft. The kernel refuses a directory that acquires any contents. */
async function discardEmptyStagingDirectory(profile: DesktopProfile, id: string): Promise<boolean> {
  const path = desktopSnapshotStagingPath(profile, id);
  try {
    await snapshotDirectoryIdentity(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const directory = await opendir(path);
  let empty: boolean;
  try {
    empty = (await directory.read()) === null;
  } finally {
    await directory.close();
  }
  if (!empty) return true;
  await rmdir(path);
  const parent = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return false;
}
function assertRoot(
  record: DesktopSnapshotRetentionRecord,
  root: { device: string; inode: string } | null,
): void {
  if (!sameDesktopRoot(record.root, root))
    throw new Error("The recovery snapshot ledger belongs to an earlier library folder");
}
function capacity(): never {
  throw new DesktopSnapshotRetentionFailure("RECOVERY_COPIES_FULL");
}

/** A planned cleanup has removed no bytes. Once deletion starts, only its exact retry can finish it. */
export async function cancelDesktopSnapshotCleanup(
  profile: DesktopProfile,
  operationId: string,
  signal: AbortSignal,
  dependencies: { releaseReservation?: typeof runDesktopSnapshotReservation } = {},
): Promise<{ cancelled: boolean }> {
  return withDesktopInstallLease(profile, signal, async () => {
    const ledger = await readDesktopSnapshotRetention(profile);
    if (!ledger?.pending) return { cancelled: false };
    assertRoot(ledger, await desktopRootIdentity(profile));
    if (ledger.pending.operationId !== operationId)
      throw new Error("Review the pending recovery cleanup again");
    if (ledger.pending.phase !== "planned")
      throw new DesktopSnapshotRetentionFailure("RECOVERY_CLEANUP_PENDING");
    signal.throwIfAborted();
    // The native receipt must be released before its matching private intent disappears.
    // Source-only metadata fixtures have no managed runtime or global native reservation.
    if (dependencies.releaseReservation || desktopRuntimeEpoch())
      await (dependencies.releaseReservation ?? runDesktopSnapshotReservation)(
        profile,
        operationId,
        signal,
        "cancel",
      );
    ledger.pending = null;
    await writeDesktopSnapshotRetention(profile, ledger);
    return { cancelled: true };
  });
}
