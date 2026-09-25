// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SourceId, sourceAccountOf } from "@omnesis/types";
import { BadRequestError } from "../errors.js";
import { getSyncState, getWipeEpoch } from "../../db.js";
import { isSourceRemoved } from "../../data/repositories/SourceRepository.js";
import { normalizeIcon } from "../../icon-normalizer.js";
import { invalidateUrlPatternCache } from "../../links.js";
import { epochScope, type SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import type Database from "better-sqlite3";
import type { SourceSyncMeta, SyncCursor } from "@omnesis/source-sdk";
import type { WriteGate } from "../../write-gate.js";

interface SourceSyncStateDeps {
  db: Database.Database;
  writeGate: WriteGate;
  sourceWriteEpochFence?: SourceWriteEpochFence;
}

/**
 * Rasterise every icon a meta push carries.
 *
 * The family's icon is a declaration in exactly the same form as the source's
 * own — a URL or a data URI, as `defineSource` wrote it — so it needs the same
 * treatment. Normalising only one of them stores a URL where every consumer
 * expects an embedded image, which renders as a missing glyph rather than an
 * error.
 */
async function normalizeMetaIcons(meta: SourceSyncMeta): Promise<SourceSyncMeta> {
  const icon =
    meta.icon !== undefined ? ((await normalizeIcon(meta.icon)) ?? undefined) : undefined;
  if (!meta.family) return { ...meta, icon };
  const familyIcon =
    meta.family.icon !== undefined
      ? ((await normalizeIcon(meta.family.icon)) ?? undefined)
      : undefined;
  return { ...meta, icon, family: { ...meta.family, icon: familyIcon } };
}

function validateAccount(sourceId: string, meta: SourceSyncMeta): void {
  if (meta.account && meta.account.id !== sourceAccountOf(sourceId)) {
    throw new BadRequestError("Account descriptor id must match the source account");
  }
}

/** Owns source write-authority claims and cursor-safe metadata writes. */
export class SourceSyncStateService {
  constructor(private readonly deps: SourceSyncStateDeps) {}

  /** Claim write authority on one cursor row (`""` = shared, else a member's own). */
  async beginAttempt(
    sourceId: string,
    attemptId?: string,
    cursorRow = "",
    assertSourceWireAuthority?: () => void,
  ): Promise<number | undefined> {
    const claim = () => {
      assertSourceWireAuthority?.();
      return this.deps.writeGate.beginSyncAttempt(sourceId, cursorRow);
    };
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.beginAttempt(
          epochScope(sourceId, cursorRow),
          attemptId,
          claim,
        )
      : claim();
  }

  async revokeAttempt(
    sourceId: string,
    expectedEpoch?: number,
    attemptId?: string,
    cursorRow = "",
    assertSourceWireAuthority?: () => void,
  ): Promise<boolean> {
    const revoke = (epoch: number) => {
      assertSourceWireAuthority?.();
      return this.deps.writeGate.revokeSyncAttempt(sourceId, epoch, cursorRow);
    };
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.cancelAttempt(
          epochScope(sourceId, cursorRow),
          attemptId,
          expectedEpoch,
          revoke,
        )
      : expectedEpoch === undefined
        ? false
        : revoke(expectedEpoch);
  }

  async setMeta(
    sourceId: string,
    meta: SourceSyncMeta,
    assertSourceWireAuthority?: () => void,
  ): Promise<void> {
    const set = () => {
      assertSourceWireAuthority?.();
      return this.setMetaFenced(sourceId, meta);
    };
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.run(epochScope(sourceId), set)
      : set();
  }

  private async setMetaFenced(sourceId: string, meta: SourceSyncMeta): Promise<void> {
    validateAccount(sourceId, meta);
    await this.deps.writeGate.setSourceMeta(sourceId, await normalizeMetaIcons(meta));
    if (meta.urlPatterns) invalidateUrlPatternCache();
  }

  async setLegacyState(
    sourceId: string,
    cursor: SyncCursor,
    meta: SourceSyncMeta,
    writeEpoch?: number,
    /** The row to write: `""` (shared) or a member device's own row. */
    deviceId = "",
    assertSourceWireAuthority?: () => void,
  ): Promise<boolean> {
    const set = () => {
      assertSourceWireAuthority?.();
      return this.setLegacyStateFenced(sourceId, cursor, meta, writeEpoch, deviceId);
    };
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.run(epochScope(sourceId, deviceId), set)
      : set();
  }

  private async setLegacyStateFenced(
    sourceId: string,
    cursor: SyncCursor,
    meta: SourceSyncMeta,
    writeEpoch?: number,
    deviceId = "",
  ): Promise<boolean> {
    if (isSourceRemoved(this.deps.db, SourceId(sourceId))) return false;
    validateAccount(sourceId, meta);
    const written = await this.deps.writeGate.setSyncState(
      sourceId,
      cursor,
      await normalizeMetaIcons(meta),
      writeEpoch,
      deviceId,
    );
    if (written && meta.urlPatterns) invalidateUrlPatternCache();
    return written;
  }

  /** One row of a source's sync state: `""` (shared) or a member device's own. */
  getState(sourceId: string, deviceId = "") {
    return getSyncState(this.deps.db, sourceId, deviceId);
  }

  /** Current write epoch of one cursor row (0 if never claimed or wiped). */
  getEpoch(sourceId: string, cursorRow = ""): number {
    return getWipeEpoch(this.deps.db, sourceId, cursorRow);
  }
}
