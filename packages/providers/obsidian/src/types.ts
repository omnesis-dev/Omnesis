// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-file state tracked across sync cycles. Path is the lookup key; the
 * `stableId` is what's emitted as `externalId` on the document so a rename
 * doesn't break trigger history, link-graph backlinks, or annotations.
 *
 * `size` and `contentHash` are the rename-detection key — when a path
 * disappears and another path appears with the same `(size, contentHash)`
 * we treat the new path as a rename of the old and reuse its stableId.
 *
 * `fileIdentity` preserves the exact volume/inode pair for rename detection
 * and guarded reads. The numeric `inode` remains for installed-state compatibility
 * and the existing external-ID spelling when it is an exact safe integer.
 */
export interface ObsidianFileState {
  mtime: number;
  contentHash: string;
  size: number;
  inode: number;
  /** Exact volume/file identity; absent in installed numeric-only cursors. */
  fileIdentity?: string;
  stableId: string;
  /**
   * {@link OBSIDIAN_RENDER_VERSION} this note was last emitted under. Absent
   * on state written before the version existed, which reads as stale.
   */
  renderVersion?: number;
}

/**
 * Sync cursor for Obsidian Notes source.
 *
 * `version: 2` marks the cursor as using stable identities (frontmatter.id
 * → rename-detection → inode). A missing or older version triggers a
 * one-time wipe-and-resync: every previous externalId (which was the
 * path) is emitted as a deletion and every current note is re-emitted
 * with its new stable externalId. This one-time wipe-and-resync on the
 * first upgrade is an accepted trade-off.
 */
export interface ObsidianSyncCursor {
  version?: 2;
  fileMap: Record<string, ObsidianFileState>;
  /**
   * Files queued for processing at the start of the current sync cycle,
   * pinned across pages so the progress bar's `total` stays stable. Cleared
   * when the cycle ends with `hasMore: false`.
   */
  cycleQueueTotal?: number;
  /**
   * Identities that notes at tracked paths stopped using earlier in the
   * current cycle, carried to the final page where their documents are
   * deleted unless another live note holds them. Cleared when the cycle ends.
   */
  supersededStableIds?: string[];
  /**
   * One-time migration deletions (old path-shaped externalIds) carried
   * through subsequent pages of the migration cycle so the gateway sees
   * the full set on the final page (`hasMore: false`).
   */
  pendingMigrationDeletes?: string[];
  [key: string]: unknown;
}

/**
 * A parsed Obsidian note with extracted metadata.
 */
export interface ParsedNote {
  relativePath: string;
  title: string;
  content: string;
  rawContent: string;
  frontmatter: Record<string, unknown> | null;
  tags: string[];
  links: string[];
  ctime: number;
  mtime: number;
  /**
   * Stable identity for the note, computed once at sync-time:
   *   1. `frontmatter.id` if the user (or a UUID/Templater plugin) set one
   *      and no other live note holds it (a note that moved holds its own),
   *   2. otherwise a previously-tracked stableId carried over via
   *      rename-detection (matching `(size, contentHash)` of a just-
   *      disappeared path),
   *   3. otherwise `inode:<n>` for safe integer file IDs or
   *      `inode:<device>:<inode>` for full-width filesystem IDs.
   *
   * This is the externalId emitted to the gateway. The relative path is
   * NOT the externalId.
   */
  stableId: string;
}
