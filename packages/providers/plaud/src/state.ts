// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What plaud-recordings persists between runs: the fingerprint of every
 * recording it rendered, and — while a sweep is in progress — the recordings
 * still to render and the presence ledger it will reconcile with.
 */

import { isPlaudRecordingsCursor } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { PlaudRecordingsCursor } from "./types.js";

export const plaudRecordingsStateSpec: SourceStateSpec<PlaudRecordingsCursor> = {
  version: 1,
  // One fingerprint per recording, plus a sweep's remaining listing entries
  // and presence ledger: a few hundred bytes per recording at most.
  maxBytes: 32 * 1024 * 1024,

  decode(value: unknown): PlaudRecordingsCursor | null {
    return isPlaudRecordingsCursor(value) ? value : null;
  },

  /**
   * Plaud keeps every recording until the owner deletes it, so a discarded
   * cursor costs one full sweep under the same recording ids and loses
   * nothing.
   */
  onUnreadable: "rebootstrap",
};
