// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * LLM-owned temporal annotations — a queryable, interval-addressed store of
 * semantic time.
 *
 * Key = a time or time range (a precise instant, or a coarser period — a day,
 * a month, a year — or an arbitrary range); value = an LLM-generated sentence
 * naming what that time means to the user, plus the document(s) it is grounded
 * in. The background agent adds annotations whenever it identifies meaningful
 * semantic time beyond deterministic source-owned temporal projections.
 *
 * Interval model: each entry stores concrete inclusive `[interval_start_ms,
 * interval_end_ms]` bounds in unix-ms UTC (a coarser period expands to its full
 * span, a precise instant has `start == end`). Overlap is the standard predicate
 * `start <= queryEnd AND end >= queryStart` — the durable SQLite-native
 * equivalent of an interval tree (a plain table + B-tree indexes; the R-Tree
 * module is compiled in but is overkill at this scale).
 *
 * Lifecycle mirrors the doc-annotation store: agent-authored derived state in
 * `omnesis.db`, evidence grounded in documents — per-atom verbatim quotes in
 * `temporal_annotation_evidence` — surgical per-atom invalidation on content
 * change, and a hard privacy-purge cascade when a cited document is deleted.
 * The exact per-atom contract: an atom breaks when its quote no longer
 * appears in the cited document (or that document's row vanished), and HEALS
 * when a later change to the same document restores the quote. An annotation
 * survives while at least one atom is unbroken; once every atom is broken it
 * is soft-invalidated with `invalidation_cause = 'content_change'`, and a
 * later change that heals one of its atoms RESURRECTS it. A deliberate
 * `temporal_annotation_delete` stamps `invalidation_cause = 'deleted'` and is
 * final — deleted entries never resurrect and never surface in the re-file
 * read. Entries not linked to any document (an agent-added arbitrary time)
 * are never touched by the cascade.
 */

import { containsNormalizedForContent } from "../../brain/quote-match.js";
import type Database from "better-sqlite3";
import type { TemporalPrecision } from "@omnesis/core";
type Db = Database.Database;

/**
 * Historical DDL used by migrations 40/49/51. Keep this frozen: an install
 * replaying the migration chain must first reach the exact legacy schema that
 * migration 65 renames.
 */
export function createLegacyTimeIndexTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_index_entries (
      id                     TEXT PRIMARY KEY,
      interval_start_ms      INTEGER NOT NULL,
      interval_end_ms        INTEGER NOT NULL,
      granularity            TEXT NOT NULL,
      canonical              TEXT,
      sentence               TEXT NOT NULL,
      kind                   TEXT,
      created_by_run         TEXT NOT NULL,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      invalidated_at         INTEGER,
      thread_conversation_id TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_index_entry_docs (
      entry_id    TEXT NOT NULL REFERENCES time_index_entries(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      PRIMARY KEY (entry_id, document_id)
    )
  `);
  // Overlap query drives off whichever bound STAT4 finds more selective: the
  // end bound is selective for forward "upcoming" windows, the start bound for
  // backward/bounded ones. Partial on live rows only.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_time_index_end ON time_index_entries(interval_end_ms) WHERE invalidated_at IS NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_time_index_start ON time_index_entries(interval_start_ms) WHERE invalidated_at IS NULL",
  );
  // "which entries cite this document" — the privacy cascade + doc→entries lookup.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_time_index_entry_docs_doc ON time_index_entry_docs(document_id)",
  );
  // Entry ↔ open-loop backlinks. A single join table serves BOTH directions
  // (entry→loops via the correlated read, loop→entries via
  // listTimeIndexEntriesForLoop). Both parents cascade on delete: a purged
  // entry or a deleted loop drops its rows. open_loops is created by
  // createBriefsStorageTables, which runs ahead of this in both runSchemaSetup
  // and the introducing migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_index_entry_loops (
      entry_id TEXT NOT NULL REFERENCES time_index_entries(id) ON DELETE CASCADE,
      loop_id  TEXT NOT NULL REFERENCES open_loops(id) ON DELETE CASCADE,
      PRIMARY KEY (entry_id, loop_id)
    )
  `);
  // Reverse (loop → entries) lookup; the forward direction rides the PK.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_time_index_entry_loops_loop ON time_index_entry_loops(loop_id)",
  );
  // Entry ↔ person backlinks. person_id carries NO FK — people rows merge and
  // re-derive out from under an entry, so the join tolerates a stale id (the
  // open_loop_people / open_loop_docs convention); a merged-away id simply
  // returns no rows on read.
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_index_entry_people (
      entry_id  TEXT NOT NULL REFERENCES time_index_entries(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL,
      PRIMARY KEY (entry_id, person_id)
    )
  `);
  // Reverse (person → entries) lookup.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_time_index_entry_people_person ON time_index_entry_people(person_id)",
  );
}

/** Idempotent live DDL for the LLM-owned temporal annotation store. */
export function createTemporalAnnotationTables(db: Db): void {
  // `invalidation_cause` (NULL on live rows) distinguishes churn casualties
  // ('content_change' — eligible for resurrection and the re-file prompt)
  // from deliberate removals ('deleted' — final). `refile_presented_run`
  // records which data run's prompt last listed a churn casualty for
  // re-filing: the re-file lookup skips entries whose presented run has
  // COMPLETED (the run saw them and made its call), while a failed or
  // vanished run re-presents. Cleared on every fresh invalidation and on
  // resurrection, so each invalidation event earns exactly one completed
  // presentation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS temporal_annotations (
      id                     TEXT PRIMARY KEY,
      interval_start_ms      INTEGER NOT NULL,
      interval_end_ms        INTEGER NOT NULL,
      precision              TEXT NOT NULL,
      canonical              TEXT,
      sentence               TEXT NOT NULL,
      kind                   TEXT,
      created_by_run         TEXT NOT NULL,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      invalidated_at         INTEGER,
      invalidation_cause     TEXT,
      refile_presented_run   TEXT
    )
  `);
  // `document_id` carries NO FK — the doc-link convention (`open_loop_docs`,
  // `time_index_entry_people`). The privacy cascade selects its victims FROM
  // this table after the document rows are gone; an FK cascade would erase
  // the very rows the purge keys on, leaving annotations about a deleted
  // document alive and queryable. Stale ids are tolerated on read (a missing
  // document simply resolves to no row) and the purge removes the links with
  // their annotations.
  db.exec(`
    CREATE TABLE IF NOT EXISTS temporal_annotation_documents (
      annotation_id TEXT NOT NULL REFERENCES temporal_annotations(id) ON DELETE CASCADE,
      document_id   TEXT NOT NULL,
      PRIMARY KEY (annotation_id, document_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS temporal_annotation_loops (
      annotation_id TEXT NOT NULL REFERENCES temporal_annotations(id) ON DELETE CASCADE,
      loop_id       TEXT NOT NULL REFERENCES open_loops(id) ON DELETE CASCADE,
      PRIMARY KEY (annotation_id, loop_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS temporal_annotation_people (
      annotation_id TEXT NOT NULL REFERENCES temporal_annotations(id) ON DELETE CASCADE,
      person_id     TEXT NOT NULL,
      PRIMARY KEY (annotation_id, person_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS temporal_annotation_projections (
      annotation_id TEXT NOT NULL REFERENCES temporal_annotations(id) ON DELETE CASCADE,
      projection_id TEXT NOT NULL CHECK (projection_id LIKE 'tp_%'),
      PRIMARY KEY (annotation_id, projection_id)
    )
  `);
  // Per-atom grounding quotes (the doc_annotation_evidence shape): 0-based
  // `position`, per-row `broken_at` liveness. The content-change invalidator
  // stamps atoms whose quote no longer appears in the cited document — and
  // clears the stamp when a later change restores the quote — so an
  // annotation is invalidated only while every atom is broken. `document_id`
  // carries no FK — the privacy cascade purges the whole annotation when a
  // cited doc is deleted, and the doc-delete path clears leftovers explicitly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS temporal_annotation_evidence (
      annotation_id TEXT NOT NULL REFERENCES temporal_annotations(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL,
      document_id   TEXT NOT NULL,
      quote         TEXT NOT NULL,
      broken_at     INTEGER,
      PRIMARY KEY (annotation_id, position)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_temporal_annotations_end ON temporal_annotations(interval_end_ms) WHERE invalidated_at IS NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_temporal_annotations_start ON temporal_annotations(interval_start_ms) WHERE invalidated_at IS NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_temporal_annotation_documents_doc ON temporal_annotation_documents(document_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_temporal_annotation_loops_loop ON temporal_annotation_loops(loop_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_temporal_annotation_people_person ON temporal_annotation_people(person_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_temporal_annotation_projections_projection ON temporal_annotation_projections(projection_id)",
  );
  // "Which annotations are grounded in this document" — the invalidator's
  // per-atom quote-survival pass and the doc-delete cleanup key on it.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_temporal_annotation_evidence_doc ON temporal_annotation_evidence(document_id)",
  );
}

/**
 * Expand a canonical date string into concrete inclusive `[start, end]` unix-ms
 * bounds plus its precision. Accepts the date-enrichment canonical formats
 * (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) and full ISO-8601 instants. Returns null for
 * anything unparseable. All calendar math is in UTC — consistent with the
 * enrichment anchor and the query side.
 */
export function expandCanonical(
  v: string,
): { startMs: number; endMs: number; precision: TemporalPrecision } | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : { startMs: t, endMs: t, precision: "instant" };
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (day) {
    const y = +day[1];
    const m = +day[2];
    const d = +day[3];
    return {
      startMs: Date.UTC(y, m - 1, d),
      endMs: Date.UTC(y, m - 1, d + 1) - 1,
      precision: "day",
    };
  }
  const month = /^(\d{4})-(\d{2})$/.exec(v);
  if (month) {
    const y = +month[1];
    const m = +month[2];
    return { startMs: Date.UTC(y, m - 1, 1), endMs: Date.UTC(y, m, 1) - 1, precision: "month" };
  }
  const year = /^(\d{4})$/.exec(v);
  if (year) {
    const y = +year[1];
    return { startMs: Date.UTC(y, 0, 1), endMs: Date.UTC(y + 1, 0, 1) - 1, precision: "year" };
  }
  return null;
}

/** One grounding atom as callers supply it (create / evidence replace). */
export interface TemporalAnnotationEvidenceInput {
  docId: string;
  quote: string;
}

/** One stored grounding atom of a temporal annotation. */
export interface TemporalAnnotationEvidenceRow {
  annotationId: string;
  /** 0-based order of the atom within the annotation's evidence set. */
  position: number;
  documentId: string;
  quote: string;
  /** Set when a content change broke this atom's quote; null = live. */
  brokenAt: number | null;
}

export interface CreateTemporalAnnotationInput {
  id: string;
  intervalStartMs: number;
  intervalEndMs: number;
  precision: TemporalPrecision;
  /** Original display expression: canonical date / ISO instant / range text. */
  canonical: string | null;
  sentence: string;
  /**
   * Optional classification the agent may attach — the tool boundary enforces
   * deadline | event | reminder | expiry | appointment | episodic; the store
   * keeps it an open string.
   */
  kind?: string | null;
  documentIds: readonly string[];
  /**
   * Verbatim grounding quotes. An annotation with evidence survives content
   * churn on a cited document while at least one quote still appears; one
   * without is blanket-invalidated on any change. Atoms citing unknown docs
   * are dropped (the doc-link convention).
   */
  evidence?: readonly TemporalAnnotationEvidenceInput[];
  /** Open-loop ids to backlink; only ids present in `open_loops` are linked. */
  loopIds?: readonly string[];
  /** Canonical person ids to backlink; written as-is (no FK — people merge). */
  personIds?: readonly string[];
  /** Source-owned projections this interpretation adds meaning to. */
  projectionIds?: readonly string[];
  createdByRun: string;
}

export interface TemporalAnnotation {
  id: string;
  intervalStartMs: number;
  intervalEndMs: number;
  precision: TemporalPrecision;
  canonical: string | null;
  sentence: string;
  kind: string | null;
  createdByRun: string;
  createdAt: number;
  updatedAt: number;
  documentIds: string[];
  /** Open-loop ids this entry backlinks (the entry→loop edge). */
  loopIds: string[];
  /** Canonical person ids this entry backlinks (the entry→person edge). */
  personIds: string[];
  /** Source-owned projections interpreted by this annotation. */
  projectionIds: string[];
  revision: number;
}

/** Total chronological sort tuple used by the debug viewer's page cursor. */
export interface TemporalAnnotationPageCursor {
  intervalStartMs: number;
  id: string;
}

interface AnnotationRow {
  id: string;
  interval_start_ms: number;
  interval_end_ms: number;
  precision: string;
  canonical: string | null;
  sentence: string;
  kind: string | null;
  created_by_run: string;
  created_at: number;
  updated_at: number;
  revision: number;
  document_ids: string | null;
  loop_ids: string | null;
  person_ids: string | null;
  projection_ids: string | null;
}

/** The shared SELECT column list every entry read uses (kept in one place). */
const ANNOTATION_COLUMNS = `e.id, e.interval_start_ms, e.interval_end_ms, e.precision, e.canonical,
              e.sentence, e.kind, e.created_by_run, e.created_at, e.updated_at, e.revision,
              (SELECT json_group_array(d.document_id)
                 FROM temporal_annotation_documents d WHERE d.annotation_id = e.id) AS document_ids,
              (SELECT json_group_array(l.loop_id)
                 FROM temporal_annotation_loops l WHERE l.annotation_id = e.id) AS loop_ids,
              (SELECT json_group_array(p.person_id)
                 FROM temporal_annotation_people p WHERE p.annotation_id = e.id) AS person_ids,
              (SELECT json_group_array(p.projection_id)
                 FROM temporal_annotation_projections p
                WHERE p.annotation_id = e.id) AS projection_ids`;

function rowToAnnotation(row: AnnotationRow): TemporalAnnotation {
  // Sorted for a deterministic read order: the link sets are unordered and
  // `json_group_array` follows whatever scan order the planner picks.
  const parseIds = (raw: string | null): string[] => {
    if (!raw) return [];
    try {
      return (JSON.parse(raw) as string[]).sort();
    } catch {
      return [];
    }
  };
  return {
    id: row.id,
    intervalStartMs: row.interval_start_ms,
    intervalEndMs: row.interval_end_ms,
    precision: row.precision as TemporalPrecision,
    canonical: row.canonical,
    sentence: row.sentence,
    kind: row.kind,
    createdByRun: row.created_by_run,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    documentIds: parseIds(row.document_ids),
    loopIds: parseIds(row.loop_ids),
    personIds: parseIds(row.person_ids),
    projectionIds: parseIds(row.projection_ids),
  };
}

/**
 * Insert the evidence atoms for one annotation (inside the caller's txn),
 * numbering the kept atoms 0..n-1. Atoms citing a document not present in
 * `documents` are silently dropped — the doc-link convention.
 */
function insertTemporalAnnotationEvidenceRows(
  db: Db,
  annotationId: string,
  evidence: readonly TemporalAnnotationEvidenceInput[],
): void {
  if (evidence.length === 0) return;
  const docExists = db.prepare("SELECT 1 FROM documents WHERE id = ?");
  const ins = db.prepare(
    "INSERT INTO temporal_annotation_evidence (annotation_id, position, document_id, quote) VALUES (?, ?, ?, ?)",
  );
  let position = 0;
  for (const atom of evidence) {
    if (!docExists.get(atom.docId)) continue;
    ins.run(annotationId, position, atom.docId, atom.quote);
    position += 1;
  }
}

/**
 * Insert one temporal annotation plus its document / loop / person links and
 * evidence atoms in a single
 * writer transaction. Runs on the single-writer handle. Document and loop ids
 * are linked only when they exist (dangling refs silently dropped, like the
 * annotation store); person ids are written as-is (no FK — people merge).
 */
export function insertTemporalAnnotation(
  db: Db,
  input: CreateTemporalAnnotationInput,
  now: number,
): TemporalAnnotation {
  const insEntry = db.prepare(
    `INSERT INTO temporal_annotations
       (id, interval_start_ms, interval_end_ms, precision, canonical, sentence, kind, created_by_run, created_at, updated_at, invalidated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const docExists = db.prepare("SELECT 1 FROM documents WHERE id = ?");
  const insLink = db.prepare(
    "INSERT OR IGNORE INTO temporal_annotation_documents (annotation_id, document_id) VALUES (?, ?)",
  );
  const loopExists = db.prepare("SELECT 1 FROM open_loops WHERE id = ?");
  const insLoop = db.prepare(
    "INSERT OR IGNORE INTO temporal_annotation_loops (annotation_id, loop_id) VALUES (?, ?)",
  );
  const insPerson = db.prepare(
    "INSERT OR IGNORE INTO temporal_annotation_people (annotation_id, person_id) VALUES (?, ?)",
  );
  const insProjection = db.prepare(
    "INSERT OR IGNORE INTO temporal_annotation_projections (annotation_id, projection_id) VALUES (?, ?)",
  );
  const linked: string[] = [];
  const linkedLoops: string[] = [];
  const linkedPeople: string[] = [];
  const linkedProjections: string[] = [];
  const run = db.transaction(() => {
    insEntry.run(
      input.id,
      input.intervalStartMs,
      input.intervalEndMs,
      input.precision,
      input.canonical,
      input.sentence,
      input.kind ?? null,
      input.createdByRun,
      now,
      now,
    );
    for (const docId of input.documentIds) {
      if (docExists.get(docId)) {
        insLink.run(input.id, docId);
        linked.push(docId);
      }
    }
    for (const loopId of input.loopIds ?? []) {
      if (loopExists.get(loopId)) {
        insLoop.run(input.id, loopId);
        linkedLoops.push(loopId);
      }
    }
    for (const personId of input.personIds ?? []) {
      insPerson.run(input.id, personId);
      linkedPeople.push(personId);
    }
    for (const projectionId of input.projectionIds ?? []) {
      if (!projectionId.startsWith("tp_")) continue;
      insProjection.run(input.id, projectionId);
      linkedProjections.push(projectionId);
    }
    insertTemporalAnnotationEvidenceRows(db, input.id, input.evidence ?? []);
  });
  run();
  return {
    id: input.id,
    intervalStartMs: input.intervalStartMs,
    intervalEndMs: input.intervalEndMs,
    precision: input.precision,
    canonical: input.canonical,
    sentence: input.sentence,
    kind: input.kind ?? null,
    createdByRun: input.createdByRun,
    createdAt: now,
    updatedAt: now,
    documentIds: linked,
    loopIds: linkedLoops,
    personIds: linkedPeople,
    projectionIds: linkedProjections,
    revision: 1,
  };
}

export interface UpdateTemporalAnnotationPatch {
  intervalStartMs?: number;
  intervalEndMs?: number;
  precision?: TemporalPrecision;
  canonical?: string | null;
  sentence?: string;
  kind?: string | null;
  /**
   * When provided, REPLACES the annotation's document links wholesale — except
   * that the docs of the annotation's LIVE evidence atoms are re-unioned
   * afterward: every live atom's doc stays linked, so re-pointing the links
   * can never detach the entry from the invalidator's doc-keyed reads.
   */
  documentIds?: readonly string[];
  /**
   * When provided, REPLACES the annotation's evidence atoms wholesale — the
   * entry is being re-grounded, so stale atoms don't linger. Each atom's
   * docId is additionally UNIONED into the document links (never a
   * replacement — supplying evidence must not silently drop standing links).
   */
  evidence?: readonly TemporalAnnotationEvidenceInput[];
  /** When provided, REPLACES the annotation's open-loop backlinks wholesale. */
  loopIds?: readonly string[];
  /** When provided, REPLACES the annotation's person backlinks wholesale. */
  personIds?: readonly string[];
  /** When provided, REPLACES the interpreted projection links wholesale. */
  projectionIds?: readonly string[];
}

/**
 * Edit a live annotation through `temporal_annotation_update`. Only supplied
 * fields change; a supplied `documentIds` replaces the link set; a supplied
 * `evidence` replaces the atom set. Either way the docs of the LIVE evidence
 * atoms are re-unioned into the links afterward, keeping every live atom's
 * doc linked. Returns true iff a live annotation with `id` existed. Runs on
 * the single writer.
 */
export function updateTemporalAnnotation(
  db: Db,
  id: string,
  patch: UpdateTemporalAnnotationPatch,
  now: number,
): boolean {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.intervalStartMs !== undefined) push("interval_start_ms", patch.intervalStartMs);
  if (patch.intervalEndMs !== undefined) push("interval_end_ms", patch.intervalEndMs);
  if (patch.precision !== undefined) push("precision", patch.precision);
  if (patch.canonical !== undefined) push("canonical", patch.canonical);
  if (patch.sentence !== undefined) push("sentence", patch.sentence);
  if (patch.kind !== undefined) push("kind", patch.kind);
  push("updated_at", now);
  sets.push("revision = revision + 1");

  let existed = false;
  const run = db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE temporal_annotations SET ${sets.join(", ")} WHERE id = ? AND invalidated_at IS NULL`,
      )
      .run(...vals, id);
    existed = info.changes > 0;
    if (existed && patch.documentIds !== undefined) {
      db.prepare("DELETE FROM temporal_annotation_documents WHERE annotation_id = ?").run(id);
      const docExists = db.prepare("SELECT 1 FROM documents WHERE id = ?");
      const insLink = db.prepare(
        "INSERT OR IGNORE INTO temporal_annotation_documents (annotation_id, document_id) VALUES (?, ?)",
      );
      for (const docId of patch.documentIds) {
        if (docExists.get(docId)) insLink.run(id, docId);
      }
    }
    if (existed && patch.evidence !== undefined) {
      // Replace the atom set (re-grounding) — stale atoms don't linger.
      db.prepare("DELETE FROM temporal_annotation_evidence WHERE annotation_id = ?").run(id);
      insertTemporalAnnotationEvidenceRows(db, id, patch.evidence);
    }
    if (existed && (patch.documentIds !== undefined || patch.evidence !== undefined)) {
      // Invariant: every LIVE evidence atom's doc is linked. Runs after both
      // replacements above, so a documentIds re-point never detaches standing
      // atoms and a supplied evidence doc always survives a simultaneous link
      // replace. Atoms whose doc row vanished are skipped (the link table's
      // FK requires a live document).
      db.prepare(
        `INSERT OR IGNORE INTO temporal_annotation_documents (annotation_id, document_id)
         SELECT DISTINCT annotation_id, document_id FROM temporal_annotation_evidence
          WHERE annotation_id = ? AND broken_at IS NULL
            AND document_id IN (SELECT id FROM documents)`,
      ).run(id);
    }
    if (existed && patch.loopIds !== undefined) {
      db.prepare("DELETE FROM temporal_annotation_loops WHERE annotation_id = ?").run(id);
      const loopExists = db.prepare("SELECT 1 FROM open_loops WHERE id = ?");
      const insLoop = db.prepare(
        "INSERT OR IGNORE INTO temporal_annotation_loops (annotation_id, loop_id) VALUES (?, ?)",
      );
      for (const loopId of patch.loopIds) {
        if (loopExists.get(loopId)) insLoop.run(id, loopId);
      }
    }
    if (existed && patch.personIds !== undefined) {
      db.prepare("DELETE FROM temporal_annotation_people WHERE annotation_id = ?").run(id);
      const insPerson = db.prepare(
        "INSERT OR IGNORE INTO temporal_annotation_people (annotation_id, person_id) VALUES (?, ?)",
      );
      for (const personId of patch.personIds) insPerson.run(id, personId);
    }
    if (existed && patch.projectionIds !== undefined) {
      db.prepare("DELETE FROM temporal_annotation_projections WHERE annotation_id = ?").run(id);
      const insProjection = db.prepare(
        "INSERT OR IGNORE INTO temporal_annotation_projections (annotation_id, projection_id) VALUES (?, ?)",
      );
      for (const projectionId of patch.projectionIds) {
        if (projectionId.startsWith("tp_")) insProjection.run(id, projectionId);
      }
    }
  });
  run();
  return existed;
}

