// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What `telegram-messages` persists between runs.
 *
 * The same split as WhatsApp's (`packages/providers/whatsapp/src/state.ts`):
 * the cursor is a thin acknowledgement into the account's own archive, which
 * holds the corpus and is never garbage-collected. A cursor from another
 * archive, or one without an archive identity, means "nothing acknowledged":
 * the outstanding backlog is re-emitted once. Losing the cursor therefore
 * costs a re-emit of the in-flight days, never a message, which settles
 * `onUnreadable`.
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { TelegramSyncCursor } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const telegramStateSpec: SourceStateSpec<TelegramSyncCursor> = {
  version: 1,

  decode(value: unknown): TelegramSyncCursor | null {
    if (!isRecord(value)) return null;
    if (value.phase !== "bootstrap" && value.phase !== "incremental") return null;
    if (
      typeof value.committedSeq !== "number" ||
      !Number.isSafeInteger(value.committedSeq) ||
      value.committedSeq < 0
    )
      return null;
    if (value.storeId !== undefined && (typeof value.storeId !== "string" || !value.storeId))
      return null;
    return {
      phase: value.phase,
      committedSeq: value.committedSeq,
      ...(value.storeId !== undefined ? { storeId: value.storeId } : {}),
    };
  },

  // No maxBytes: three fixed fields; the corpus lives in the archive.

  onUnreadable: "rebootstrap",
};
