// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const GOOGLE_PAGE_SIZE = 100;

/**
 * Concurrency cap for per-page detail fetches (Gmail messages, Drive files).
 * It bounds round-trips in flight, not quota spend: Gmail's spend is paced
 * separately by {@link GMAIL_QUOTA_UNITS_PER_MINUTE}, and every Gmail request
 * waits for its units before it is sent.
 */
export const GOOGLE_FETCH_CONCURRENCY = 8;

/**
 * Messages per bootstrap listing page. A page is committed only once every
 * message on it is fetched, so it is sized to cost well under one minute's
 * quota: 25 full fetches and the listing come to about 1,500 units.
 */
export const GMAIL_PAGE_SIZE = 25;

/**
 * Gmail's per-method cost in quota units, for the requests this source makes.
 * `messagesGetFull` is `messages.get` with `format: "full"`.
 */
export const GMAIL_QUOTA_UNITS = {
  getProfile: 1,
  labelsList: 1,
  historyList: 2,
  messagesList: 5,
  messagesGetFull: 60,
  attachmentsGet: 20,
} as const;

export type GmailRequest = keyof typeof GMAIL_QUOTA_UNITS;

/**
 * The quota units one account's Gmail source spends per minute, on average:
 * 90% of Gmail's per-user limit of 6,000, leaving room for the burst below
 * and for other clients of the same account.
 */
export const GMAIL_QUOTA_UNITS_PER_MINUTE = 5_400;

/**
 * What an idle source may spend at once: five full message fetches. With the
 * rate above, no minute can spend more than 5,700 units.
 */
export const GMAIL_QUOTA_BURST_UNITS = 300;

/**
 * The wait after a Google rate limit that names no `Retry-After`, doubled for
 * each consecutive rate-limited sync up to the cap.
 */
export const GOOGLE_RATE_LIMIT_BASE_DELAY_MS = 60_000;
export const GOOGLE_RATE_LIMIT_MAX_DELAY_MS = 30 * 60_000;

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
