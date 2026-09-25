// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const GOOGLE_PAGE_SIZE = 100;

/**
 * Concurrency cap for per-page detail fetches (Gmail messages, Drive files).
 * 8 stays comfortably under Gmail's per-second quota (~250 quota-units/sec)
 * and Drive's project-level rate limits while still cutting bootstrap RTT
 * by ~8x relative to the previous serial `for ... await` loop.
 */
export const GOOGLE_FETCH_CONCURRENCY = 8;

export const GMAIL_LABEL_CACHE_TTL_MS = 60 * 60 * 1000;

// When `history.list` 404s (the stored historyId aged past Gmail's retention
// window — typically after the OAuth token sat dead for days), we recover by
// backfilling only the *recent* window rather than re-walking the entire
// mailbox. These bound that window.
//
// Safety overlap subtracted from the last-sync watermark: covers clock skew
// and the internalDate-vs-historyId ordering gap so the backfill can't slip
// past a message that landed right around the last successful sync.
export const GMAIL_HISTORY_RECOVERY_OVERLAP_MS = 2 * 24 * 60 * 60 * 1000;
// Fallback look-back when the cursor carries no watermark (e.g. it was written
// before `lastSyncAt` existed). Bounded but generous — far cheaper than a
// full-mailbox re-walk while still covering a multi-day token outage.
export const GMAIL_HISTORY_RECOVERY_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000;

export const CALENDAR_MAX_RESULTS = 250;

export const DRIVE_MAX_CONTENT_SIZE = 10 * 1024 * 1024;

// Does NOT include `parents`/`driveId`/`ownedByMe`. Adding those is the
// prerequisite for propagating folder path as metadata (folder-cache
// resolver, three-bucket semantics).
export const DRIVE_FILE_FIELDS =
  "id,name,mimeType,createdTime,modifiedTime,size,webViewLink,owners,shared,trashed,permissions(emailAddress,displayName,role,type)";

export const DRIVE_EXPORT_MAP: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export const DRIVE_SKIP_MIME_TYPES = new Set([
  "application/vnd.google-apps.folder",
  "application/vnd.google-apps.shortcut",
  "application/vnd.google-apps.form",
  "application/vnd.google-apps.map",
  "application/vnd.google-apps.drawing",
  "application/vnd.google-apps.site",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
  "application/x-tar",
  "application/gzip",
]);

export const DRIVE_SKIP_MIME_PREFIXES = ["image/", "video/", "audio/"];

export const DRIVE_TEXT_MIME_PREFIXES = ["text/"];

export const DRIVE_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-yaml",
  "application/x-sh",
]);

export const CONTACTS_PERSON_FIELDS = [
  "names",
  "emailAddresses",
  "phoneNumbers",
  "organizations",
  "nicknames",
  "biographies",
  "addresses",
  "birthdays",
  "urls",
  "events",
  "metadata",
].join(",");
