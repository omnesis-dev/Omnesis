// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the Immich source persists between runs.
 *
 * Between sweeps: the watermark, when the last complete walk finished, and
 * the album index. During a backfill or snapshot sweep, also the page in
 * progress, the sweep's pinned window and the presence ledger the final page
 * reconciles — one id per asset, which is what sizes `maxBytes`: a library of
 * several hundred thousand assets plus their album membership fits with room
 * to spare.
 */

import { isImmichCursor } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { ImmichCursor } from "./types.js";

export const immichStateSpec: SourceStateSpec<ImmichCursor> = {
  version: 1,
  maxBytes: 64 * 1024 * 1024,

  /** Every shape a page can leave: settled, mid-sweep, with or without a ledger. */
  decode(value: unknown): ImmichCursor | null {
    return isImmichCursor(value) ? value : null;
  },

  /**
   * Immich keeps every asset until its owner deletes it, so a discarded
   * cursor costs one full sweep under Immich's own ids and loses nothing.
   */
  onUnreadable: "rebootstrap",
};
