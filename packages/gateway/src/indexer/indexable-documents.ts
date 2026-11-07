// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which gateway documents the indexer is expected to index.
 *
 * A source's retention cutoff (`maxAge`) keeps documents already stored from
 * before it, but the indexer skips them. Every figure that compares the
 * gateway against the index — the `reindexMissing` gap, the `/status` backlog,
 * the `/index/stats` denominators, the doctor's backlog check and the indexer
 * worker's boot coverage checks — has to count the same population the skip
 * leaves in, or the skipped documents read as a backlog that can never drain.
 * This module is that population, as one predicate in two forms:
 * `isBeforeCutoff` for a document in hand and the queries below for documents
 * in `omnesis.db`.
 *
 * Both forms work by subtraction: every document, less those created before
 * their source's cutoff, less again the exempt contacts among those. The
 * excluded range is read through `idx_documents_source_created_revision` and the
 * contacts through the partial `idx_documents_contact_type`, each pinned with
 * `INDEXED BY` so losing an index is an error rather than a scan of every
 * document's metadata. A source without a cutoff costs nothing beyond the
 * full id list or the `source_stats` count the caller already has.
 *
 * Nothing is recorded about a skipped document. The cutoff is resolved again
 * on every call, so widening or lifting it brings the older documents back
 * into scope with nothing to undo.
 */

import { createLogger, parseDuration, resolveSourceMaxAge } from "@omnesis/core";
import { UNLIMITED_MAX_AGE } from "@omnesis/config";
import { DOCUMENT_ID_PAGE_ROWS, listDocumentIds } from "../data/repositories/DocumentRepository.js";
import { getAllIndexedDocumentIds } from "./db.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("indexer").child("cutoff");

/** The ISO cutoff for a source's documents, or null when none applies. */
export type SourceCutoffResolver = (sourceId: string) => string | null;

/** The `maxAge` setting that applies to a source, or null when none does. */
export type SourceMaxAgeResolver = (sourceId: string) => string | null;

/**
 * The document type the retention cutoff does not apply to. The gateway
 * boundary already refuses to drop contacts on ingest
 * (`DocumentService.applyMaxAgeCutoff` — a contact stays relevant however old
 * the record is), so a cutoff applied here would keep them retained and
 * permanently unsearchable. The partial index `idx_documents_contact_type`
 * is declared on the same literal.
 */
export const CUTOFF_EXEMPT_DOCUMENT_TYPE = "contact";

const EXEMPT_PREDICATE = `json_extract(metadata, '$.documentType') = '${CUTOFF_EXEMPT_DOCUMENT_TYPE}'`;

/** How long the per-source excluded counts behind the HTTP figures are reused. */
export const EXCLUDED_COUNT_TTL_MS = 60_000;

const warnedMaxAges = new Set<string>();

/**
 * The ISO cutoff a `maxAge` setting gives at `now`, or null for none. A value
 * the schema admits but `parseDuration` refuses (beyond 100 years) applies no
 * cutoff — the same answer the indexer worker has always given — and is
 * logged once per value rather than failing every caller.
 */
