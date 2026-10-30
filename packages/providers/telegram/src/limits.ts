// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every tunable of the Telegram source, in one place.
 *
 * `docs/telegram-source.md` §7.8 and §10.
 */

/** Wrong two-step passwords accepted before the sign-in gives up. */
export const MAX_PASSWORD_ATTEMPTS = 3;

/**
 * How long one sign-in waits for the code to be scanned and the password typed.
 *
 * Under the gateway's fifteen-minute auth-flow expiry, so the flow reports its
 * own timeout instead of being cut off without one. The code itself rotates
 * every thirty seconds or so inside that window.
 */
export const LOGIN_TIMEOUT_MS = 13 * 60 * 1000;

/** How long removing an account waits to end its Telegram session before removing it anyway. */
export const LOGOUT_TIMEOUT_MS = 20 * 1000;

/** How long a sync waits for the live connection before reporting a network failure. */
export const CONNECT_TIMEOUT_MS = 60 * 1000;

/**
 * The longest flood wait the client sleeps through on its own. A longer one
 * surfaces as a `flood-wait` error, so a sync can stop instead of hanging.
 */
export const FLOOD_SLEEP_MAX_MS = 10_000;

/** Messages per `messages.getHistory` request (Telegram's own ceiling). */
export const HISTORY_PAGE_SIZE = 100;

/** Upstream requests one `sync()` page may make for the walk and reconcile. */
export const WALK_REQUESTS_PER_PAGE = 20;

/** The least time between two upstream requests of the walk, across pages. */
export const HISTORY_MIN_INTERVAL_MS = 1000;

/** The walk stops when the run has less than this left before its deadline. */
export const WALK_DEADLINE_MARGIN_MS = 120_000;

/** Dirty days rendered per `sync()` page. */
export const DRAIN_DAY_LIMIT = 200;

/** How often every dialog is listed again to find missed messages. */
export const FULL_RECONCILE_INTERVAL_H = 24;

/** How far back a presence check looks for lost edits and deletions. */
export const RECONCILE_WINDOW_DAYS = 14;

/** Message ids per presence-check request. */
export const PRESENCE_BATCH_SIZE = 100;

/** An outage longer than this may have lost updates, so it asks for a reconcile. */
export const GAP_SUSPECT_OUTAGE_S = 900;

/** A deletion for a message not archived yet is kept this long, waiting for it. */
export const PENDING_DELETION_TTL_DAYS = 30;

/** A flood wait longer than this is reported to the operator as an issue. */
export const FLOOD_ISSUE_THRESHOLD_S = 600;

// ── Media (`docs/telegram-source.md` §10) ──────────────────────────────

/**
 * Media downloads one `sync()` page may start, voice notes and attachments
 * together. They run one at a time. A backlog is worked through page after
 * page, so text is never held behind it.
 */
export const MEDIA_ATTEMPTS_PER_PAGE = 1;

/**
 * Backoff after a failed media attempt, in seconds, by attempt number; the
 * last step repeats. The same schedule WhatsApp uses.
 */
export const MEDIA_RETRY_BACKOFF_SEC: readonly number[] = [20, 60, 300, 1800, 7200, 21_600, 43_200];

/**
 * Failed downloads after which media is given up as unavailable. A failure
 * to process bytes already in hand (no transcriber or OCR model yet) never
 * counts toward giving up.
 */
export const MEDIA_MAX_ATTEMPTS = 12;

/** The largest voice note downloaded for transcription. */
export const VOICE_NOTE_MAX_BYTES = 25 * 1024 * 1024;

/** A download that receives nothing for this long fails as a network error. */
export const MEDIA_DOWNLOAD_STALL_MS = 60_000;

/**
 * Time a run must still have before its deadline for a page with more media
 * due to ask for another page. One transcription or OCR call can take minutes.
 */
export const MEDIA_CONTINUATION_MARGIN_MS = 15 * 60_000;

/**
 * How often a sync page confirms the session with Telegram (`updates.getState`)
 * before doing its work. Revocation stops the update loop without an event, so
 * an idle source learns of it only through a request; the scheduled sync is
 * far apart enough that every scheduled run still checks.
 */
export const AUTH_CHECK_INTERVAL_MS = 5 * 60_000;
