// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { desktopRootIdentity, sameDesktopRoot } from "./retirement.js";
import { readDesktopRestoreIntent } from "./restore-intent.js";
import { readDesktopUpdateState } from "./update-state.js";
import {
  desktopSnapshotStagingPath,
  readDesktopSnapshotOwner,
  snapshotDirectoryIdentity,
} from "./snapshot-owner.js";
import {
  MAX_RETAINED_DESKTOP_SNAPSHOTS,
  desktopSnapshotDisposition,
  readDesktopSnapshotRetention,
} from "./snapshot-retention-record.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopRecoveryCopiesCatalog {
  kind: "desktopRecoveryCopies";
  limit: typeof MAX_RETAINED_DESKTOP_SNAPSHOTS;
  items: Array<{
    id: string;
    purpose: "update" | "restore";
    oldVersion: string;
    registeredAt: string;
    bytes: number;
    pinned: boolean;
    order: number;
    disposition:
      | "pinned"
      | "current-operation"
      | "latest"
      | "redundant-snapshot"
      | "last-copy-old-epoch"
      | "unavailable";
    canReview: boolean;
  }>;
  partialCopies: Array<{
    id: string;
    purpose: "update" | "restore";
    staging: boolean;
    ownership: "verified" | "unknown";
    canReview: boolean;
  }>;
  pending: {
    id: string;
    phase: "planned" | "deleting";
    canCancel: boolean;
    snapshotId: string;
    staging: boolean;
    mode: "redundant-snapshot" | "last-copy-old-epoch" | "incomplete-owned";
    keeperId: string | null;
  } | null;
  unregisteredCopies: number;
}
/** Metadata-only catalog: no source paths, server Save paths, code epochs, credentials or file contents. */
export async function desktopRecoveryCopiesCatalog(
  profile: DesktopProfile,
  signal: AbortSignal,
): Promise<DesktopRecoveryCopiesCatalog> {
  signal.throwIfAborted();
  const ledger = await readDesktopSnapshotRetention(profile),
    state = await readDesktopUpdateState(profile),
    restore = await readDesktopRestoreIntent(profile);
  const root = await desktopRootIdentity(profile);
  if (
    (ledger && !sameDesktopRoot(ledger.root, root)) ||
    (state && root && !sameDesktopRoot(state.root, root)) ||
    (restore && root && !sameDesktopRoot(restore.root, root))
  )
    throw new Error("The recovery copies belong to an earlier library folder");
  const protectedOperations = new Set([
    ...(state ? [state.operationId] : []),
    ...(restore?.backup ? [restore.operationId] : []),
  ]);
  const result: DesktopRecoveryCopiesCatalog = {
    kind: "desktopRecoveryCopies",
    limit: MAX_RETAINED_DESKTOP_SNAPSHOTS,
    items: [],
    partialCopies: [],
    pending: ledger?.pending
      ? {
          id: ledger.pending.operationId,
          phase: ledger.pending.phase,
          canCancel: ledger.pending.phase === "planned",
          snapshotId: ledger.pending.snapshotId,
          staging: ledger.pending.target.staging,
          mode: ledger.pending.mode,
          keeperId: ledger.pending.keeper?.operationId ?? null,
        }
      : null,
    unregisteredCopies: 0,
  };
  const backups = join(profile.configDir, "backups");
  let available = true;
  try {
    await snapshotDirectoryIdentity(backups);
  } catch (error) {
    if (missing(error)) available = false;
    else throw error;
  }
  if (ledger)
    for (const row of ledger.records.slice().sort((a, b) => b.order - a.order)) {
      signal.throwIfAborted();
      const disposition = desktopSnapshotDisposition(ledger, row.operationId, protectedOperations);
      let present = available;
      if (present)
        try {
          present = sameDesktopRoot(
            row.directory,
            await snapshotDirectoryIdentity(join(backups, `desktop-update-${row.operationId}`)),
          );
        } catch {
          present = false;
        }
      result.items.push({
        id: row.operationId,
        purpose: row.purpose,
        oldVersion: row.oldVersion,
        registeredAt: row.registeredAt,
        bytes: row.bytes,
        pinned: row.pinned,
        order: row.order,
        disposition: !present
          ? "unavailable"
          : disposition.kind === "keep"
            ? disposition.reason === "unregistered"
              ? "current-operation"
              : disposition.reason
            : disposition.kind,
        canReview: present && disposition.kind !== "keep" && !ledger.pending,
      });
    }
  if (!available) return result;
  for (const [journal, purpose] of [
    [state, "update"],
    [restore, "restore"],
  ] as const) {
    if (!journal) continue;
    for (const staging of [true, false]) {
      signal.throwIfAborted();
      if (!staging && journal.backup) continue;
      const path = staging
        ? desktopSnapshotStagingPath(profile, journal.operationId)
        : join(profile.configDir, "backups", `desktop-update-${journal.operationId}`);
      try {
        await lstat(path);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      let ownership: "verified" | "unknown" = "unknown";
      try {
        await readDesktopSnapshotOwner(profile, journal.operationId, path);
        ownership = "verified";
      } catch {
        /* Unknown ownership remains visible and kept. */
      }
      result.partialCopies.push({
        id: journal.operationId,
        purpose,
        staging,
        ownership,
        canReview: ownership === "verified" && !ledger?.pending,
      });
    }
  }
  // Names identify uncertainty only; they never grant ownership or deletion rights.
  let directory;
  try {
    directory = await opendir(backups);
  } catch (error) {
    if (missing(error)) return result;
    throw error;
  }
  let count = 0;
  for await (const entry of directory) {
    signal.throwIfAborted();
    if (++count > 100_000) throw new Error("The backup folder has too many entries to list safely");
    const match = /^desktop-update-([a-f0-9-]{36})$/u.exec(entry.name);
    if (
      match &&
      !ledger?.records.some((row) => row.operationId === match[1]) &&
      match[1] !== state?.operationId &&
      match[1] !== restore?.operationId
    )
      result.unregisteredCopies++;
  }
  return result;
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