/**
 * Soft-remove an annotation through `temporal_annotation_delete`. Sets
 * `invalidated_at` (drops it from queries, keeps the row for audit/rebuild)
 * with `invalidation_cause = 'deleted'` — a deliberate removal is final: it
 * never resurrects on a content change and never surfaces in the re-file
 * read. Returns true iff a live annotation existed.
 */
export function invalidateTemporalAnnotation(db: Db, id: string, now: number): boolean {
  const info = db
    .prepare(
      "UPDATE temporal_annotations SET invalidated_at = ?, invalidation_cause = 'deleted', revision = revision + 1 WHERE id = ? AND invalidated_at IS NULL",
    )
    .run(now, id);
  return info.changes > 0;
}

/**
 * Query live annotations whose interval overlaps `[startMs, endMs]`
 * (inclusive). A point-in-time query passes `startMs == endMs`. Runs on a
 * read-only handle. Ordered by start, capped by `limit`.
 */
export function queryTemporalAnnotationOverlap(
  db: Db,
  startMs: number,
  endMs: number,
  limit = 50,
): TemporalAnnotation[] {
  const rows = db
    .prepare(
      `SELECT ${ANNOTATION_COLUMNS}
         FROM temporal_annotations e
        WHERE e.invalidated_at IS NULL
          AND e.interval_start_ms <= ?
          AND e.interval_end_ms   >= ?
        ORDER BY e.interval_start_ms
        LIMIT ?`,
    )
    .all(endMs, startMs, limit) as AnnotationRow[];
  return rows.map(rowToAnnotation);
}

