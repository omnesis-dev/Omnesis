// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What this source persists between runs.
 *
 * Things Cloud's local replica (`main.sqlite`) is the user's actual task
 * list — every open and completed task a Mac has ever synced stays in it
 * until the user deletes it, and Things itself never rotates old rows out on
 * a schedule. A discarded cursor therefore costs a full re-read of that same
 * replica, not a gap Things Cloud can no longer fill: `onUnreadable:
 * "rebootstrap"` (the default) is correct.
 *
 * That re-read is also complete rather than merely cheap. Deletion here does
 * not depend on the cursor at all — every cycle whose page is not partial
 * (`!hasMore`) runs `enumerateSnapshot()` against the live database and
 * reports every current task id as `presentExternalIds`, so a rebootstrap's
 * final page reconciles the corpus exactly as a normal cycle would.
 *
 * `cycleQueueTotal` is the only field this cursor has ever carried beyond the
 * modification watermark, and it has been optional since it was added — the
 * cursor validator this source already uses (`state?.cycleQueueTotal`, read
 * with `??`) tolerates its absence, so a page with or without it decodes the
 * same way. `version` stays at 1.
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { ThingsSyncCursor } from "./types.js";

function isThingsSyncCursor(value: unknown): value is ThingsSyncCursor {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  if (typeof c.lastModifiedTimestamp !== "number") return false;
  if (c.cycleQueueTotal !== undefined && typeof c.cycleQueueTotal !== "number") return false;
  return true;
}

export const thingsStateSpec: SourceStateSpec<ThingsSyncCursor> = {
  version: 1,
  decode: (value) => (isThingsSyncCursor(value) ? value : null),
  onUnreadable: "rebootstrap",
};
