// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What granola-meetings persists between runs.
 *
 * Incremental watermarks survive upgrades unchanged. A complete enumeration
 * also persists a bounded presence ledger and its pagination tokens until the
 * final page can reconcile both output planes. An old partial backfill has no
 * ledger and must finish without asserting absence; a full rewalk follows it.
 */

import { isGranolaMeetingsCursor } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { GranolaMeetingsCursor } from "./types.js";

export const granolaMeetingsStateSpec: SourceStateSpec<GranolaMeetingsCursor> = {
  version: 2,
  maxBytes: 32 * 1024 * 1024,
  legacyVersion(value: unknown) {
    return isGranolaMeetingsCursor(value) ? (value.reconciliationVersion ?? 1) : null;
  },
  migrate: {
    1: (prior: unknown) =>
      isGranolaMeetingsCursor(prior) ? { ...prior, reconciliationVersion: 2 } : null,
  },

  /** Accepts both an in-progress sweep and a settled incremental watermark. */
  decode(value: unknown): GranolaMeetingsCursor | null {
    return isGranolaMeetingsCursor(value) && value.reconciliationVersion === 2 ? value : null;
  },

  /**
   * Granola retains every note until the user deletes it, so a discarded
   * cursor costs one full backfill sweep under upstream's own ids and loses
   * nothing.
   */
  onUnreadable: "rebootstrap",
};
