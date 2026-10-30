// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isSnapshotLedger, makeCursorValidator } from "@omnesis/source-sdk";
import type { SnapshotLedger, SyncCursor } from "@omnesis/source-sdk";
import type { PaperlessClient } from "./client.js";

// ── Provider Context ────────────────────────────────────────────────

export interface PaperlessContext {
  client: PaperlessClient;
  accountId: string;
  dataCutoff?: string;
  configDir?: string;
}

// ── Sync cursor ─────────────────────────────────────────────────────

/**
 * One sweep at a time, each walking a list of document ids fixed when it
 * started.
 *
 * Paperless pages by page number over a live query, so a document deleted or
 * edited mid-walk shifts every page after it and a page-numbered walk can
 * skip one without noticing. A sweep therefore lists the ids it will fetch up
 * front, paging that listing by id rather than by page number, and fetches
 * from the list:
 *
 * - `full` — every document, fetched in full. The first sweep, and any sweep
 *   after a tag, correspondent, document type or custom field was renamed or
 *   removed: that changes how every document using it reads, and does not
 *   touch the documents' own `modified`.
 * - `incremental` — documents whose `modified` is past `watermark`.
 * - `snapshot` — a periodic listing of every id, to learn what was deleted
 *   and to catch what `modified` does not show. It fetches documents past the
 *   watermark, ids `known` did not hold, and documents whose custom fields
 *   changed (a bulk custom-field edit leaves `modified` alone); the rest are
 *   named present without being re-read.
 *
 * `pending` is the part of the sweep still to fetch; its presence is what
 * makes a sweep in progress. `sweepWatermark` is the newest `modified` the
 * listing saw, promoted to `watermark` only when the sweep completes, so an
 * interrupted sweep resumes rather than skipping what it had not reached.
 */
export interface PaperlessDocumentsCursor extends SyncCursor {
  phase: "full" | "incremental" | "snapshot";
  /** Paperless's own `modified` value for the newest document fully ingested. */
  watermark?: string;
  /** Newest `modified` in the in-progress sweep's listing. */
  sweepWatermark?: string;
  /** Document ids the in-progress sweep has still to fetch. */
  pending?: number[];
  /**
   * A fingerprint of every tag, correspondent, document type and custom field
   * the last sweep rendered with, keyed by kind and id. A changed or vanished
   * entry re-reads every document; a new one cannot change any document until
   * that document is edited, so it does not.
   */
  lookups?: Record<string, string>;
  /**
   * Every document id the last full or snapshot listing named, with a
   * fingerprint of its custom field values: what a snapshot compares against
   * to find documents it has never read and values a bulk edit changed.
   */
  known?: Record<string, string>;
  /** Ids the in-progress sweep could not read, reported as issues when it completes. */
  skipped?: number[];
  lastSnapshotAt?: string;
  snapshot?: SnapshotLedger;
}

const PHASES: ReadonlySet<string> = new Set<PaperlessDocumentsCursor["phase"]>([
  "full",
  "incremental",
  "snapshot",
]);

export function isPaperlessDocumentsCursor(v: unknown): v is PaperlessDocumentsCursor {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.phase !== "string" || !PHASES.has(c.phase)) return false;
  for (const key of ["watermark", "sweepWatermark", "lastSnapshotAt"]) {
    if (
      c[key] !== undefined &&
      (typeof c[key] !== "string" || !Number.isFinite(Date.parse(c[key])))
    )
      return false;
  }
  for (const key of ["lookups", "known"]) {
    if (c[key] !== undefined && !isStringRecord(c[key])) return false;
  }
  for (const key of ["pending", "skipped"]) {
    if (c[key] !== undefined && (!Array.isArray(c[key]) || !c[key].every(isDocumentId)))
      return false;
  }
  if (c.snapshot !== undefined && !isSnapshotLedger(c.snapshot)) return false;
  // A full or snapshot sweep in progress carries what it has listed so far;
  // without it the sweep would end by vouching for an empty archive.
  if (c.pending !== undefined && c.phase !== "incremental" && c.snapshot === undefined)
    return false;
  return true;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string")
  );
}

export const validatePaperlessDocumentsCursor = makeCursorValidator(isPaperlessDocumentsCursor);

export function isDocumentId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

// ── Paperless-ngx REST API shapes ───────────────────────────────────
// https://docs.paperless-ngx.com/api/

/** The page envelope every list endpoint returns. */
export interface PaperlessPage<T> {
  count: number;
  next: string | null;
  previous: string | null;
  /** Every id the query matched, across all pages. Document lists carry it. */
  all?: number[];
  results: T[];
}

export interface PaperlessNamed {
  id: number;
  name: string;
}

/**
 * A custom field definition. `select_options` are bare labels on older
 * servers and `{id, label}` from API version 7 onward.
 */
export interface PaperlessCustomField extends PaperlessNamed {
  data_type: string;
  extra_data?: {
    select_options?: Array<string | { id: string; label: string } | null>;
    default_currency?: string | null;
  } | null;
}

interface PaperlessNoteUser {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface PaperlessNote {
  id: number;
  note: string;
  created: string;
  /** An id on older servers, the user object on newer ones. */
  user?: PaperlessNoteUser | number | null;
}

export interface PaperlessCustomFieldInstance {
  field: number;
  value: unknown;
}

export interface PaperlessDocument {
  id: number;
  title: string;
  content?: string | null;
  correspondent: number | null;
  document_type: number | null;
  tags: number[];
  /** A date (`YYYY-MM-DD`) from API version 9, a datetime before. */
  created: string;
  added?: string | null;
  modified: string;
  archive_serial_number?: number | null;
  original_file_name?: string | null;
  page_count?: number | null;
  mime_type?: string | null;
  notes?: PaperlessNote[] | number | null;
  custom_fields?: PaperlessCustomFieldInstance[] | null;
  /** The owning user's id; null for a document nobody owns. */
  owner?: number | null;
}

/** `GET /api/ui_settings/` — the one endpoint every version has that names the caller. */
export interface PaperlessUiSettings {
  user: { id: number; username: string; first_name?: string; last_name?: string };
}

/** The lookup tables a document's ids resolve against. */
export interface PaperlessLookups {
  tags: Map<number, string>;
  correspondents: Map<number, string>;
  documentTypes: Map<number, string>;
  customFields: Map<number, PaperlessCustomField>;
}