/**
 * Result-size clamps shared by every windowed/listed temporal-annotation read (the
 * calendar window route, the admin debug list). One definition so the
 * pair can't drift between the read paths.
 */
export const TEMPORAL_ANNOTATION_READ_DEFAULT_LIMIT = 300;
export const TEMPORAL_ANNOTATION_READ_MAX_LIMIT = 500;

/**
 * The annotation calendar-window read: live annotations overlapping
 * `[startMs, endMs]` (inclusive), optionally filtered to
 * a kind set (the Upcoming rail passes deadline/expiry/reminder). Ordered by
 * interval start with id as a stable tiebreaker. Runs on a read-only handle.
 */
export function queryTemporalAnnotationWindow(
  db: Db,
  opts: {
    startMs: number;
    endMs: number;
    kinds?: readonly string[] | undefined;
    limit?: number | undefined;
  },
): TemporalAnnotation[] {
  const limit = Math.min(
    Math.max(opts.limit ?? TEMPORAL_ANNOTATION_READ_DEFAULT_LIMIT, 1),
    // +1 headroom so the window assembler can detect truncation by
    // over-fetching one row past the client-visible cap.
    TEMPORAL_ANNOTATION_READ_MAX_LIMIT + 1,
  );
  const kinds = opts.kinds?.filter((k) => k.length > 0) ?? [];
  const kindFilter = kinds.length > 0 ? `AND e.kind IN (${kinds.map(() => "?").join(", ")})` : "";
  const rows = db
    .prepare(
      `SELECT ${ANNOTATION_COLUMNS}
         FROM temporal_annotations e
        WHERE e.invalidated_at IS NULL
          AND e.interval_start_ms <= ?
          AND e.interval_end_ms   >= ?
          ${kindFilter}
        ORDER BY e.interval_start_ms ASC, e.id ASC
        LIMIT ?`,
    )
    .all(opts.endMs, opts.startMs, ...kinds, limit) as AnnotationRow[];
  return rows.map(rowToAnnotation);
}

