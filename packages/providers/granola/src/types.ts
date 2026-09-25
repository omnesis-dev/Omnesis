// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { makeCursorValidator, isSnapshotLedger } from "@omnesis/source-sdk";
import type { SyncCursor, SnapshotLedger } from "@omnesis/source-sdk";
import type { GranolaClient } from "./client.js";

// ── Provider Context ────────────────────────────────────────────────

export interface GranolaContext {
  client: GranolaClient;
  accountId: string;
  dataCutoff?: string;
  configDir?: string;
}

// ── Sync cursor ─────────────────────────────────────────────────────

/**
 * Incremental polling with periodic complete enumerations.
 *
 * - `backfill` — first ever sweep: list every note newest→oldest with no
 *   `updated_after` filter, paging via Granola's opaque `cursor`.
 * - `incremental` — every subsequent tick: list notes with
 *   `updated_after = syncedUpTo` so only changed/new notes are re-fetched.
 * - `snapshot` — a periodic unfiltered walk, accumulating presence until the
 *   final page can reconcile documents and analytics together.
 *
 * A sweep can span many pages; `pageCursor` carries Granola's cursor across
 * them and `sweepMaxUpdatedAt` accumulates the high-water mark, promoted to
 * `syncedUpTo` only when the sweep completes (hasMore=false) so an interrupted
 * sweep re-scans from the previous watermark rather than skipping notes.
 */
export interface GranolaMeetingsCursor extends SyncCursor {
  phase: "backfill" | "incremental" | "snapshot";
  reconciliationVersion?: 2;
  /** Granola pagination cursor for the in-progress sweep (null = first page). */
  pageCursor?: string | null;
  /** ISO 8601 high-water mark of the newest `updated_at` fully ingested. */
  syncedUpTo?: string;
  /** Max `updated_at` seen during the current sweep; promoted on completion. */
  sweepMaxUpdatedAt?: string;
  lastSnapshotAt?: string;
  snapshot?: SnapshotLedger;
  /** Continuation tokens already seen in this sweep, for loop detection. */
  pageCursors?: string[];
}

const GRANOLA_PHASES: ReadonlySet<string> = new Set<GranolaMeetingsCursor["phase"]>([
  "backfill",
  "incremental",
  "snapshot",
]);

export function isGranolaMeetingsCursor(v: unknown): v is GranolaMeetingsCursor {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.phase !== "string" || !GRANOLA_PHASES.has(c.phase)) return false;
  if (c.reconciliationVersion !== undefined && c.reconciliationVersion !== 2) return false;
  if (
    c.pageCursor !== undefined &&
    c.pageCursor !== null &&
    (typeof c.pageCursor !== "string" || !c.pageCursor)
  )
    return false;
  for (const key of ["syncedUpTo", "sweepMaxUpdatedAt", "lastSnapshotAt"]) {
    if (
      c[key] !== undefined &&
      (typeof c[key] !== "string" || !Number.isFinite(Date.parse(c[key])))
    )
      return false;
  }
  if (
    c.pageCursors !== undefined &&
    (!Array.isArray(c.pageCursors) ||
      !c.pageCursors.every((token) => typeof token === "string" && token.length > 0))
  )
    return false;
  if (c.snapshot !== undefined && !isSnapshotLedger(c.snapshot)) return false;
  return true;
}

export const validateGranolaMeetingsCursor = makeCursorValidator(isGranolaMeetingsCursor);

// ── Granola public API shapes ───────────────────────────────────────
// https://docs.granola.ai/api-reference (public-api.granola.ai/v1)

export interface GranolaUser {
  name: string | null;
  email: string;
}

/** A single note in the `GET /v1/notes` list envelope. */
export interface GranolaNoteSummary {
  id: string; // ^not_[a-zA-Z0-9]{14}$
  object: "note";
  title: string | null;
  owner: GranolaUser;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

/** `GET /v1/notes` response envelope. */
export interface GranolaNotesListResponse {
  notes: GranolaNoteSummary[];
  hasMore: boolean;
  cursor: string | null;
}

export interface GranolaTranscriptSegment {
  speaker: {
    source: "microphone" | "speaker";
    diarization_label?: string; // e.g. "Speaker A"
  };
  text: string;
  start_time: string; // ISO 8601
  end_time: string; // ISO 8601
}

export interface GranolaCalendarEvent {
  id?: string;
  title?: string | null;
  start_time?: string | null;
  end_time?: string | null;
}

export interface GranolaFolder {
  id?: string;
  name?: string | null;
}

/** `GET /v1/notes/{id}?include=transcript` response. */
export interface GranolaNoteDetail {
  id: string;
  object: "note";
  title: string | null;
  created_at: string;
  updated_at: string;
  web_url: string;
  summary_text: string;
  summary_markdown: string | null;
  transcript: GranolaTranscriptSegment[] | null;
  owner: GranolaUser;
  attendees: GranolaUser[];
  calendar_event: GranolaCalendarEvent | null;
  folder_membership: GranolaFolder[];
}
