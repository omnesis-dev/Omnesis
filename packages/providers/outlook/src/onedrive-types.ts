// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { makeCursorValidator } from "@omnesis/source-sdk";
import type { AttachmentExtractionConfig, AttachmentExtractFn } from "@omnesis/core";
import type { SyncCursor } from "@omnesis/source-sdk";

/** Graph `driveItem` delta page size (`$top`). */
export const ONEDRIVE_PAGE_SIZE = 100;

/**
 * Concurrency cap for per-item content downloads. Mirrors Drive's
 * `GOOGLE_FETCH_CONCURRENCY` — each binary download is one round-trip, so a
 * small fan-out cuts page latency while staying well under Graph's per-app
 * throttling thresholds.
 */
export const ONEDRIVE_FETCH_CONCURRENCY = 8;

/**
 * Hard ceiling on extracted text length, mirroring Drive's
 * `DRIVE_MAX_CONTENT_SIZE`. A document whose extracted text exceeds this is
 * dropped rather than indexed truncated-without-notice.
 */
export const ONEDRIVE_MAX_CONTENT_SIZE = 10 * 1024 * 1024;

/**
 * MIME types we never try to index — archives and opaque binary blobs the
 * shared attachment pipeline can't decode. Mirrors Drive's skip list. Note
 * `image/*` is *not* hard-skipped here: it is gated by the attachment
 * allow-list so OCR (#427) can opt images in.
 */
export const ONEDRIVE_SKIP_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
  "application/x-tar",
  "application/gzip",
]);

/** MIME prefixes hard-skipped unless an attachment allow-list opts the type in. */
export const ONEDRIVE_SKIP_MIME_PREFIXES = ["image/", "video/", "audio/"];

/** MIME prefixes downloaded and indexed verbatim as UTF-8 text. */
export const ONEDRIVE_TEXT_MIME_PREFIXES = ["text/"];

/** Discrete MIME types treated as plain text (downloaded verbatim). */
export const ONEDRIVE_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-yaml",
  "application/x-sh",
]);

/**
 * Microsoft Graph `driveItem` (the subset OneDrive normalization reads).
 *
 * A `driveItem` is a *folder* when the `folder` facet is present and a *file*
 * when the `file` facet is present — they are mutually exclusive. Normalization
 * skips folders (no content) and only emits files. Delta responses additionally
 * carry items with a `deleted` facet (and otherwise sparse fields) to signal
 * removals.
 *
 * See https://learn.microsoft.com/graph/api/resources/driveitem.
 */
export interface DriveItem {
  id: string;
  name?: string;
  webUrl?: string;
  size?: number;
  eTag?: string;
  cTag?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  /** Who created the item (its owner) — present on every item, like Drive's `owners`. */
  createdBy?: DriveIdentitySet;
  /** Who last edited the item — maps to an `author` person, like Drive's writers. */
  lastModifiedBy?: DriveIdentitySet;
  /** Present iff the item is a file. */
  file?: { mimeType?: string; hashes?: { quickXorHash?: string; sha256Hash?: string } };
  /** Present iff the item is a folder. */
  folder?: { childCount?: number };
  parentReference?: { driveId?: string; id?: string; path?: string };
  /** Present iff the item is shared; `sharedBy` identifies who shared it. */
  shared?: { scope?: string; sharedBy?: DriveIdentitySet; owner?: DriveIdentitySet };
  /** Present (with otherwise sparse fields) when the item was removed. */
  deleted?: { state?: string };
}

/** Microsoft Graph identitySet — the actor on a `shared`/permission facet. */
export interface DriveIdentitySet {
  user?: { id?: string; displayName?: string; email?: string };
}

/** A page of `/me/drive/root/delta`. */
export interface DriveDeltaResponse {
  value: DriveItem[];
  /** More pages in this enumeration (bootstrap or an incremental tick). */
  "@odata.nextLink"?: string;
  /** Enumeration complete — re-issue this link on the next incremental tick. */
  "@odata.deltaLink"?: string;
}

/**
 * OneDrive sync cursor.
 *
 * OneDrive's delta is a single stream for the whole drive
 * (`/me/drive/root/delta`), so — unlike the per-folder `OutlookEmailCursor` —
 * the cursor is a single opaque follow-up link plus a phase. During bootstrap
 * `link` carries the `@odata.nextLink` paging through the initial full
 * enumeration; once that drains Graph hands back an `@odata.deltaLink`, which
 * we persist and re-issue each incremental tick. Both are opaque Graph URLs,
 * so one field carries both.
 */
