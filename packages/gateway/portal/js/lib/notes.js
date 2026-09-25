// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared helpers for the gateway-internal Notes source. Daily search
 * documents are read-only projections of the `note_entries` ledger;
 * managing them means managing the original notes on Tell Omnesis.
 */

/** A capture-local calendar day key. */
export const NOTE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The gateway-internal source whose day documents the Manage-notes link
 * serves. Notes is currently the only internal source; the link (day
 * seed + Tell Omnesis destination) is Notes-specific, so callers gate on
 * this id rather than the generic `internal` flag — a future internal
 * sibling must not inherit a link to the wrong surface.
 */
export const NOTES_SOURCE_ID = "omnesis-notes";

/** One history page. Shared by the API default and the manager view. */
export const NOTES_HISTORY_PAGE_SIZE = 25;

/**
 * The day a document belongs to, for the Manage-notes link. Generated
 * Notes documents carry the day as their external id; anything else
 * falls back to the creation date. Null when neither is day-shaped.
 * Accepts both the raw row (snake_case) and the recent DTO (camelCase).
 */
export function notesDayForDocument(doc) {
  const external =
    typeof doc?.external_id === "string"
      ? doc.external_id
      : typeof doc?.externalId === "string"
        ? doc.externalId
        : null;
  if (external && NOTE_DAY_RE.test(external)) return external;
  const created =
    typeof doc?.source_created_at === "string"
      ? doc.source_created_at
      : typeof doc?.sourceCreatedAt === "string"
        ? doc.sourceCreatedAt
        : null;
  const day = typeof created === "string" ? created.slice(0, 10) : null;
  return day && NOTE_DAY_RE.test(day) ? day : null;
}

/**
 * Tell Omnesis URL for managing notes. With a day, the history seeds at
 * that day (a Manage-notes link from an old daily document still lands
 * on relevant notes); without one it opens the latest notes.
 */
export function manageNotesHref(day) {
  return day ? `/portal/capture?day=${encodeURIComponent(day)}` : "/portal/capture";
}
