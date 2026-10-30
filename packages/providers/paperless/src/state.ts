// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What paperless-documents persists between runs: the watermark, the lookup
 * digest, and — while a sweep is in progress — its remaining ids and the
 * presence ledger it will reconcile with.
 */

import { isPaperlessDocumentsCursor } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { PaperlessDocumentsCursor } from "./types.js";

export const paperlessDocumentsStateSpec: SourceStateSpec<PaperlessDocumentsCursor> = {
  version: 1,
  // A sweep over the largest archive a snapshot vouches for carries its
  // remaining ids and a presence ledger of the same size.
  maxBytes: 32 * 1024 * 1024,

  /** Accepts both an in-progress sweep and a settled incremental watermark. */
  decode(value: unknown): PaperlessDocumentsCursor | null {
    return isPaperlessDocumentsCursor(value) ? value : null;
  },

  /**
   * Paperless-ngx keeps every document until the operator deletes it, so a
   * discarded cursor costs one full sweep under the same document ids and
   * loses nothing.
   */
  onUnreadable: "rebootstrap",
};
