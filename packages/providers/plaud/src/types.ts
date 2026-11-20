// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isSnapshotLedger, makeCursorValidator } from "@omnesis/source-sdk";
import { fileSummarySchema } from "./schemas.js";
import type { SnapshotLedger, SyncCursor } from "@omnesis/source-sdk";
import type { PlaudClient } from "./client.js";
import type { FileSummary } from "./schemas.js";

export interface PlaudContext {
  client: PlaudClient;
  accountId: string;
  /** The address the account signed in with; the account owner on every recording. */
  email: string;
  dataCutoff?: string;
  configDir?: string;
  /** The host's clock, for the sign-in's expiry arithmetic. */
  now: () => Date;
}

/**
 * What plaud-recordings carries between runs.
 *
 * Plaud lists every recording in one cheap request, so each sweep starts by
 * listing them all and comparing each against `known`: a recording whose
 * fingerprint (its version, title, tags, recorder and whether Plaud has
 * finished its transcript and summary) differs from the one last rendered is
 * fetched again. Plaud finishing its processing does not move a recording's
 * edit time, which is why the fingerprint covers it and the sweep does not
 * stop at an edit-time watermark.
 *
 * - `pending` — the recordings the sweep in progress has still to render; its
 *   presence is what makes a sweep in progress.
 * - `snapshot` — set when the sweep's listing may vouch for what it omits:
 *   once a day, and only from a consistent listing. The sweep's last page
 *   names every listed recording present.
 */
export interface PlaudRecordingsCursor extends SyncCursor {
  known?: Record<string, string>;
  pending?: FileSummary[];
  /** Recordings the sweep in progress could not render, reported when it completes. */
  skipped?: string[];
  /** The gateway said no transcriber can run, earlier in the sweep in progress. */
  noTranscriber?: boolean;
  /**
   * Whose recordings the last listing read (see `PlaudClient.listingScope`).
   * A listing under another scope never says what is gone.
   */
  listingScope?: string;
  lastSnapshotAt?: string;
  snapshot?: SnapshotLedger;
}

export function isPlaudRecordingsCursor(v: unknown): v is PlaudRecordingsCursor {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (
    c.lastSnapshotAt !== undefined &&
    (typeof c.lastSnapshotAt !== "string" || !Number.isFinite(Date.parse(c.lastSnapshotAt)))
  ) {
    return false;
  }
  if (
    c.known !== undefined &&
    (!c.known ||
      typeof c.known !== "object" ||
      Array.isArray(c.known) ||
      !Object.values(c.known).every((x) => typeof x === "string"))
  ) {
    return false;
  }
  if (
    c.pending !== undefined &&
    (!Array.isArray(c.pending) || !c.pending.every((p) => fileSummarySchema.safeParse(p).success))
  ) {
    return false;
  }
  if (
    c.skipped !== undefined &&
    (!Array.isArray(c.skipped) || !c.skipped.every((x) => typeof x === "string"))
  ) {
    return false;
  }
  if (c.noTranscriber !== undefined && typeof c.noTranscriber !== "boolean") return false;
  if (c.listingScope !== undefined && typeof c.listingScope !== "string") return false;
  if (c.snapshot !== undefined && !isSnapshotLedger(c.snapshot)) return false;
  // A snapshot ledger belongs to a sweep in progress; on its own it would
  // carry a stale listing into the next sweep.
  if (c.snapshot !== undefined && c.pending === undefined) return false;
  return true;
}

export const validatePlaudRecordingsCursor = makeCursorValidator(isPlaudRecordingsCursor);
