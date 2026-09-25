// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Re-applying the source-index deletions that landed while an indexing job was
 * writing.
 *
 * A deletion answers its caller the moment it runs, without waiting for the
 * job. The job can still write chunk / `indexed_documents` rows for documents
 * it read beforehand, so each deleted source is re-purged once the job stops.
 */

/**
 * Re-apply each pending purge, returning the ids that did not get done.
 *
 * An id is dropped only once its purge has actually returned. Clearing the
 * whole set up front loses every id after the first failure — and by then the
 * caller has long been told the removal succeeded and the removal tombstone is
 * marked complete, so nothing would ever retry them and the removed source's
 * chunk rows would stay in the index, still reachable by search.
 *
 * Stops at the first failure: whatever broke one purge is likely to break the
 * rest, and each attempt holds the worker's thread. Retained ids are picked up
 * by the next drain, which every exclusive job runs on its way out.
 */
export function applyPendingPurges(
  ids: readonly string[],
  purge: (sourceId: string) => void,
): { retained: Set<string>; failure: Error | null } {
  const retained = new Set(ids);
  for (const sourceId of ids) {
    try {
      purge(sourceId);
      retained.delete(sourceId);
    } catch (err) {
      return { retained, failure: err instanceof Error ? err : new Error(String(err)) };
    }
  }
  return { retained, failure: null };
}