export interface OneDriveCursor extends SyncCursor {
  phase: "bootstrap" | "incremental";
  /** `@odata.nextLink` during bootstrap, `@odata.deltaLink` once incremental. */
  link?: string;
  /**
   * Content fingerprint per externalId — `"<size>|<lastModifiedDateTime>|<eTag>"`.
   * Maintained as items are seen so a **bounded re-walk** on delta-token expiry
   * (410) can re-enumerate *metadata* cheaply yet re-download+extract *content*
   * only for items whose fingerprint changed — never a from-zero re-bootstrap
   * (the #111/#593 cursor-recovery rule). Bounded by the drive's file count
   * (a few bytes per file); absent on a first bootstrap.
   */
  seen?: Record<string, string>;
  /**
   * An in-flight bounded re-walk, present only while one is running.
   *
   * The walk re-enumerates the drive a page per `sync()` call, so its progress
   * has to survive between them: `seen` here accumulates what this walk has
   * found, separately from the cursor's `seen`, which stays the map the walk
   * compares against until it finishes and replaces it. The accumulated set is
   * what the final page publishes as the whole-drive snapshot, so it must not be
   * mistaken for a complete one while the walk is still going.
   */
  rewalk?: {
    /** Next page of the fresh enumeration; absent on the walk's first page. */
    link?: string;
    /** Fingerprints this walk has enumerated so far. */
    seen: Record<string, string>;
    /** Ids the walk has been told were deleted, held until it can report them. */
    deleted?: string[];
    /** Files enumerated so far — the evidence the snapshot floor weighs. */
    total: number;
    /** How many times Graph has disowned this walk's enumeration. */
    restarts?: number;
  };
}

/** Build the change-detection fingerprint for a `driveItem`. */
export function fingerprintDriveItem(item: DriveItem): string {
  return `${item.size ?? ""}|${item.lastModifiedDateTime ?? ""}|${item.eTag ?? item.cTag ?? ""}`;
}

/**
 * The Graph transport surface `OneDriveSource` depends on — a structural subset
 * of `GraphClient`. Declared as an interface (not the concrete class) so a test
 * or the synthetic twin can inject a fixture-backed transport that drives the
 * REAL delta walk / 410 re-walk / normalization without a live Graph or any
 * source-specific test seam in shared code.
 */
export interface GraphClientLike {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  getBytes(path: string): Promise<Uint8Array>;
}

export interface OneDriveSourceOptions {
  attachmentConfig?: AttachmentExtractionConfig;
  extractAttachment?: AttachmentExtractFn;
  /**
   * Inject a Graph transport in place of the default real `GraphClient`. The
   * synthetic twin passes a fixture-backed implementation so the production
   * sync path runs unchanged over canned delta pages + content bytes.
   */
  graph?: GraphClientLike;
}

/** A `Record<string, string>` and nothing else — an array yields indices as ids. */
function isFingerprintMap(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((entry) => typeof entry === "string");
}

export function isOneDriveCursor(v: unknown): v is OneDriveCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (c.phase !== "bootstrap" && c.phase !== "incremental") return false;
  // `link` is optional, but if present it must be a string — a malformed
  // cursor must fall back to the bootstrap default rather than feed a
  // non-string URL to the delta walk.
  if (c.link !== undefined && typeof c.link !== "string") return false;
  // `seen` is the re-walk's record of what the drive held, and so decides which
  // files a recovery treats as still present. A malformed one would hand the
  // snapshot reconciliation an arbitrary id set — an array yields its indices
  // as ids, a string yields its character positions — so anything but a
  // string-valued record sends the cursor back to a clean bootstrap.
  if (c.seen !== undefined) {
    if (!isFingerprintMap(c.seen)) return false;
  }
  // The re-walk's accumulated set becomes the whole-drive snapshot the gateway
  // reconciles against, so a malformed one would decide what to delete.
  if (c.rewalk !== undefined) {
    if (typeof c.rewalk !== "object" || c.rewalk === null || Array.isArray(c.rewalk)) return false;
    const w = c.rewalk as Record<string, unknown>;
    if (w.link !== undefined && typeof w.link !== "string") return false;
    if (!isFingerprintMap(w.seen)) return false;
    if (w.deleted !== undefined) {
      if (!Array.isArray(w.deleted) || !w.deleted.every((id) => typeof id === "string")) {
        return false;
      }
    }
    if (typeof w.total !== "number" || !Number.isFinite(w.total) || w.total < 0) return false;
    if (w.restarts !== undefined) {
      if (typeof w.restarts !== "number" || !Number.isFinite(w.restarts) || w.restarts < 0) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Validate a persisted cursor, falling back to a fresh bootstrap cursor when
 * absent or malformed (mirrors `validateOutlookEmailCursor`).
 */
export const validateOneDriveCursor = makeCursorValidator(isOneDriveCursor);
