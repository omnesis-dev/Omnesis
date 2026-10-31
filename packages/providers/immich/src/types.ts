// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isSnapshotLedger, makeCursorValidator } from "@omnesis/source-sdk";
import type { SnapshotLedger, SyncCursor } from "@omnesis/source-sdk";
import type { SyncIssue } from "@omnesis/types";

// ── Immich REST shapes ──────────────────────────────────────────────
// Only the fields this source reads, as Immich v3 serves them
// (`server/src/dtos/*.dto.ts`). Every field the server marks optional or
// nullable is optional here, so a server that leaves one out still parses.

/** `GET /api/server/version` — public, no key needed. */
export interface ImmichServerVersion {
  major: number;
  minor: number;
  patch: number;
}

/** `GET /api/users/me` (`user.read`). */
export interface ImmichUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

/** `GET /api/api-keys/me` — the presented key itself, no permission needed. */
export interface ImmichApiKey {
  id: string;
  name: string;
  permissions: string[];
}

interface ImmichExif {
  dateTimeOriginal?: string | null;
  timeZone?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  make?: string | null;
  model?: string | null;
  lensModel?: string | null;
  description?: string | null;
}

interface ImmichPerson {
  id: string;
  name: string;
  isHidden?: boolean;
}

type ImmichAssetType = "IMAGE" | "VIDEO" | "AUDIO" | "OTHER";
type ImmichVisibility = "archive" | "timeline" | "hidden" | "locked";

/** `AssetResponseDto`, as `POST /api/search/metadata` returns it. */
export interface ImmichAsset {
  id: string;
  ownerId: string;
  type: ImmichAssetType;
  originalFileName?: string;
  fileCreatedAt: string;
  /** The capture's wall-clock time, written as if it were UTC. */
  localDateTime?: string;
  updatedAt: string;
  isFavorite?: boolean;
  isArchived?: boolean;
  isTrashed?: boolean;
  visibility?: ImmichVisibility;
  /** Milliseconds, or null for a still image (v3). */
  duration?: number | null;
  /** Base64 SHA-1 of the original file. */
  checksum?: string;
  exifInfo?: ImmichExif;
  people?: ImmichPerson[];
}

/** The flat request body of `POST /api/search/metadata`, as far as this source uses it. */
export interface ImmichMetadataSearch {
  page: number;
  size: number;
  order: "asc" | "desc";
  withExif?: boolean;
  withPeople?: boolean;
  withDeleted?: boolean;
  updatedAfter?: string;
  updatedBefore?: string;
  albumIds?: string[];
}

export interface ImmichSearchResponse {
  assets: {
    items: ImmichAsset[];
    /** The next page number as a string, or null on the last page. */
    nextPage: string | null;
  };
}

/** One entry of `GET /api/albums` (`album.read`). */
export interface ImmichAlbum {
  id: string;
  albumName: string;
  assetCount?: number;
  updatedAt?: string;
}

// ── Sync cursor ─────────────────────────────────────────────────────

/**
 * Album membership as of the last full sweep. Membership is not a property of
 * an asset's `updatedAt` — adding a photo to an album leaves the photo
 * untouched — so it is read in full at the start of every backfill and
 * snapshot sweep and kept beside the cursor (see `album-store.ts`), not in
 * it: it grows with the library, and the cursor is rewritten on every page.
 */
export interface ImmichAlbumIndex {
  /** Album id → album name. */
  names: Record<string, string>;
  /** Asset id → the ids of the albums it is in. */
  byAsset: Record<string, string[]>;
}

/**
 * Incremental polling with daily complete enumerations.
 *
 * - `backfill` — the first sweep: every asset, no `updatedAfter`.
 * - `incremental` — every later tick: assets with `updatedAt` inside
 *   `(syncedUpTo − overlap, windowEnd)`.
 * - `snapshot` — a daily unfiltered rewalk that accumulates presence until the
 *   final page can report every asset still visible, which is how a hard
 *   delete is noticed.
 *
 * A sweep pins its `windowEnd` on its first page so that Immich's offset
 * paging walks a fixed result set; an asset edited while the sweep runs falls
 * after the window and is read by the next one. `syncedUpTo` moves to
 * `windowEnd` only when the sweep completes, so an interrupted sweep re-reads
 * from the previous watermark rather than skipping anything.
 */
export interface ImmichCursor extends SyncCursor {
  phase: "backfill" | "incremental" | "snapshot";
  /** The next page of the sweep in progress; absent between sweeps. */
  page?: number;
  /** The upper bound of the sweep in progress. */
  windowEnd?: string;
  /** Everything with `updatedAt` before this has been read. */
  syncedUpTo?: string;
  lastSnapshotAt?: string;
  snapshot?: SnapshotLedger;
  /** The sweep in progress outgrew its presence ledger and will assert no absence. */
  presenceWithheld?: true;
  /**
   * This incremental pass re-reads a window that took more than one page.
   * Offset paging shifts when an asset leaves the window mid-walk (edited past
   * its end), which can step over a neighbour; reading the window once more
   * picks that neighbour up instead of leaving it to the next daily rewalk.
   */
  recheck?: true;
  /** What the sweep in progress could not read, reported when it completes. */
  sweepIssues?: SyncIssue[];
}

const PHASES: ReadonlySet<string> = new Set<ImmichCursor["phase"]>([
  "backfill",
  "incremental",
  "snapshot",
]);

function isIsoOrAbsent(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

export function isAlbumIndex(value: unknown): value is ImmichAlbumIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!v.names || typeof v.names !== "object" || Array.isArray(v.names)) return false;
  if (!v.byAsset || typeof v.byAsset !== "object" || Array.isArray(v.byAsset)) return false;
  if (!Object.values(v.names).every((name) => typeof name === "string")) return false;
  return Object.values(v.byAsset).every(
    (ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"),
  );
}

export function isImmichCursor(value: unknown): value is ImmichCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.phase !== "string" || !PHASES.has(c.phase)) return false;
  if (c.page !== undefined && (!Number.isInteger(c.page) || (c.page as number) < 1)) return false;
  if (!isIsoOrAbsent(c.windowEnd)) return false;
  if (!isIsoOrAbsent(c.syncedUpTo)) return false;
  if (!isIsoOrAbsent(c.lastSnapshotAt)) return false;
  // A page in progress belongs to a pinned window; one without the other is
  // a cursor nothing in this source writes.
  if ((c.page === undefined) !== (c.windowEnd === undefined)) return false;
  if (c.snapshot !== undefined && !isSnapshotLedger(c.snapshot)) return false;
  if (c.presenceWithheld !== undefined && c.presenceWithheld !== true) return false;
  if (
    c.recheck !== undefined &&
    (c.recheck !== true || c.page === undefined || c.phase !== "incremental")
  ) {
    return false;
  }
  if (
    c.sweepIssues !== undefined &&
    !(Array.isArray(c.sweepIssues) && c.sweepIssues.every(isIssue))
  ) {
    return false;
  }
  return true;
}

function isIssue(value: unknown): value is SyncIssue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const i = value as Record<string, unknown>;
  return (
    (i.scope === "item" || i.scope === "partition") &&
    typeof i.kind === "string" &&
    typeof i.message === "string" &&
    Number.isInteger(i.count)
  );
}

export const validateImmichCursor = makeCursorValidator(isImmichCursor);