/** Fetch one live annotation by id, or null. Runs on a read-only handle. */
export function getTemporalAnnotationById(db: Db, id: string): TemporalAnnotation | null {
  return getTemporalAnnotationsByIds(db, [id])[0] ?? null;
}

/**
 * Overlap probe for the add-reconcile contract: live entries overlapping
 * `[startMs, endMs]`, EXCLUDING coarse periods (year/month precision, or
 * spans wider than `maxSpanMs`) — a year-scoped fact overlaps everything in
 * its year and would blanket-refuse unrelated adds. Tightest intervals
 * first, so the most plausible same-event restatement leads the candidate
 * list rather than being crowded out by wide neighbours.
 */
export function queryTemporalAnnotationReconcileCandidates(
  db: Db,
  startMs: number,
  endMs: number,
  maxSpanMs: number,
  limit = 8,
): TemporalAnnotation[] {
  const rows = db
    .prepare(
      `SELECT ${ANNOTATION_COLUMNS}
         FROM temporal_annotations e
        WHERE e.invalidated_at IS NULL
          AND e.precision NOT IN ('year', 'month')
          AND (e.interval_end_ms - e.interval_start_ms) <= ?
          AND e.interval_start_ms <= ?
          AND e.interval_end_ms   >= ?
        ORDER BY (e.interval_end_ms - e.interval_start_ms) ASC, e.interval_start_ms ASC
        LIMIT ?`,
    )
    .all(maxSpanMs, endMs, startMs, limit) as AnnotationRow[];
  return rows.map(rowToAnnotation);
}

