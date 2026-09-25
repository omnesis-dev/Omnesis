// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The retrospective bootstrap work-list (experimental). Selects PAST documents
 * that still carry a semantic time in the future — the ~1.8% of the corpus that
 * disproportionately anchors still-open obligations — so the background agent
 * can seed loops + temporal annotations from history without an LLM pass over every
 * document (d180 §7, d156 Theme 8).
 *
 * Selection rules:
 *  - at least one extracted date whose period-end is >= today (still relevant),
 *  - not yet bootstrap-processed (the per-doc `bootstrap_processed_at` marker),
 *  - the datum is OLDER than the live waker's recency window, so the two lanes
 *    partition the corpus instead of racing for it (see below),
 *  - excluding web ephemera (too noisy) and the agent's own derived mirror docs,
 *  - ordered recent → oldest (recent documents' future dates are far likelier
 *    to still matter; the deep past is mostly gate-misses).
 *
 * **Why the boundary is the datum's own timestamp, not its ingestion time.**
 * The two lanes have to divide the corpus without overlapping (a document
 * processed twice costs a full model run) and without leaving a gap. An
 * ingestion cutoff only achieves that for the corpus present when it was set:
 * the waker's own gate keys on the SOURCE timestamp — deliberately, so a
 * history backfill cannot flood the engine — so a source connected later had
 * its whole history ingested after the cutoff (invisible to bootstrap) and
 * emitted before the recency window (invisible to the waker). Every record in
 * it older than a week was covered by neither, permanently and silently.
 *
 * Keying both lanes on the same clock removes the hole by construction: the
 * waker takes a datum iff it is within the recency window, bootstrap takes it
 * iff it is not. No source, and no connection order, can fall between them.
 */

import { WAKER_SKIP_DOC_TYPES } from "../waker/eligibility.js";
import {
  cognitionAuthoredDocumentTypes,
  cognitionAuthoredSqlExclusion,
} from "../cognition-authored.js";
import { BOOTSTRAP_DEDUPE_PREFIX } from "../run-payloads.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * Document types the bootstrap never processes: web ephemera (marketing pages,
 * bookmarks, browsing history — real future dates that aren't the user's
 * obligations, per the d180 hill-climb) plus the types emitted ONLY by a
 * cognition-authored source, so the retrospective lane never buys a run to
 * reason over the engine's own output.
 *
 * This set is half of that exclusion. It cannot cover a cognition-authored
 * source whose types are shared with the corpus — an agent transcript is a
 * `conversation`, like any messaging thread — so the query pairs it with a
 * source-id arm. Generic doc-type gate, never keyed on a source name.
 */
export const BOOTSTRAP_EXCLUDE_DOC_TYPES: ReadonlySet<string> = new Set([
  ...WAKER_SKIP_DOC_TYPES,
  ...cognitionAuthoredDocumentTypes(),
]);

export interface BootstrapDocRow {
  docId: string;
  /** Source emission timestamp (unix ms) — the doc's real date, for the prompt. */
  datumAt: number;
  /** The source the document came from — the key coverage is tallied under. */
  sourceId: string;
}

/**
 * The "still-relevant future date" predicate + doc-type / recency filters,
 * shared by the batch and count queries. `@recencyFloor` and today are bound
 * by the caller.
 */
function whereClause(excludePlaceholders: string, authoredSourcePlaceholders: string): string {
  return `
    d.bootstrap_processed_at IS NULL
    -- The waker's own timestamp expression, negated: it wakes on a datum
    -- within the recency window, so this takes exactly the rest.
    AND COALESCE(d.source_updated_at, d.source_created_at) < @recencyFloor
    AND json_extract(d.metadata, '$.documentType') NOT IN (${excludePlaceholders})
    -- Cognition-authored sources by source id as well as by type. The type
    -- filter above cannot cover them all: an agent transcript's type is
    -- \`conversation\`, shared with every messaging source, so it is registered
    -- with no exclusive type and only the source column identifies it.
    AND d.source_id NOT IN (${authoredSourcePlaceholders})
    AND EXISTS (
      SELECT 1 FROM document_extracted_dates x
      WHERE x.document_id = d.id
        AND COALESCE(x.resolved_end, x.resolved_start) IS NOT NULL
        AND ${stillFutureSql("date('now')")}
    )`;
}

