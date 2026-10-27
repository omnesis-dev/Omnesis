// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Sources the Brain never processes (`brain.excludedSources`).
 *
 * The exclusion is operator configuration, generic over sources: an entry is
 * either a bare source type, which covers every source of that type, or an
 * exact source id, which covers that one source. Matching follows
 * `sourceIdAddresses`, so a type compares on the type component of an id and
 * never as a string prefix.
 *
 * The list is read live from the Brain settings by every consumer, so a config
 * change takes effect on the next tick or tool call without a restart. The
 * consumers are the admission paths (knowledge intake, historical and recent
 * inventory admission, organization cohorts, the daily batch enqueuer and the
 * waker), the retirement of pending work already queued, the read fence
 * around a background run's tools (`steward/source-fence.ts`), and the
 * verifier and judges behind a background run's page saves and the morning
 * recheck. The interactive agent never consults it.
 */

import { sourceIdAddresses } from "@omnesis/types";
import type Database from "better-sqlite3";

/** True when one of `excluded` addresses `sourceId`. */
export function isBrainExcludedSource(excluded: readonly string[], sourceId: string): boolean {
  return excluded.some((entry) => sourceIdAddresses(entry, sourceId));
}

/**
 * A SQL predicate that is true when `column` (a source id) is NOT excluded,
 * with its bound parameters. With no exclusions it is the constant `1`, so a
 * caller can concatenate it unconditionally.
 *
 * An entry matches an id exactly; a bare type also matches every id whose type
 * component (the text before the first colon, when that colon is not the first
 * character) equals it — the SQL spelling of `sourceIdAddresses`.
 */
export function brainSourceInclusionSql(
  excluded: readonly string[],
  column: string,
): { sql: string; params: string[] } {
  if (excluded.length === 0) return { sql: "1", params: [] };
  const types = excluded.filter((entry) => !entry.includes(":"));
  const exact = `${column} IN (${excluded.map(() => "?").join(",")})`;
  const byType = types.length
    ? ` OR (instr(${column},':')>1 AND substr(${column},1,instr(${column},':')-1) IN (${types.map(() => "?").join(",")}))`
    : "";
  return { sql: `NOT (${exact}${byType})`, params: [...excluded, ...types] };
}

const LOOKUP_CHUNK = 500;

/** The subset of `documentIds` whose document belongs to an excluded source. */
export function excludedDocumentIds(
  db: Database.Database,
  excluded: readonly string[],
  documentIds: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  if (excluded.length === 0) return out;
  const ids = [...new Set(documentIds)];
  const inclusion = brainSourceInclusionSql(excluded, "source_id");
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + LOOKUP_CHUNK);
    const rows = db
      .prepare<unknown[], { id: string }>(
        `SELECT id FROM documents WHERE id IN (${chunk.map(() => "?").join(",")}) AND NOT (${inclusion.sql})`,
      )
      .all(...chunk, ...inclusion.params);
    for (const row of rows) out.add(row.id);
  }
  return out;
}

/**
 * A live view of the exclusion for one consumer: every call re-reads the
 * configured list, so a long-running Brain run sees a change made mid-run.
 */
export interface BrainSourceFence {
  /** The configured entries, as currently set. */
  entries(): readonly string[];
  excludesSource(sourceId: string): boolean;
  /** The subset of `documentIds` that belong to excluded sources. */
  excludedDocuments(documentIds: Iterable<string>): Set<string>;
  /** A fence fixed to the list as it is now, for one call that checks many items. */
  snapshot(): BrainSourceFence;
}

export function createBrainSourceFence(
  db: Database.Database,
  getExcluded: () => readonly string[],
): BrainSourceFence {
  return {
    entries: getExcluded,
    excludesSource: (sourceId) => isBrainExcludedSource(getExcluded(), sourceId),
    excludedDocuments: (documentIds) => excludedDocumentIds(db, getExcluded(), documentIds),
    snapshot: () => {
      const entries = getExcluded();
      return createBrainSourceFence(db, () => entries);
    },
  };
}
