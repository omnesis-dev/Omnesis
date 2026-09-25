// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What this source persists between runs.
 *
 * `sync` re-reads the whole Bookmarks file on every cycle that sees a changed
 * `fileChecksum` — there is no partial read, no page token, no historical
 * window. `knownIds` exists solely so that cycle's freshly flattened bookmark
 * set can be diffed against the previous one to name what was removed;
 * `currentIds` itself is always rebuilt from the file in full, never from the
 * cursor. Every successfully read complete file also supplies a whole-source
 * presence snapshot, including unchanged files. Losing `knownIds` therefore
 * loses the immediate tombstone diff, but repeated snapshots still reconcile
 * bookmarks deleted before the cursor was lost. `onUnreadable:
 * "rebootstrap"` is what this source already does on every ordinary
 * unchanged-checksum-free cycle, just entered from an empty `knownIds`
 * instead of a populated one.
 *
 * The cursor's shape has not changed since this source was introduced — it
 * has always been the checksum plus the flat id list it is today — so there
 * is no legacy shape to translate and `version` stays at 1.
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { ChromeBookmarksCursor } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export const chromeBookmarksStateSpec: SourceStateSpec<ChromeBookmarksCursor> = {
  version: 1,

  decode(value: unknown): ChromeBookmarksCursor | null {
    if (!isRecord(value)) return null;
    if (typeof value.fileChecksum !== "string") return null;
    if (!isStringArray(value.knownIds)) return null;
    return value as unknown as ChromeBookmarksCursor;
  },

  /**
   * A runaway guard, not a capacity limit.
   *
   * `knownIds` holds one entry per bookmark URL currently in the file — every
   * entry is replaced wholesale each cycle a change is seen, never appended
   * to — so its size tracks the bookmark collection, not history. The ceiling
   * sits well above any bookmark collection a person accumulates by hand, so
   * tripping it means the id list stopped being replaced wholesale (a dedup
   * or a rebuild that started appending instead of overwriting) rather than
   * that bookmarks grew.
   */
  maxBytes: 16 * 1024 * 1024,

  onUnreadable: "rebootstrap",
};