/**
 * The lane's "this date is still ahead" test, as SQL over an aliased
 * `document_extracted_dates x`.
 *
 * Shared rather than restated, because the padding is the part that surprises:
 * a coarse date is compared at its period END, so a document dated `2026`
 * counts until 31 December and one dated `2026-08` until the 31st. Comparing
 * the stored value directly looks equivalent and is not — `'2026-08'` sorts
 * before `'2026-08-24'`, so a whole month of candidates silently drops out.
 * The history timeline reimplemented this and lost exactly those documents,
 * which is why it now calls the same expression the selection query does.
 *
 * `todayExpr` is the SQL for "today": the selection path passes `date('now')`,
 * a caller that must honour an injected clock passes a bound parameter.
 *
 * The test subsumes every mod: a "before X"/"until X" deadline keys on
 * `resolved_end`; an "after X"/"since X" open bound keys on its
 * `resolved_start`, so a past "since 2015" is correctly excluded while an
 * "after 2099" is kept — matching the date-extraction gate and the
 * "extracted date >= NOW()" contract.
 */
function stillFutureSql(todayExpr: string): string {
  return `CASE length(COALESCE(x.resolved_end, x.resolved_start))
            WHEN 4 THEN COALESCE(x.resolved_end, x.resolved_start) || '-12-31'
            WHEN 7 THEN date(COALESCE(x.resolved_end, x.resolved_start) || '-01', '+1 month', '-1 day')
            ELSE COALESCE(x.resolved_end, x.resolved_start)
          END >= ${todayExpr}`;
}

function excludeList(): string[] {
  return [...BOOTSTRAP_EXCLUDE_DOC_TYPES];
}

/**
 * The named placeholders and bound values both bootstrap queries share: the
 * excluded document types, and the cognition-authored source ids. Built once so
 * the batch query and the count query cannot drift into scanning different
 * populations — the enqueuer's backlog cap is derived from the count and would
 * silently disagree with what the batch returns.
 */
function exclusionBindings(): {
  typePlaceholders: string;
  sourcePlaceholders: string;
  params: Record<string, string>;
} {
  const types = excludeList();
  const sources = cognitionAuthoredSqlExclusion().params;
  const params: Record<string, string> = {};
  types.forEach((t, i) => (params[`ex${i}`] = t));
  sources.forEach((s, i) => (params[`src${i}`] = s));
  return {
    typePlaceholders: types.map((_, i) => `@ex${i}`).join(","),
    sourcePlaceholders: sources.map((_, i) => `@src${i}`).join(","),
    params,
  };
}

/**
 * Fetch up to `batchSize` unprocessed bootstrap candidates, ordered recent →
 * oldest (or oldest → recent when `direction === "oldest-first"`). Runs on a
 * read-only handle.
 */
export function fetchBootstrapBatch(
  db: Db,
  opts: {
    /** ISO instant below which a datum belongs to bootstrap, not the waker. */
    recencyFloor: string;
    batchSize: number;
    direction?: "recent-first" | "oldest-first";
  },
): BootstrapDocRow[] {
  const { typePlaceholders, sourcePlaceholders, params: exclusions } = exclusionBindings();
  const order = opts.direction === "oldest-first" ? "ASC" : "DESC";
  const params: Record<string, unknown> = {
    ...exclusions,
    recencyFloor: opts.recencyFloor,
    limit: opts.batchSize,
  };
  const rows = db
    .prepare(
      `SELECT d.id AS docId, d.source_created_at AS sourceCreatedAt, d.source_id AS sourceId
         FROM documents d
        WHERE ${whereClause(typePlaceholders, sourcePlaceholders)}
        ORDER BY d.source_created_at ${order}
        LIMIT @limit`,
    )
    .all(params) as Array<{ docId: string; sourceCreatedAt: string; sourceId: string }>;
  return rows.map((r) => ({
    docId: r.docId,
    datumAt: Date.parse(r.sourceCreatedAt),
    sourceId: r.sourceId,
  }));
}

/** Count unprocessed bootstrap candidates — drives the enqueuer's backlog cap
 *  and the completion check. */
