// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A position in a `(timestamp, id)` keyset, and how it is stored.
 *
 * Both sweeps the materializer runs page over a timestamp that is not unique:
 * one `upsertDocuments` call stamps a whole page of documents with a single
 * `updated_at`, and a batch index stamps the same `event_indexed_at` on
 * everything it wrote. A cursor that moved strictly past a timestamp would
 * permanently skip every row tied at the page boundary, so the row's id is
 * carried alongside as the tie-break — the pair is strictly increasing where
 * the timestamp alone is not.
 *
 * The empty id sorts before every real one, which is what makes "resume at the
 * start of this timestamp's group" expressible: `{ at, id: "" }` re-reads the
 * whole group rather than the part after some particular row.
 */

export interface Checkpoint {
  at: string;
  id: string;
}

/**
 * `(at, id)` as one stored string.
 *
 * A space separates them because it appears in neither an ISO instant (which
 * uses `T`) nor a UUID.
 */
export function encodeCheckpoint(checkpoint: Checkpoint): string {
  return `${checkpoint.at} ${checkpoint.id}`;
}

/**
 * Read a stored checkpoint, or `null` when there is none.
 *
 * A value with no separator is read as a bare timestamp with an empty id,
 * which resumes at the start of that timestamp's group — the safe direction,
 * since it re-emits rather than skips.
 */
export function decodeCheckpoint(value: string | null): Checkpoint | null {
  if (value === null) return null;
  const separator = value.indexOf(" ");
  if (separator === -1) return { at: value, id: "" };
  return { at: value.slice(0, separator), id: value.slice(separator + 1) };
}

/** Whether `a` is strictly further along the keyset than `b`. */
export function isAfter(a: Checkpoint, b: Checkpoint): boolean {
  return a.at !== b.at ? a.at > b.at : a.id > b.id;
}
