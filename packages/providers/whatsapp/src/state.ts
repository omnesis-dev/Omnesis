// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What this source persists between runs.
 *
 * The cursor is a thin position marker into a durable local store the
 * provider keeps independently (`MessageStore`, a SQLite database of every
 * message this device has ever received and every day-chat still awaiting
 * confirmation from the gateway — see its class doc). `committedSeq` is the
 * acknowledgement within the archive named by `storeId`: it tells `MessageStore.drain()`
 * which previously-drained days the gateway has already confirmed, so their
 * dirty rows can be cleared. `phase` and `lastTimestamp` are reported for
 * observability only; nothing in `sync()` branches on them.
 *
 * That split is what settles `onUnreadable` below. Losing this cursor never
 * loses a message: the corpus lives in the local store, which is never
 * garbage-collected, and a companion device already only ever receives
 * WhatsApp's own recent (~90-day) window on pairing — so there is no larger
 * upstream corpus this cursor could be re-walking in the first place. A
 * `committedSeq` of 0 just means the next drain treats the current in-flight
 * backlog (the days not yet proven committed, not the whole corpus) as
 * unconfirmed and re-emits it once.
 *
 * Legacy cursors without `storeId` and cursors from another archive replay
 * the outstanding backlog before acknowledging it under the local identity.
 * Copying or restoring the database preserves its identity. An acknowledgement
 * ahead of its saved counter is refused, but diverging copies with overlapping
 * counters cannot be distinguished: they must not sync concurrently. Restore
 * the matching gateway state or force a resync when restoring an archive.
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { WhatsAppSyncCursor } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const whatsappStateSpec: SourceStateSpec<WhatsAppSyncCursor> = {
  version: 1,

  /** Accept legacy bookmarks; absence of an archive identity means replay. */
  decode(value: unknown): WhatsAppSyncCursor | null {
    if (!isRecord(value)) return null;
    if (value.phase !== "bootstrap" && value.phase !== "incremental") return null;
    if (typeof value.lastTimestamp !== "number") return null;
    if (
      typeof value.committedSeq !== "number" ||
      !Number.isSafeInteger(value.committedSeq) ||
      value.committedSeq < 0
    )
      return null;
    if (value.storeId !== undefined && (typeof value.storeId !== "string" || !value.storeId))
      return null;
    return value as unknown as WhatsAppSyncCursor;
  },

  // No maxBytes: the cursor has a fixed number of fields, not a map or list that
  // grows with the number of chats or messages — the corpus itself lives in
  // MessageStore's own SQLite database, not in this value.

  /**
   * Re-emitting the current in-flight backlog costs nothing: the local
   * message store holds the whole corpus independently of this cursor, and
   * a re-paired companion would not receive any more history from WhatsApp
   * than it already has.
   */
  onUnreadable: "rebootstrap",
};