export function countPendingBootstrap(db: Db, recencyFloor: string): number {
  const { typePlaceholders, sourcePlaceholders, params: exclusions } = exclusionBindings();
  const params: Record<string, unknown> = { ...exclusions, recencyFloor };
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM documents d WHERE ${whereClause(typePlaceholders, sourcePlaceholders)}`,
      )
      .get(params) as { c: number }
  ).c;
}

/** Mark documents as bootstrap-processed (set once, never cleared). Chunked
 *  under the SQLite bind-variable cap. Runs on the single writer. */
export function markDocsBootstrapProcessed(
  db: Db,
  docIds: readonly string[],
  nowIso: string,
): number {
  if (docIds.length === 0) return 0;
  const CHUNK = 400;
  let marked = 0;
  const run = db.transaction((ids: readonly string[]) => {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const info = db
        .prepare(
          `UPDATE documents SET bootstrap_processed_at = ?
             WHERE id IN (${placeholders}) AND bootstrap_processed_at IS NULL`,
        )
        .run(nowIso, ...slice);
      marked += info.changes;
    }
  });
  run(docIds);
  return marked;
}

/**
 * The newest `sources.created_at` (0 when no source exists) — the signal a
 * quiet bootstrap lane watches to know it has work again.
 *
 * Connecting a source is what puts a whole unreviewed history in the corpus,
 * and it is the one event that can turn a lane with nothing left to do into a
 * lane far behind. Watching the roster's own high-water mark rather than
 * having the source-creation path notify the Brain keeps the two apart: no
 * source-add code path can forget to call anything, a source added while the
 * Brain was switched off is still noticed, and this stays a single scan of a
 * table with a handful of rows.
 */
export function latestSourceCreatedAt(db: Db): number {
  const row = db
    .prepare<[], { newest: number | null }>("SELECT MAX(created_at) AS newest FROM sources")
    .get();
  return row?.newest ?? 0;
}

/**
 * The two partial indexes over the `bootstrap_processed_at` marker.
 *
 * A partial index only covers rows satisfying its own WHERE, so the two
 * predicates need two indexes: the lane's "find work" scan reads the UNSET
 * side (carrying `source_created_at`, the order it walks in), and the coverage
 * read counts the SET side. Without the second, that count — served to the
 * portal on a 60-second poll — is a full scan of `documents`.
 *
 * Idempotent, and called from both DDL paths (schema setup on a fresh install,
 * the migration on an upgrading one) so the two converge on one definition.
 * Guarded on the column, because schema setup runs ahead of the migration that
 * adds it to an install upgrading from an older schema.
 */
export function createBootstrapMarkerIndexes(db: Db): void {
  const columns = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
    .all()
    .map((r) => r.name);
  if (!columns.includes("bootstrap_processed_at")) return;
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_bootstrap_pending ON documents(source_created_at) WHERE bootstrap_processed_at IS NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_bootstrap_processed ON documents(id) WHERE bootstrap_processed_at IS NOT NULL",
  );
}

/** Count how many documents have been bootstrap-processed — observability. */
export function countBootstrapProcessed(db: Db): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM documents WHERE bootstrap_processed_at IS NOT NULL")
      .get() as {
      c: number;
    }
  ).c;
}

/**
 * How many times a document may be re-admitted after its bootstrap run failed
 * terminally.
 *
 * The marker exists so the enqueuer never re-selects a document, which is what
 * keeps one pass from re-reasoning over work another pass already did. Lifting
 * it on a terminal failure trades that guarantee for progress: the document
 * was demonstrably never reasoned over, so re-admitting it costs one duplicate
 * run at worst and recovers a permanent hole at best.
 *
 * Bounded because the trade only holds while the failure is incidental. A
 * document that fails on its own content fails the same way every time, and an
 * unbounded lift would cycle it through the lane forever, spending real money
 * per attempt and starving the rest of the backlog. After this many terminal
 * failures the marker stands and the document is left alone.
 */
export const BOOTSTRAP_TERMINAL_READMISSIONS = 3;

/**
 * Count of terminally-failed bootstrap runs recorded for one document.
 *
 * Read from the run ledger rather than a counter column on `documents`: the
 * ledger already records exactly this, keyed by the dedupe key the enqueuer
 * mints, so a second place to keep the same number could only drift from it.
 */
function countFailedBootstrapRuns(db: Db, docId: string): number {
  return db
    .prepare<
      [string],
      { n: number }
    >("SELECT COUNT(*) AS n FROM cognition_runs WHERE dedupe_key = ? AND status = 'failed'")
    .get(`${BOOTSTRAP_DEDUPE_PREFIX}${docId}`)!.n;
}

/**
 * Lift the processed marker so the enqueuer may select this document again.
 *
 * Returns whether the marker was actually lifted: false when the document has
 * already exhausted its re-admissions, or carries no marker to lift.
 *
 * Folding is not a hazard here — the enqueuer's fold matches only `pending`
 * rows, so the terminal row this is reacting to cannot absorb the fresh
 * enqueue and silently swallow the re-admission.
 */
export function readmitFailedBootstrapDoc(db: Db, docId: string): boolean {
  if (countFailedBootstrapRuns(db, docId) > BOOTSTRAP_TERMINAL_READMISSIONS) {
    // Giving up is recorded on the document, not left to be inferred from the
    // run ledger: those rows are pruned, and an abandoned document that later
    // became indistinguishable from a reviewed one would overstate coverage
    // permanently and silently.
    db.prepare<[string]>(
      "UPDATE documents SET bootstrap_failed_at = bootstrap_processed_at WHERE id = ? AND bootstrap_failed_at IS NULL",
    ).run(docId);
    return false;
  }
  const info = db
    .prepare<
      [string]
    >("UPDATE documents SET bootstrap_processed_at = NULL WHERE id = ? AND bootstrap_processed_at IS NOT NULL")
    .run(docId);
  return info.changes > 0;
}

/** One month of the corpus, split by what the lane has made of it. */
export interface BootstrapMonthRow {
  /** `YYYY-MM` of the document's own timestamp, not its ingest time. */
  month: string;
  /** Date extraction has not run yet, so nothing is known about these. */
  unscanned: number;
  /** Scanned and set aside: no still-relevant future date to reason about. */
  discarded: number;
  /** A candidate the lane has not reached. */
  owed: number;
  /** Reviewed: carries the processed marker and was not given up on. */
  reviewed: number;
  /**
   * Given up on: the lane exhausted its re-admissions and abandoned the
   * document. Read from the document's own marker rather than the run ledger,
   * which is pruned — an abandoned document that faded back into `reviewed`
   * would overstate coverage permanently.
   */
  failed: number;
}

/**
 * The corpus month by month, as far back as it goes, split into the four
 * things the lane can have made of a document.
 *
 * This is the picture of where the Brain stands: the lane walks recent-first,
 * so its frontier is the month where `reviewed` gives way to `owed`, sweeping
 * backwards through the operator's own history.
 *
 * `unscanned` is a band rather than a caveat. Date extraction is not
 * instantaneous — it is a recognizer pass over the text — so on a corpus still
 * being ingested a real share of documents genuinely have no verdict yet.
 * Folding them into `discarded` would claim the lane had considered and
 * dismissed them, which is exactly the false completeness this whole surface
 * exists to avoid.
 *
 * It keys on `documents.dates_extracted_at`, the stamp the extraction pass
 * writes, and NOT on whether the document has rows in
 * `document_extracted_dates`. A scan that finds no date writes no rows, so
 * absence of rows means "scanned, nothing found" just as often as it means
 * "not scanned" — reading it as the latter reported an install whose
 * extraction was entirely complete as having 78,650 documents nobody had
 * looked at.
 *
 * Documents inside the recency window are excluded: they belong to the live
 * waker, and showing them here would draw the newest months as permanently
 * unreviewed by a lane that is never going to read them.
 *
 * A full grouped scan of `documents` joined to the extracted dates — the same
 * cost class as the backlog count, and served from the same cache for the same
 * reason.
 */
export function bootstrapCorpusByMonth(
  db: Db,
  recencyFloor: string,
  todayIso: string,
): BootstrapMonthRow[] {
  const excludes = [...BOOTSTRAP_EXCLUDE_DOC_TYPES];
  const authored = cognitionAuthoredSqlExclusion().params;
  const ex = excludes.map(() => "?").join(",") || "''";
  const au = authored.map(() => "?").join(",") || "''";
  return db
    .prepare<unknown[], BootstrapMonthRow>(
      `SELECT
         substr(COALESCE(d.source_updated_at, d.source_created_at), 1, 7) AS month,
         SUM(CASE WHEN d.bootstrap_processed_at IS NOT NULL AND d.bootstrap_failed_at IS NULL THEN 1 ELSE 0 END) AS reviewed,
         SUM(CASE WHEN d.bootstrap_failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN d.bootstrap_processed_at IS NULL AND d.dates_extracted_at IS NULL THEN 1 ELSE 0 END) AS unscanned,
         SUM(CASE WHEN d.bootstrap_processed_at IS NULL AND d.dates_extracted_at IS NOT NULL AND x.still_future = 1 THEN 1 ELSE 0 END) AS owed,
         SUM(CASE WHEN d.bootstrap_processed_at IS NULL AND d.dates_extracted_at IS NOT NULL AND COALESCE(x.still_future, 0) = 0 THEN 1 ELSE 0 END) AS discarded
       FROM documents d
       LEFT JOIN (
         SELECT x.document_id AS document_id,
                MAX(CASE WHEN ${stillFutureSql("?")} THEN 1 ELSE 0 END) AS still_future
           FROM document_extracted_dates x
          GROUP BY document_id
       ) x ON x.document_id = d.id
       WHERE COALESCE(d.source_updated_at, d.source_created_at) < ?
         AND json_extract(d.metadata, '$.documentType') NOT IN (${ex})
         AND d.source_id NOT IN (${au})
       GROUP BY month
       HAVING month IS NOT NULL
       ORDER BY month ASC`,
    )
    .all(todayIso, recencyFloor, ...excludes, ...authored);
}
