// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What both omatel sources persist between runs: the fingerprint of every
 * group they rendered (a conversation's day, a day of calls), and whether the
 * cycle in progress changed anything.
 *
 * omatel keeps every message and call until the owner deletes it, and each
 * page reads the whole store, so a discarded cursor costs one full render
 * under the same document ids and analytics keys and loses nothing.
 */

import { isOmatelCursor, type OmatelCursor } from "./group-sync.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";

export const omatelStateSpec: SourceStateSpec<OmatelCursor> = {
  version: 1,
  // About 40 bytes per group: years of daily conversations stay far below it.
  maxBytes: 16 * 1024 * 1024,
  decode(value: unknown): OmatelCursor | null {
    return isOmatelCursor(value) ? value : null;
  },
  onUnreadable: "rebootstrap",
};
