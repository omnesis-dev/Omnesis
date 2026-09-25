// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What this source persists between runs.
 *
 * `mailboxes` holds one small entry (`uidValidity`, `lastUid`) per mailbox,
 * capped by the same `MAX_MAILBOXES` limit `sync()` enforces before it ever
 * builds a cursor — so its size tracks the account's folder count, not the
 * number of messages in them, and is already bounded independently of this
 * declaration. `pendingMailboxPaths` and `activeMailbox` are the mid-cycle
 * bookkeeping for whichever mailbox is currently being walked; `decode`
 * accepts both present and absent, since a page can return either.
 *
 * There is no historical shape to migrate: this cursor has never carried a
 * version marker of its own, and IMAP does not force a re-render the way a
 * normalizer change can — `legacyVersion` and `migrate` have nothing to do.
 */

import { isImapEmailCursor } from "./source.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { ImapEmailCursor } from "./source.js";

export const imapStateSpec: SourceStateSpec<ImapEmailCursor> = {
  version: 1,

  /** Every shape `sync()` can pause a cycle in: settled, mid-mailbox, or between mailboxes. */
  decode(value: unknown): ImapEmailCursor | null {
    return isImapEmailCursor(value) ? value : null;
  },

  /**
   * A mail server keeps every message until the account owner deletes it, so
   * a discarded cursor costs a re-scan of each mailbox from UID 1 and loses
   * nothing.
   */
  onUnreadable: "rebootstrap",
};
