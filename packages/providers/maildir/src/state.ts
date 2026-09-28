// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What this source persists between runs: a generation id and a page count,
 * nothing proportional to the mailbox. Everything proportional lives in the
 * local index, which the cursor tells how much of it the gateway has
 * committed (see `MaildirIndex`).
 */

import { isMaildirCursor } from "./source.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { MaildirCursor } from "./source.js";

export const maildirStateSpec: SourceStateSpec<MaildirCursor> = {
  version: 1,

  /** The only shape any page returns, mid-cycle or settled. */
  decode(value: unknown): MaildirCursor | null {
    return isMaildirCursor(value) ? value : null;
  },

  /**
   * The Maildir is on this machine and can be read again in full at any time,
   * so discarding an unreadable cursor costs a re-emission and loses nothing.
   */
  onUnreadable: "rebootstrap",
};