export function cutoffFromMaxAge(
  maxAge: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!maxAge || maxAge === UNLIMITED_MAX_AGE) return null;
  try {
    return new Date(now - parseDuration(maxAge)).toISOString();
  } catch (err) {
    if (!warnedMaxAges.has(maxAge)) {
      warnedMaxAges.add(maxAge);
      log.warn(
        `maxAge "${maxAge}" cannot be applied, indexing as if unlimited: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
}

/** The `maxAge` each source resolves to under `config`, as the ingest boundary resolves it. */
export function configMaxAgeResolver(
  config: Parameters<typeof resolveSourceMaxAge>[0],
): SourceMaxAgeResolver {
  return (sourceId) => resolveSourceMaxAge(config, sourceId) ?? null;
}

/** Whether the retention cutoff keeps a document out of the index. */
export function isBeforeCutoff(
  cutoff: string | null,
  sourceCreatedAt: string,
  documentType: string | null | undefined,
): boolean {
  return (
    cutoff !== null && sourceCreatedAt < cutoff && documentType !== CUTOFF_EXEMPT_DOCUMENT_TYPE
  );
}

/**
 * Every distinct `source_id` in `documents`, read as a skip-scan: one index
 * seek per source rather than a walk of every document's index entry.
 */
export function listDocumentSourceIds(db: Db): string[] {
  return db
    .prepare<[], string>(
      `WITH RECURSIVE sources(source_id) AS (
         SELECT (SELECT MIN(source_id) FROM documents INDEXED BY idx_documents_source_id)
         UNION ALL
         SELECT (SELECT MIN(source_id) FROM documents INDEXED BY idx_documents_source_id
                  WHERE source_id > sources.source_id)
           FROM sources
          WHERE sources.source_id IS NOT NULL
       )
       SELECT source_id FROM sources WHERE source_id IS NOT NULL`,
    )
    .pluck()
    .all();
}

type ExemptDocument = { id: string; sourceId: string; created: string };

/** Every exempt document, read once per call through the partial contact index. */
function listExemptDocuments(db: Db): ExemptDocument[] {
  return db
    .prepare<[], ExemptDocument>(
      `SELECT id, source_id AS sourceId, source_created_at AS created
         FROM documents INDEXED BY idx_documents_contact_type
        WHERE ${EXEMPT_PREDICATE}`,
    )
    .all();
}

/**
 * Ids of `sourceId`'s documents created before `cutoff`, exempt ones
 * included — the range the cutoff can exclude.
 *
 * Read by keyset on `(source_created_at, id)`, which is the index's own
 * order, so a page never sorts and a large run of equal dates costs no more
 * than any other page; `pageRows` per statement, so a large range does not
 * hold one WAL snapshot open (see `docs/conventions.md`, "A long read holds
 * the WAL open"). Each id is read as of its own page. A document written,
 * re-dated or renumbered by a `VACUUM` while this runs can be misplaced for
 * one pass: a missed exclusion is caught by `reindexMissing`'s in-memory
 * re-check of what it fetches, and a missed inclusion is seen by the next pass.
 */
export function listPreCutoffDocumentIdsForSource(
  db: Db,
  sourceId: string,
  cutoff: string,
  pageRows: number = DOCUMENT_ID_PAGE_ROWS,
): string[] {
  const limit = Math.max(1, Math.floor(pageRows));
  type Row = { id: string; created: string };
  const first = db.prepare<[string, string, number], Row>(
    `SELECT id, source_created_at AS created
       FROM documents INDEXED BY idx_documents_source_created_revision
      WHERE source_id = ? AND source_created_at < ?
      ORDER BY source_created_at, id
      LIMIT ?`,
  );
  const next = db.prepare<[string, string, string, string, string, number], Row>(
    `SELECT id, source_created_at AS created
       FROM documents INDEXED BY idx_documents_source_created_revision
      WHERE source_id = ? AND source_created_at < ? AND source_created_at >= ?
        AND NOT (source_created_at = ? AND id <= ?)
      ORDER BY source_created_at, id
      LIMIT ?`,
  );
  const ids: string[] = [];
  let rows = first.all(sourceId, cutoff, limit);
  for (;;) {
    for (const row of rows) ids.push(row.id);
    if (rows.length < limit) return ids;
    const last = rows[rows.length - 1]!;
    rows = next.all(sourceId, cutoff, last.created, last.created, last.id, limit);
  }
}

/**
 * Ids of every document the indexer is expected to index: `listDocumentIds`,
 * less each source's pre-cutoff documents that are not exempt. With no cutoff
 * anywhere it is `listDocumentIds` itself.
 */
export function listIndexableDocumentIds(
  db: Db,
  cutoffFor: SourceCutoffResolver,
  pageRows: number = DOCUMENT_ID_PAGE_ROWS,
): string[] {
  const all = listDocumentIds(db, pageRows);
  const cutoffs = listDocumentSourceIds(db)
    .map((sourceId) => [sourceId, cutoffFor(sourceId)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  if (cutoffs.length === 0) return all;
  const exempt = new Set(listExemptDocuments(db).map((doc) => doc.id));
  const excluded = new Set<string>();
  for (const [sourceId, cutoff] of cutoffs) {
    for (const id of listPreCutoffDocumentIdsForSource(db, sourceId, cutoff, pageRows)) {
      if (!exempt.has(id)) excluded.add(id);
    }
  }
  if (excluded.size === 0) return all;
  return all.filter((id) => !excluded.has(id));
}

/** How many of `sourceId`'s documents the cutoff excludes, given the exempt documents. */
function countExcludedForSource(
  db: Db,
  sourceId: string,
  cutoff: string,
  exempt: readonly ExemptDocument[],
): number {
  const before =
    db
      .prepare<[string, string], number>(
        `SELECT COUNT(*) FROM documents INDEXED BY idx_documents_source_created_revision
          WHERE source_id = ? AND source_created_at < ?`,
      )
      .pluck()
      .get(sourceId, cutoff) ?? 0;
  let kept = 0;
  for (const doc of exempt) if (doc.sourceId === sourceId && doc.created < cutoff) kept++;
  return Math.max(0, before - kept);
}

const excludedCountCache = new WeakMap<
  Db,
  { at: number; key: string; counts: Record<string, number> }
>();

/**
 * How many documents the cutoff excludes, per source with one. The HTTP
 * figures poll this, so it is computed at most once per
 * `EXCLUDED_COUNT_TTL_MS` per read handle: the population moves only as
 * documents age past a cutoff or old ones arrive, and a changed setting (a
 * different `maxAge` for any source) recomputes it at once.
 */
export function excludedCountsBySource(
  db: Db,
  sourceIds: readonly string[],
  maxAgeFor: SourceMaxAgeResolver,
  now: number = Date.now(),
): Record<string, number> {
  const settings = sourceIds
    .map((sourceId) => [sourceId, maxAgeFor(sourceId)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const key = JSON.stringify(settings);
  const cached = excludedCountCache.get(db);
  if (cached && cached.key === key && now - cached.at < EXCLUDED_COUNT_TTL_MS) {
    return cached.counts;
  }
  const counts: Record<string, number> = {};
  const withCutoff = settings
    .map(([sourceId, maxAge]) => [sourceId, cutoffFromMaxAge(maxAge, now)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  if (withCutoff.length > 0) {
    const exempt = listExemptDocuments(db);
    for (const [sourceId, cutoff] of withCutoff) {
      counts[sourceId] = countExcludedForSource(db, sourceId, cutoff, exempt);
    }
  }
  excludedCountCache.set(db, { at: now, key, counts });
  return counts;
}

/**
 * Per-source indexable counts for callers that already hold each source's
 * full document count (`source_stats.doc_count`): the full count less the
 * cached excluded count.
 */
export function indexableCountsBySource(
  db: Db,
  fullCounts: Readonly<Record<string, number>>,
  maxAgeFor: SourceMaxAgeResolver,
  now: number = Date.now(),
): Record<string, number> {
  const excluded = excludedCountsBySource(db, Object.keys(fullCounts), maxAgeFor, now);
  const counts: Record<string, number> = {};
  for (const [sourceId, full] of Object.entries(fullCounts)) {
    counts[sourceId] = Math.max(0, full - (excluded[sourceId] ?? 0));
  }
  return counts;
}

/** The documents the indexer is expected to index, and how many of them it has not. */
export interface IndexCoverage {
  indexable: number;
  missing: number;
}

/**
 * Exact coverage of the indexable population by `index.db`: the same set
 * difference `reindexMissing` takes. An indexed document the cutoff now
 * excludes counts for neither side, so it cannot hide a gap in the window.
 */
export function indexCoverage(
  gatewayDb: Db,
  indexDb: Db,
  cutoffFor: SourceCutoffResolver,
): IndexCoverage {
  const indexable = listIndexableDocumentIds(gatewayDb, cutoffFor);
  const indexed = getAllIndexedDocumentIds(indexDb);
  let missing = 0;
  for (const id of indexable) if (!indexed.has(id)) missing++;
  return { indexable: indexable.length, missing };
}

/** Whether less than `fraction` of the indexable population is indexed. */
export function coverageBelow(coverage: IndexCoverage, fraction: number): boolean {
  if (coverage.indexable === 0) return false;
  return (coverage.indexable - coverage.missing) / coverage.indexable < fraction;
}