/** Fetch specific live annotations by id (result order follows the input ids). */
export function getTemporalAnnotationsByIds(db: Db, ids: readonly string[]): TemporalAnnotation[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT ${ANNOTATION_COLUMNS}
         FROM temporal_annotations e
        WHERE e.invalidated_at IS NULL AND e.id IN (${placeholders})`,
    )
    .all(...ids) as AnnotationRow[];
  const byId = new Map(rows.map((r) => [r.id, rowToAnnotation(r)]));
  return ids.flatMap((id) => {
    const e = byId.get(id);
    return e ? [e] : [];
  });
}

/**
 * Reverse backlink read — live annotations linked to open loop `loopId`,
 * soonest interval first (id as the stable tiebreaker). `invalidated_at IS
 * NULL` so a soft-removed annotation never leaks as
 * a live backlink; the join's `loop_id` FK (ON DELETE CASCADE to `open_loops`)
 * drops a deleted loop's rows, so this never returns entries for a vanished
 * loop. Drives the loop→deadline surface. Runs on a read-only handle.
 */
export function listTemporalAnnotationsForLoop(db: Db, loopId: string): TemporalAnnotation[] {
  const rows = db
    .prepare(
      `SELECT ${ANNOTATION_COLUMNS}
         FROM temporal_annotations e
         JOIN temporal_annotation_loops l ON l.annotation_id = e.id
        WHERE l.loop_id = ? AND e.invalidated_at IS NULL
        ORDER BY e.interval_start_ms ASC, e.id ASC`,
    )
    .all(loopId) as AnnotationRow[];
  return rows.map(rowToAnnotation);
}

/**
 * Reverse backlink read — live annotations linked to person `personId`,
 * soonest interval first. `person_id` carries no FK
 * (people merge). Pass a canonical (`resolvePersonId`'d) id: the query expands
 * it to its merge equivalence class, because a *logical* merge (`merged_into`)
 * does not re-key `temporal_annotation_people`, so an annotation backlinked to a
 * now-merged-away id would otherwise vanish from the canonical's lookup.
 * Best-effort (no FK); runs on a read-only handle.
 */
export function listTemporalAnnotationsForPerson(db: Db, personId: string): TemporalAnnotation[] {
  const rows = db
    .prepare(
      `SELECT ${ANNOTATION_COLUMNS}
         FROM temporal_annotations e
         JOIN temporal_annotation_people p ON p.annotation_id = e.id
        WHERE (p.person_id = ? OR p.person_id IN (SELECT id FROM people WHERE merged_into = ?))
          AND e.invalidated_at IS NULL
        GROUP BY e.id
        ORDER BY e.interval_start_ms ASC, e.id ASC`,
    )
    .all(personId, personId) as AnnotationRow[];
  return rows.map(rowToAnnotation);
}

/**
 * List live annotations in chronological order (by interval start), for the debug
 * viewer. `order: "desc"` lists most-future first; `fromMs` optionally clips to
 * entries whose period ends at/after a floor (e.g. "now" for upcoming-only).
 * Paginated. Runs on a read-only handle.
 */
export function listTemporalAnnotations(
  db: Db,
  opts: {
    limit?: number;
    after?: TemporalAnnotationPageCursor;
    order?: "asc" | "desc";
    fromMs?: number;
  } = {},
): TemporalAnnotation[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), TEMPORAL_ANNOTATION_READ_MAX_LIMIT);
  const dir = opts.order === "desc" ? "DESC" : "ASC";
  const clip = opts.fromMs !== undefined ? "AND e.interval_end_ms >= @from" : "";
  const after =
    opts.after === undefined
      ? ""
      : opts.order === "desc"
        ? `AND (
             e.interval_start_ms < @afterStart
             OR (e.interval_start_ms = @afterStart AND e.id < @afterId)
           )`
        : `AND (
             e.interval_start_ms > @afterStart
             OR (e.interval_start_ms = @afterStart AND e.id > @afterId)
           )`;
  const rows = db
    .prepare(
      `SELECT ${ANNOTATION_COLUMNS}
         FROM temporal_annotations e
        WHERE e.invalidated_at IS NULL ${clip} ${after}
        ORDER BY e.interval_start_ms ${dir}, e.id ${dir}
        LIMIT @limit`,
    )
    .all({
      from: opts.fromMs ?? 0,
      limit,
      afterStart: opts.after?.intervalStartMs ?? 0,
      afterId: opts.after?.id ?? "",
    }) as AnnotationRow[];
  return rows.map(rowToAnnotation);
}

/** Total live annotation count + a small kind histogram — for the debug view header. */
export function temporalAnnotationStats(db: Db): {
  total: number;
  upcoming: number;
  byKind: Record<string, number>;
  nowMs: number;
} {
  const nowMs = Date.now();
  const total = countTemporalAnnotations(db);
  const upcoming = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM temporal_annotations WHERE invalidated_at IS NULL AND interval_end_ms >= ?",
      )
      .get(nowMs) as { c: number }
  ).c;
  const byKind: Record<string, number> = {};
  for (const r of db
    .prepare(
      "SELECT COALESCE(kind,'(none)') AS k, COUNT(*) AS c FROM temporal_annotations WHERE invalidated_at IS NULL GROUP BY k",
    )
    .all() as Array<{ k: string; c: number }>) {
    byKind[r.k] = r.c;
  }
  return { total, upcoming, byKind, nowMs };
}

/**
 * True when a change to `docId` could have annotation work to do — the
 * invalidator's cheap read guard. An annotation qualifies when it names the
 * doc via a link row OR via an evidence atom (atoms can outlive their link
 * row — a documents-FK cascade drops links, never atoms), and when it is
 * live OR a churn casualty (`invalidation_cause = 'content_change'`) whose
 * atoms a change-back could heal into a resurrection. Deliberately deleted
 * annotations never keep the guard warm. Both probes drive off the
 * doc-keyed indexes.
 */
export function hasLiveTemporalAnnotationsForDoc(db: Db, docId: string): boolean {
  const link = db
    .prepare<[string], { one: number }>(
      `SELECT 1 AS one FROM temporal_annotation_documents d
        JOIN temporal_annotations e ON e.id = d.annotation_id
       WHERE d.document_id = ?
         AND (e.invalidated_at IS NULL OR e.invalidation_cause = 'content_change') LIMIT 1`,
    )
    .get(docId);
  if (link !== undefined) return true;
  const atom = db
    .prepare<[string], { one: number }>(
      `SELECT 1 AS one FROM temporal_annotation_evidence v
        JOIN temporal_annotations e ON e.id = v.annotation_id
       WHERE v.document_id = ?
         AND (e.invalidated_at IS NULL OR e.invalidation_cause = 'content_change') LIMIT 1`,
    )
    .get(docId);
  return atom !== undefined;
}

/**
 * Live temporal annotations citing `docId`, newest-period-first — the inline
 * "what dated facts is this document a source for" backlink surfaced on agent
 * search / fetch. Bounded (a document rarely grounds many entries). Reuses the
 * shared `ANNOTATION_COLUMNS` correlated hydration; the
 * `temporal_annotation_documents` PK guarantees one row per annotation. Runs
 * on a read-only handle.
 */
export function listTemporalAnnotationsForDoc(
  db: Db,
  docId: string,
  limit = 20,
): TemporalAnnotation[] {
  const rows = db
    .prepare(
      `SELECT ${ANNOTATION_COLUMNS}
         FROM temporal_annotations e
         JOIN temporal_annotation_documents d ON d.annotation_id = e.id
        WHERE d.document_id = ? AND e.invalidated_at IS NULL
        ORDER BY e.interval_start_ms DESC, e.id DESC
        LIMIT ?`,
    )
    .all(docId, Math.max(1, limit)) as AnnotationRow[];
  return rows.map(rowToAnnotation);
}

/**
 * Every evidence atom of one annotation, in position order — broken atoms
 * included (`brokenAt` set), so a caller can audit the full grounding
 * history as well as the live set. Runs on a read-only handle.
 */
export function listTemporalAnnotationEvidence(
  db: Db,
  annotationId: string,
): TemporalAnnotationEvidenceRow[] {
  return db
    .prepare<
      [string],
      {
        annotation_id: string;
        position: number;
        document_id: string;
        quote: string;
        broken_at: number | null;
      }
    >(
      `SELECT annotation_id, position, document_id, quote, broken_at
         FROM temporal_annotation_evidence
        WHERE annotation_id = ? ORDER BY position ASC`,
    )
    .all(annotationId)
    .map((r) => ({
      annotationId: r.annotation_id,
      position: r.position,
      documentId: r.document_id,
      quote: r.quote,
      brokenAt: r.broken_at,
    }));
}

/** A recently-invalidated annotation citing a document — the re-file read's shape. */
export interface InvalidatedTemporalAnnotation {
  id: string;
  sentence: string;
  canonical: string | null;
  kind: string | null;
  intervalStartMs: number;
  intervalEndMs: number;
  invalidatedAt: number;
}

/**
 * Churn-invalidated annotations (`invalidation_cause = 'content_change'`)
 * citing `docId` that still await a re-file decision, most recently
 * invalidated first (id as the stable tiebreaker), capped by `limit` — the
 * data-run prompt's "these entries died when this document changed; re-file
 * whatever the current content still supports" read.
 *
 * The predicate is STATE, not a time window: the invalidation is stamped at
 * document-event time while the run it wakes is enqueued at the waker's next
 * drain tick, so any lower bound derived from run timestamps starts after
 * the very event it is meant to catch. An entry is pending until its
 * presentation is decided: never presented (`refile_presented_run` NULL), or
 * presented to a run still pending or failed — those re-present. A stamp
 * whose run row no longer EXISTS counts as decided: unsettled rows are never
 * pruned, so a dangling stamp can only mean the retention sweep removed a
 * settled presenting run, and re-opening ancient adjudicated casualties on
 * every later edit would invite re-filing long-stale facts. A fresh
 * invalidation clears the marker for a new decision. The doc match unions
 * link rows and evidence atoms — the same candidacy the invalidator uses, so
 * a casualty tied to the doc only through an atom is still presented at that
 * doc's runs. Deliberately deleted entries (`invalidation_cause =
 * 'deleted'`) never surface here: re-filing a curated-away entry would undo
 * the steward's delete. Runs on a read-only handle.
 */
export function listTemporalAnnotationsAwaitingRefile(
  db: Db,
  docId: string,
  limit: number,
): InvalidatedTemporalAnnotation[] {
  return db
    .prepare<
      [string, string, number],
      {
        id: string;
        sentence: string;
        canonical: string | null;
        kind: string | null;
        interval_start_ms: number;
        interval_end_ms: number;
        invalidated_at: number;
      }
    >(
      `SELECT e.id, e.sentence, e.canonical, e.kind, e.interval_start_ms, e.interval_end_ms,
              e.invalidated_at
         FROM temporal_annotations e
        WHERE e.invalidated_at IS NOT NULL
          AND e.invalidation_cause = 'content_change'
          AND e.id IN (
            SELECT annotation_id FROM temporal_annotation_documents WHERE document_id = ?
            UNION
            SELECT annotation_id FROM temporal_annotation_evidence WHERE document_id = ?
          )
          AND (e.refile_presented_run IS NULL
               OR EXISTS (SELECT 1 FROM cognition_runs r
                           WHERE r.id = e.refile_presented_run AND r.status <> 'completed'))
        ORDER BY e.invalidated_at DESC, e.id DESC
        LIMIT ?`,
    )
    .all(docId, docId, Math.max(1, limit))
    .map((r) => ({
      id: r.id,
      sentence: r.sentence,
      canonical: r.canonical,
      kind: r.kind,
      intervalStartMs: r.interval_start_ms,
      intervalEndMs: r.interval_end_ms,
      invalidatedAt: r.invalidated_at,
    }));
}

/**
 * Stamp `refile_presented_run` on `ids` — called by the runtime after a data
 * run's prompt listed them for re-filing, with that run's id. The stamp is
 * what retires an entry from {@link listTemporalAnnotationsAwaitingRefile}
 * once the presented run completes; failed or abandoned runs leave the entry
 * pending because the exclusion checks the run's status, not the stamp
 * alone. Idempotent per (id, runId).
 */
export function markTemporalAnnotationsRefilePresented(
  db: Db,
  ids: readonly string[],
  runId: string,
): void {
  if (ids.length === 0) return;
  const stamp = db.prepare<[string, string]>(
    "UPDATE temporal_annotations SET refile_presented_run = ? WHERE id = ?",
  );
  const txn = db.transaction((all: readonly string[]) => {
    for (const id of all) stamp.run(runId, id);
  });
  txn(ids);
}

/**
 * Live annotations citing `docId` (by link row or evidence atom) that carry
 * no unbroken grounding atom — legacy entries written before evidence became
 * mandatory, plus any whose atoms all broke without tripping invalidation.
 * The content-change invalidator deliberately keeps these (a linked doc is
 * not necessarily the entry's basis), so any data run the doc's changes wake
 * is shown them for re-check: re-ground with evidence, correct, or delete.
 * (Doc classes the waker never wakes get no re-check pass — for them, kept-
 * but-unverifiable is still strictly better than the guaranteed loss of a
 * blanket invalidation.) Ordered by interval start (id tiebreaker), capped
 * by `limit`.
 */
export function listUngroundedTemporalAnnotationsForDoc(
  db: Db,
  docId: string,
  limit: number,
): InvalidatedTemporalAnnotation[] {
  return db
    .prepare<
      [string, string, number],
      {
        id: string;
        sentence: string;
        canonical: string | null;
        kind: string | null;
        interval_start_ms: number;
        interval_end_ms: number;
      }
    >(
      `SELECT e.id, e.sentence, e.canonical, e.kind, e.interval_start_ms, e.interval_end_ms
         FROM temporal_annotations e
        WHERE e.invalidated_at IS NULL
          AND e.id IN (
            SELECT annotation_id FROM temporal_annotation_documents WHERE document_id = ?
            UNION
            SELECT annotation_id FROM temporal_annotation_evidence WHERE document_id = ?
          )
          AND NOT EXISTS (SELECT 1 FROM temporal_annotation_evidence v
                           WHERE v.annotation_id = e.id AND v.broken_at IS NULL)
        ORDER BY e.interval_start_ms ASC, e.id ASC
        LIMIT ?`,
    )
    .all(docId, docId, Math.max(1, limit))
    .map((r) => ({
      id: r.id,
      sentence: r.sentence,
      canonical: r.canonical,
      kind: r.kind,
      intervalStartMs: r.interval_start_ms,
      intervalEndMs: r.interval_end_ms,
      invalidatedAt: 0,
    }));
}

/** What a content-change invalidation did — see {@link invalidateTemporalAnnotationsForDoc}. */
export interface TemporalAnnotationInvalidationResult {
  /** Annotations soft-invalidated (every grounding atom broken, or ungrounded legacy). */
  invalidated: number;
  /** Live candidate annotations that survived the change. */
  kept: number;
  /** Evidence atoms stamped broken by this change. */
  atomsBroken: number;
  /** Previously-broken atoms whose quote reappeared in the changed document. */
  atomsHealed: number;
  /** Churn-invalidated annotations revived because an atom healed. */
  resurrected: number;
}

/**
 * Content-change invalidation for annotations citing `docId` — surgical, per
 * evidence ATOM (the doc-annotation store's pattern). Candidates are the
 * annotations naming the doc via a link row OR via an evidence atom (atoms
 * can outlive their link row), and comprise both live entries and churn
 * casualties (`invalidation_cause = 'content_change'`) — never deliberately
 * deleted ones. The changed document's new content decides each atom
 * citing `docId`: an unbroken atom whose quote no longer appears is stamped
 * broken; a broken atom whose quote appears again HEALS (`broken_at`
 * cleared). An atom citing a DIFFERENT doc stays unbroken only while that
 * document's row still exists — a vanished evidence doc breaks the atom
 * (a deletion path no cascade saw must not ground anything forever). Then
 * per annotation:
 *
 *  - live, with at least one unbroken atom remaining (on any doc) → survives;
 *  - live, atoms exist but all are broken → soft-invalidated with cause
 *    'content_change' (kept for audit; the agent re-files current facts when
 *    the same upsert wakes its data run);
 *  - live, NO atoms at all (evidence never supplied) → KEPT. A linked
 *    document is not necessarily the entry's basis — it may be a merely
 *    supporting attachment — and without a quote the change carries no
 *    evidence the entry is wrong, so destroying it guarantees loss for at
 *    most a staleness risk. Any data run the doc's changes wake is shown
 *    these ungrounded linked entries for re-check and re-grounding instead;
 *  - churn-invalidated, with ≥1 unbroken atom after healing → RESURRECTED
 *    (`invalidated_at`/cause cleared, revision bumped) — the delete-restore
 *    churn case round-trips. 'deleted' entries are not candidates and never
 *    resurrect.
 *
 * A vanished `docId` row degrades like a change that dropped every quote:
 * atoms citing it break, and evidence-less entries blanket-invalidate —
 * with no content left to check against, keeping an entry grounded in
 * nothing would let a deletion path no cascade saw ground it forever.
 *
 * `now` is the content-change event time; only entries last written AT or
 * before that moment (`updated_at <= now`) are candidates. Temporal
 * annotations are mutable, so the guard keys on `updated_at`: an annotation
 * the agent re-times against the NEW content — which may land on the writer
 * before this queued invalidate does — is not wrongly touched. Idempotent.
 */
export function invalidateTemporalAnnotationsForDoc(
  db: Db,
  docId: string,
  now: number,
): TemporalAnnotationInvalidationResult {
  const txn = db.transaction((): TemporalAnnotationInvalidationResult => {
    const candidates = db
      .prepare<[number, string, string], { id: string; invalidated_at: number | null }>(
        `SELECT id, invalidated_at FROM temporal_annotations
          WHERE updated_at <= ?
            AND (invalidated_at IS NULL OR invalidation_cause = 'content_change')
            AND id IN (
              SELECT annotation_id FROM temporal_annotation_documents WHERE document_id = ?
              UNION
              SELECT annotation_id FROM temporal_annotation_evidence WHERE document_id = ?
            )`,
      )
      .all(now, docId, docId);
    if (candidates.length === 0)
      return { invalidated: 0, kept: 0, atomsBroken: 0, atomsHealed: 0, resurrected: 0 };

    const doc = db
      .prepare<
        [string],
        { content: string | null; content_hash: string; source_id: string; metadata: string | null }
      >("SELECT content, content_hash, source_id, metadata FROM documents WHERE id = ?")
      .get(docId);
    const content = doc?.content ?? "";
    // Doc gone → no quote survives; otherwise the shared content-hash-keyed
    // LRU normalizes the (possibly large) body once across all atoms.
    const quoteSurvives = (quote: string): boolean =>
      doc !== undefined && containsNormalizedForContent(doc.content_hash, content, quote);

    // Cached existence probe for OTHER evidence docs (the mirror's
    // evidenceDocExists): an atom whose own document vanished is broken.
    const existsStmt = db.prepare<[string], { one: number }>(
      "SELECT 1 AS one FROM documents WHERE id = ?",
    );
    const docAlive = new Map<string, boolean>();
    const evidenceDocExists = (id: string): boolean => {
      let alive = docAlive.get(id);
      if (alive === undefined) {
        alive = existsStmt.get(id) !== undefined;
        docAlive.set(id, alive);
      }
      return alive;
    };

    const listAtoms = db.prepare<
      [string],
      { position: number; document_id: string; quote: string; broken_at: number | null }
    >(
      `SELECT position, document_id, quote, broken_at FROM temporal_annotation_evidence
        WHERE annotation_id = ? ORDER BY position ASC`,
    );
    const stampBroken = db.prepare<[number, string, number]>(
      "UPDATE temporal_annotation_evidence SET broken_at = ? WHERE annotation_id = ? AND position = ?",
    );
    const clearBroken = db.prepare<[string, number]>(
      "UPDATE temporal_annotation_evidence SET broken_at = NULL WHERE annotation_id = ? AND position = ?",
    );
    // Both stamps clear `refile_presented_run`: a fresh invalidation is a new
    // re-file obligation, and a resurrected entry that later invalidates again
    // must not be silently skipped because an older presentation completed.
    const stampInvalidated = db.prepare<[number, string]>(
      "UPDATE temporal_annotations SET invalidated_at = ?, invalidation_cause = 'content_change', revision = revision + 1, refile_presented_run = NULL WHERE id = ?",
    );
    const stampResurrected = db.prepare<[string]>(
      "UPDATE temporal_annotations SET invalidated_at = NULL, invalidation_cause = NULL, revision = revision + 1, refile_presented_run = NULL WHERE id = ?",
    );

    let invalidated = 0;
    let kept = 0;
    let atomsBroken = 0;
    let atomsHealed = 0;
    let resurrected = 0;
    for (const c of candidates) {
      const wasInvalidated = c.invalidated_at !== null;
      const atoms = listAtoms.all(c.id);
      if (atoms.length === 0) {
        // An atom-less churn casualty has nothing to heal — it stays down.
        if (wasInvalidated) continue;
        if (doc !== undefined) {
          // Content changed but the entry carries no quote to judge it by:
          // the linked doc may be merely supporting, so the entry is kept
          // and any data run this doc wakes re-checks it (see the function
          // comment).
          kept += 1;
        } else {
          // The doc row itself is gone — nothing left to re-check against.
          stampInvalidated.run(now, c.id);
          invalidated += 1;
        }
        continue;
      }
      let unbrokenRemaining = 0;
      for (const atom of atoms) {
        if (atom.document_id === docId) {
          const survives = quoteSurvives(atom.quote);
          if (atom.broken_at === null) {
            if (!survives) {
              stampBroken.run(now, c.id, atom.position);
              atomsBroken += 1;
              continue;
            }
          } else {
            if (!survives) continue;
            clearBroken.run(c.id, atom.position);
            atomsHealed += 1;
          }
          unbrokenRemaining += 1;
          continue;
        }
        // Only atoms citing the changed doc are re-judged against content;
        // an already-broken atom on another doc stays broken.
        if (atom.broken_at !== null) continue;
        if (!evidenceDocExists(atom.document_id)) {
          stampBroken.run(now, c.id, atom.position);
          atomsBroken += 1;
          continue;
        }
        unbrokenRemaining += 1;
      }
      if (wasInvalidated) {
        if (unbrokenRemaining > 0) {
          stampResurrected.run(c.id);
          resurrected += 1;
        }
        continue;
      }
      if (unbrokenRemaining === 0) {
        stampInvalidated.run(now, c.id);
        invalidated += 1;
      } else {
        kept += 1;
      }
    }
    return { invalidated, kept, atomsBroken, atomsHealed, resurrected };
  });
  return txn();
}

/**
 * Hard-purge every annotation that cites any of `deletedDocIds` — the privacy
 * cascade a document delete triggers (an annotation's sentence may embed
 * content derived from the deleted document). Annotations with no link to a deleted doc
 * (including agent-added doc-less entries) are untouched. Chunked under the
 * SQLite bind-variable cap. Returns the purged entry ids.
 */
export function cascadeTemporalAnnotationPrivacyDelete(
  db: Db,
  deletedDocIds: readonly string[],
): string[] {
  if (deletedDocIds.length === 0) return [];
  const CHUNK = 400;
  const purged: string[] = [];
  const run = db.transaction((ids: readonly string[]) => {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const entryIds = db
        .prepare(
          `SELECT DISTINCT annotation_id
             FROM temporal_annotation_documents
            WHERE document_id IN (${placeholders})`,
        )
        .all(...slice) as Array<{ annotation_id: string }>;
      for (let j = 0; j < entryIds.length; j += CHUNK) {
        const eslice = entryIds.slice(j, j + CHUNK).map((r) => r.annotation_id);
        if (eslice.length === 0) continue;
        const eph = eslice.map(() => "?").join(",");
        // ON DELETE CASCADE drops the link + evidence rows.
        db.prepare(`DELETE FROM temporal_annotations WHERE id IN (${eph})`).run(...eslice);
        purged.push(...eslice);
      }
      // Defensive sweep: an evidence atom citing a deleted doc embeds its
      // content verbatim, so it must not outlive the doc even when its
      // annotation survives (no link row to key the purge above) or when the
      // FK pragma is off on a raw handle.
      db.prepare(
        `DELETE FROM temporal_annotation_evidence WHERE document_id IN (${placeholders})`,
      ).run(...slice);
    }
  });
  run(deletedDocIds);
  return purged;
}

/** Cheap existence check — avoids a writer hop on delete when the index is empty. */
export function hasAnyTemporalAnnotations(db: Db): boolean {
  return db.prepare("SELECT 1 FROM temporal_annotations LIMIT 1").get() !== undefined;
}

/** Count live annotations — used by tests / observability. */
export function countTemporalAnnotations(db: Db): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM temporal_annotations WHERE invalidated_at IS NULL")
      .get() as { c: number }
  ).c;
}
