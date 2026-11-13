// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { experimentalEnabled } from "@omnesis/core";
import type { Db } from "../data/types.js";

/**
 * Whether source filters are in use on this install: experimental mode offers
 * them, or a live access level still holds a filter saved while it did. A
 * deleted level's filter does not count, and neither does a connection's copy
 * of one: a live connection always sits on a live level that carries the same
 * filter. Every cost the feature adds to an ordinary write — the triggers on
 * documents, projecting a document's facts, the backfill of stored documents,
 * the facts a collector sends — is paid only while this holds. A database
 * without the filter tables has no filter.
 *
 * This reads the database each time. The writer's ingest path asks
 * `sourceFiltersActive` instead, which remembers the answer.
 */
export function sourceFiltersInUse(db: Db): boolean {
  if (experimentalEnabled()) return true;
  try {
    return !!db
      .prepare(
        `SELECT 1 FROM access_scope_policy_sources s
          WHERE s.owner_kind = 'level'
            AND EXISTS (SELECT 1 FROM access_levels l WHERE l.id = s.owner_id AND l.revoked_at IS NULL)
          LIMIT 1`,
      )
      .get();
  } catch {
    return false;
  }
}

let filterOwnersRevision = 0;

/**
 * Counts the writes that can change which live levels hold a filter: a level's
 * filter saved, replaced or removed, and a level deleted. An answer remembered
 * under an earlier count is read again.
 */
export function sourceFilterOwnersRevision(): number {
  return filterOwnersRevision;
}

/** Record that the set of live levels holding a filter may have changed. */
export function noteSourceFilterOwnersChanged(): void {
  filterOwnersRevision += 1;
}
