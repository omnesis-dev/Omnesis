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
 * The most quota units one account's Gmail source spends per minute, on
 * average: two thirds of Gmail's per-user limit of 6,000, which every client
 * of the same account in the same Google Cloud project shares. The source
 * starts here and slows down when Google refuses it; see the adaptive pace
 * below.
 */
export const GMAIL_QUOTA_UNITS_PER_MINUTE = 4_000;

/**
 * What an idle source may spend at once: five full message fetches. With the
 * rate above, no minute can spend more than 4,300 units.
 */
export const GMAIL_QUOTA_BURST_UNITS = 300;

/**
 * The adaptive pace. Another client of the account can spend the same
 * per-user quota, unseen, so a rate limit cuts the pace by a quarter, down to
 * the floor, and every quiet period after it adds a step back, up to
 * {@link GMAIL_QUOTA_UNITS_PER_MINUTE}. A quiet period is ten minutes with no
 * rate limit, ending on a request that succeeds; it also resets the
 * rate-limit back-off.
 */
export const GMAIL_QUOTA_FLOOR_UNITS_PER_MINUTE = 1_500;
export const GMAIL_QUOTA_DECREASE_FACTOR = 0.75;
export const GMAIL_QUOTA_INCREASE_UNITS_PER_MINUTE = 250;
export const GMAIL_QUOTA_QUIET_PERIOD_MS = 10 * 60_000;

/**
 * For an hour after a rate limit the pace climbs back to one step short of
 * the pace Google refused and no further, so a source sharing the quota with
 * a steady neighbour settles under what is left instead of meeting the limit
 * on every climb. After the hour it probes up to the ceiling again, which
 * finds the room a neighbour that has stopped leaves.
 */
export const GMAIL_QUOTA_HOLD_MS = 60 * 60_000;

/**
 * The wait after a Google rate limit that names no `Retry-After`, doubled for
 * each consecutive rate-limited sync up to the cap. Gmail counts a sync as
 * consecutive until a quiet period has passed since the last rate limit.
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

// Stable base query for legacy gateways; the negotiated hierarchy path adds parents/driveId.
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
