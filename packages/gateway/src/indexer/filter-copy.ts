// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The copy of what source filters read, kept in the search index database.
 *
 * Search runs against the index database, which cannot read a record's
 * metadata in the corpus. So that a filtered search applies the same check as
 * every other read, the index keeps, per document, only what the check reads:
 * the source, the stream, the source version, the record an attachment is
 * decided through, and the details the source declares as filterable (the
 * declared fields and the people). It also keeps the current version of each
 * published list. `filter-sql.ts` compiles the check for these tables from
 * the same code as for the corpus (`INDEX_FILTER_TABLES`).
 *
 * **The copy can lag; it cannot leak.** A row is written when its document is
 * indexed and again when the document's version rises without any other
 * change (`document_filter_index_queue`). A row written under another
 * declaration than the source's current one, a document with no row and an
 * attachment whose parent has no row are all "unknown" to the check and so
 * hidden. A list that is older than the corpus's can make the index offer a
 * candidate the corpus would refuse; the caller therefore re-checks the final
 * result ids against the corpus (`filterReadableDocumentIds` in
 * `access/filter-decision.ts`) and drops what fails. Nothing else fences the
 * two databases.
 *
 * Every function takes the handles it reads and writes, so each side can run
 * where its database is owned: the reads of the corpus on a reader, the
 * writes of the index on the index writer, the queue deletion on the corpus
 * writer.
 */

import { sourceTypeOf } from "@omnesis/types";
import {
  filterFieldsFor,
  type FilterField,
  type SourceFilterFields,
} from "../access/filter-fields.js";
import { filterDeclarationDigest } from "../access/filter-sql.js";
import type { Db } from "../data/types.js";

export function createFilterCopyTables(indexDb: Db): void {
  indexDb.exec(`
    CREATE TABLE IF NOT EXISTS index_filter_documents (
      document_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      stream_id TEXT NOT NULL DEFAULT '',
      source_version INTEGER NOT NULL,
      -- '' when the document is decided on its own details; otherwise the id
      -- of the record it was attached to, or '!' when that record is missing.
      subject_document_id TEXT NOT NULL DEFAULT '',
      -- Digest of the declaration the details were cut by.
      declaration TEXT NOT NULL,
      -- JSON in the shape of the record's metadata, holding the declared
      -- filter fields and the people only.
      details TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_index_filter_documents_source
      ON index_filter_documents(source_id, document_id);
    -- Which declaration every row of a source is known to be written under,
    -- and how far a rewrite of the source's rows has got.
    CREATE TABLE IF NOT EXISTS index_filter_sources (
      source_id TEXT PRIMARY KEY,
      declaration TEXT NOT NULL,
      pending_declaration TEXT,
      pending_after TEXT
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS index_filter_lists (
      source_id TEXT NOT NULL,
      field TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL,
      digest TEXT NOT NULL,
      PRIMARY KEY (source_id, field, device_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS index_filter_items (
      source_id TEXT NOT NULL,
      field TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      parent_id TEXT,
      label TEXT NOT NULL,
      members_incomplete INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_id, field, device_id, generation, item_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_index_filter_items_parent
      ON index_filter_items(source_id, field, device_id, generation, parent_id, item_id);
    CREATE TABLE IF NOT EXISTS index_filter_item_members (
      source_id TEXT NOT NULL,
      field TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      PRIMARY KEY (source_id, field, device_id, generation, item_id, identifier_type, identifier_value)
    ) WITHOUT ROWID;
  `);
}

/** Tables of the index database this module owns; all are rebuilt from the corpus. */
export const FILTER_COPY_TABLES = [
  "index_filter_documents",
  "index_filter_sources",
  "index_filter_lists",
  "index_filter_items",
  "index_filter_item_members",
] as const;

/** What a missing parent is recorded as; no document has this id. */
export const FILTER_COPY_MISSING_SUBJECT = "!";
/** What unreadable metadata is recorded as: text that is not JSON, so the check reads it as unknown. */
const UNREADABLE_DETAILS = "unreadable";

/** One row of `index_filter_documents`. */
export interface FilterCopyRow {
  documentId: string;
  sourceId: string;
  streamId: string;
  sourceVersion: number;
  subjectDocumentId: string;
  declaration: string;
  details: string;
}

/** What to write for a batch of documents: rows to store, and ids that must have none. */
export interface FilterCopyBatch {
  rows: FilterCopyRow[];
  /** Documents that are gone, or whose source declares nothing a filter reads. */
  absent: string[];
}

type ReadyField = Extract<FilterField, { state: "ready" }>;

interface Declaration {
  digest: string;
  paths: string[][];
  people: boolean;
  /** Whether the source declares anything a filter reads. */
  any: boolean;
}

function declarationOf(fields: SourceFilterFields): Declaration {
  const ready =
    fields.state === "declared"
      ? fields.fields.filter((field): field is ReadyField => field.state === "ready")
      : [];
  const people = fields.state === "declared" && fields.person?.state === "ready";
  return {
    digest: filterDeclarationDigest(fields),
    paths: ready.map((field) => field.path.split(".")),
    people,
    any: ready.length > 0 || people,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields of a mention the person check reads; a name is not one of them. */
function mentionDetails(mention: unknown): unknown {
  if (!isRecord(mention)) return mention;
  const kept: Record<string, unknown> = {};
  for (const key of ["role", "identifiers", "emails", "phones", "lids", "isSelf"]) {
    if (Object.prototype.hasOwnProperty.call(mention, key)) kept[key] = mention[key];
  }
  return kept;
}

/** The declared details of a record's metadata, in the metadata's own shape. */
function cutDetails(metadata: Record<string, unknown>, declaration: Declaration): string {
  const details: Record<string, unknown> = {};
  if (declaration.people && Array.isArray(metadata.people)) {
    details.people = metadata.people.map(mentionDetails);
  }
  for (const path of declaration.paths) {
    let from: unknown = metadata;
    for (const segment of path) {
      from =
        isRecord(from) && Object.prototype.hasOwnProperty.call(from, segment)
          ? from[segment]
          : undefined;
      if (from === undefined) break;
    }
    if (from === undefined) continue;
    let into = details;
    for (const segment of path.slice(0, -1)) {
      const next = into[segment];
      if (isRecord(next)) into = next;
      else {
        const created: Record<string, unknown> = {};
        into[segment] = created;
        into = created;
      }
    }
    into[path[path.length - 1]!] = from;
  }
  return JSON.stringify(details);
}

interface DocumentRow {
  id: string;
  provider_id: string;
  source_id: string;
  stream_id: string;
  external_id: string;
  source_version: number;
  metadata: string;
}

/**
 * Build the copy rows of a batch of documents from the corpus. Read-only on
 * the corpus; run it on a reader.
 *
 * `declarations` carries the per-source-type declaration across batches of
 * one pass, so the profile is read once per type.
 */
export function buildFilterCopyBatch(
  corpusDb: Db,
  documentIds: readonly string[],
  declarations: Map<string, Declaration> = new Map(),
): FilterCopyBatch {
  const batch: FilterCopyBatch = { rows: [], absent: [] };
  if (documentIds.length === 0) return batch;
  const found = new Map(
    corpusDb
      .prepare<[string], DocumentRow>(
        `SELECT id, provider_id, source_id, stream_id, external_id, source_version, metadata
           FROM documents WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(documentIds))
      .map((row) => [row.id, row]),
  );
  const parent = corpusDb.prepare<[string, string, string, string, string], { id: string }>(
    `SELECT id FROM documents
      WHERE provider_id = ? AND source_id = ? AND external_id = ? AND stream_id = ? AND id <> ?`,
  );
  for (const documentId of documentIds) {
    const row = found.get(documentId);
    if (!row) {
      batch.absent.push(documentId);
      continue;
    }
    const sourceType = sourceTypeOf(row.source_id);
    let declaration = declarations.get(sourceType);
    if (!declaration) {
      declaration = declarationOf(filterFieldsFor(corpusDb, sourceType));
      declarations.set(sourceType, declaration);
    }
    if (!declaration.any) {
      batch.absent.push(documentId);
      continue;
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = undefined;
    }
    let subjectDocumentId = "";
    let details = UNREADABLE_DETAILS;
    if (isRecord(metadata)) {
      const extra = metadata.extra;
      const derived =
        metadata.documentType === "attachment" ||
        (isRecord(extra) && Object.prototype.hasOwnProperty.call(extra, "parentExternalId"));
      if (derived) {
        const parentExternalId = isRecord(extra) ? extra.parentExternalId : undefined;
        subjectDocumentId =
          (typeof parentExternalId === "string"
            ? parent.get(row.provider_id, row.source_id, parentExternalId, row.stream_id, row.id)
                ?.id
            : undefined) ?? FILTER_COPY_MISSING_SUBJECT;
      }
      details = cutDetails(metadata, declaration);
    }
    batch.rows.push({
      documentId: row.id,
      sourceId: row.source_id,
      streamId: row.stream_id,
      sourceVersion: row.source_version,
      subjectDocumentId,
      declaration: declaration.digest,
      details,
    });
  }
  return batch;
}

/** Store a batch in the index database, in one transaction. */
export function writeFilterCopyBatch(indexDb: Db, batch: FilterCopyBatch): void {
  if (batch.rows.length === 0 && batch.absent.length === 0) return;
  const upsert = indexDb.prepare(
    `INSERT INTO index_filter_documents
       (document_id, source_id, stream_id, source_version, subject_document_id, declaration, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       source_id = excluded.source_id, stream_id = excluded.stream_id,
       source_version = excluded.source_version,
       subject_document_id = excluded.subject_document_id,
       declaration = excluded.declaration, details = excluded.details`,
  );
  indexDb.transaction(() => {
    for (const row of batch.rows) {
      upsert.run(
        row.documentId,
        row.sourceId,
        row.streamId,
        row.sourceVersion,
        row.subjectDocumentId,
        row.declaration,
        row.details,
      );
    }
    deleteFilterCopyDocuments(indexDb, batch.absent);
  })();
}

/** Remove the copy rows of documents that left the index. */
export function deleteFilterCopyDocuments(indexDb: Db, documentIds: readonly string[]): void {
  if (documentIds.length === 0) return;
  indexDb
    .prepare(
      "DELETE FROM index_filter_documents WHERE document_id IN (SELECT value FROM json_each(?))",
    )
    .run(JSON.stringify(documentIds));
}

/** Rows one call of {@link deleteFilterCopySource} removes. */
export const FILTER_COPY_DELETE_BATCH = 2000;

/**
 * Remove everything the copy holds for a source, a bounded number of document
 * rows per call. Returns true when nothing is left.
 */
export function deleteFilterCopySource(indexDb: Db, sourceId: string): boolean {
  return indexDb.transaction((): boolean => {
    const removed = indexDb
      .prepare(
        `DELETE FROM index_filter_documents WHERE document_id IN (
           SELECT document_id FROM index_filter_documents INDEXED BY idx_index_filter_documents_source
            WHERE source_id = ? LIMIT ${FILTER_COPY_DELETE_BATCH})`,
      )
      .run(sourceId).changes;
    if (removed === FILTER_COPY_DELETE_BATCH) return false;
    for (const table of [
      "index_filter_sources",
      "index_filter_lists",
      "index_filter_items",
      "index_filter_item_members",
    ]) {
      indexDb.prepare(`DELETE FROM ${table} WHERE source_id = ?`).run(sourceId);
    }
    return true;
  })();
}

// ── Version-only changes ────────────────────────────────────────────────────

/** The next documents whose version rose with nothing else changed, oldest id first. */
export function readFilterIndexQueue(corpusDb: Db, limit: number): string[] {
  return corpusDb
    .prepare<[], { document_id: string }>(
      `SELECT document_id FROM document_filter_index_queue ORDER BY document_id LIMIT ${Math.max(1, Math.floor(limit))}`,
    )
    .all()
    .map((row) => row.document_id);
}

/** Forget queue entries whose rows have been written. A corpus write; keep `documentIds` to one batch. */
export function completeFilterIndexQueue(corpusDb: Db, documentIds: readonly string[]): void {
  if (documentIds.length === 0) return;
  corpusDb
    .prepare(
      "DELETE FROM document_filter_index_queue WHERE document_id IN (SELECT value FROM json_each(?))",
    )
    .run(JSON.stringify(documentIds));
}

/**
 * Copy one batch of queued documents and forget them. Returns how many were
 * taken; 0 means the queue is empty.
 *
 * `corpusWrite` runs the queue deletion where corpus writes belong; by
 * default it runs on `corpusDb` itself. An entry is forgotten only after its
 * row is stored, so a crash between the two repeats the copy, which is
 * harmless.
 */
export function drainFilterIndexQueue(deps: {
  corpusDb: Db;
  indexDb: Db;
  limit?: number;
  corpusWrite?: (documentIds: readonly string[]) => void;
}): number {
  const ids = readFilterIndexQueue(deps.corpusDb, deps.limit ?? 500);
  if (ids.length === 0) return 0;
  writeFilterCopyBatch(deps.indexDb, buildFilterCopyBatch(deps.corpusDb, ids));
  (deps.corpusWrite ?? ((done) => completeFilterIndexQueue(deps.corpusDb, done)))(ids);
  return ids.length;
}

// ── A changed declaration ───────────────────────────────────────────────────

/**
 * Rewrite the rows of sources whose declaration is not the one their rows
 * were written under, a bounded number of documents per call.
 *
 * A source new to the copy, a source whose collector started declaring a
 * filterable field, and a source whose declaration changed all look the same
 * here: the digest recorded for the source differs from the current one.
 * Rows are rewritten in document-id order, resuming where the last call
 * stopped, and the source is marked current once the pass reaches its end.
 * Until then the check hides the rows not yet rewritten.
 *
 * Returns how many documents were handled; 0 means every source is current.
 */
export function refreshFilterCopyDeclarations(deps: {
  corpusDb: Db;
  indexDb: Db;
  limit?: number;
}): number {
  const { corpusDb, indexDb } = deps;
  const limit = Math.max(1, Math.floor(deps.limit ?? 500));
  const declarations = new Map<string, Declaration>();
  const recorded = new Map(
    indexDb
      .prepare<
        [],
        {
          source_id: string;
          declaration: string;
          pending_declaration: string | null;
          pending_after: string | null;
        }
      >(
        "SELECT source_id, declaration, pending_declaration, pending_after FROM index_filter_sources",
      )
      .all()
      .map((row) => [row.source_id, row]),
  );
  const sources = corpusDb
    .prepare<[], { source_id: string }>(
      "SELECT DISTINCT source_id FROM source_version_counts ORDER BY source_id",
    )
    .all();
  for (const { source_id: sourceId } of sources) {
    const sourceType = sourceTypeOf(sourceId);
    let declaration = declarations.get(sourceType);
    if (!declaration) {
      declaration = declarationOf(filterFieldsFor(corpusDb, sourceType));
      declarations.set(sourceType, declaration);
    }
    const state = recorded.get(sourceId);
    if (state && state.declaration === declaration.digest && state.pending_declaration === null) {
      continue;
    }
    if (!state && !declaration.any) continue;
    // A pass begun under a declaration that has since changed again starts over.
    const after =
      state?.pending_declaration === declaration.digest ? (state.pending_after ?? "") : "";
    const ids = corpusDb
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM documents WHERE source_id = ? AND id > ? ORDER BY id LIMIT ${limit}`,
      )
      .all(sourceId, after)
      .map((row) => row.id);
    const batch = buildFilterCopyBatch(corpusDb, ids, declarations);
    const finished = ids.length < limit;
    indexDb.transaction(() => {
      writeFilterCopyBatch(indexDb, batch);
      indexDb
        .prepare(
          `INSERT INTO index_filter_sources (source_id, declaration, pending_declaration, pending_after)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_id) DO UPDATE SET declaration = excluded.declaration,
             pending_declaration = excluded.pending_declaration, pending_after = excluded.pending_after`,
        )
        .run(
          sourceId,
          finished ? declaration.digest : (state?.declaration ?? ""),
          finished ? null : declaration.digest,
          finished ? null : (ids[ids.length - 1] ?? after),
        );
    })();
    // One source per call keeps a call bounded by `limit`.
    return Math.max(ids.length, 1);
  }
  return 0;
}

// ── Lists ───────────────────────────────────────────────────────────────────

/** Rows one transaction of a list copy writes. */
export const FILTER_COPY_LIST_BATCH = 2000;

interface ListState {
  source_id: string;
  field: string;
  device_id: string;
  generation: number;
  digest: string;
}

/**
 * Bring the index's lists in line with the corpus's: copy each list whose
 * published version differs, and drop each list the corpus no longer has.
 *
 * A list is written under its new generation beside the one being read and
 * switched in one row update, as in the corpus, so a search never sees half a
 * list. Returns how many lists changed.
 */
export function refreshFilterListCopy(deps: { corpusDb: Db; indexDb: Db }): number {
  const { corpusDb, indexDb } = deps;
  const key = (row: { source_id: string; field: string; device_id: string }): string =>
    JSON.stringify([row.source_id, row.field, row.device_id]);
  const published = corpusDb
    .prepare<[], ListState>(
      `SELECT source_id, field, device_id, generation, digest
         FROM source_filter_lists WHERE generation > 0`,
    )
    .all();
  const copied = new Map(
    indexDb
      .prepare<[], ListState>(
        "SELECT source_id, field, device_id, generation, digest FROM index_filter_lists",
      )
      .all()
      .map((row) => [key(row), row]),
  );
  let changed = 0;
  for (const list of published) {
    const current = copied.get(key(list));
    copied.delete(key(list));
    if (current && current.generation === list.generation && current.digest === list.digest) {
      continue;
    }
    copyList(corpusDb, indexDb, list);
    changed++;
  }
  for (const gone of copied.values()) {
    indexDb.transaction(() => {
      for (const table of [
        "index_filter_lists",
        "index_filter_items",
        "index_filter_item_members",
      ]) {
        indexDb
          .prepare(`DELETE FROM ${table} WHERE source_id = ? AND field = ? AND device_id = ?`)
          .run(gone.source_id, gone.field, gone.device_id);
      }
    })();
    changed++;
  }
  return changed;
}

function copyList(corpusDb: Db, indexDb: Db, list: ListState): void {
  const where = "source_id = ? AND field = ? AND device_id = ?";
  const listKey = [list.source_id, list.field, list.device_id] as const;
  // Both reads are one statement each at the generation read above. A list
  // republished between them leaves a copy that mixes nothing: the rows of a
  // generation never change, and the next refresh sees the newer generation.
  const items = corpusDb
    .prepare<
      [string, string, string, number],
      { item_id: string; parent_id: string | null; label: string; members_incomplete: number }
    >(
      `SELECT item_id, parent_id, label, members_incomplete
         FROM source_filter_items WHERE ${where} AND generation = ?`,
    )
    .all(...listKey, list.generation);
  const members = corpusDb
    .prepare<
      [string, string, string, number],
      { item_id: string; identifier_type: string; identifier_value: string }
    >(
      `SELECT item_id, identifier_type, identifier_value
         FROM source_filter_item_members WHERE ${where} AND generation = ?`,
    )
    .all(...listKey, list.generation);

  // Rows left by an interrupted copy of this generation.
  indexDb.transaction(() => {
    const current = indexDb
      .prepare<[string, string, string], { generation: number }>(
        `SELECT generation FROM index_filter_lists WHERE ${where}`,
      )
      .get(...listKey);
    if (current?.generation === list.generation) return;
    indexDb
      .prepare(`DELETE FROM index_filter_items WHERE ${where} AND generation = ?`)
      .run(...listKey, list.generation);
    indexDb
      .prepare(`DELETE FROM index_filter_item_members WHERE ${where} AND generation = ?`)
      .run(...listKey, list.generation);
  })();
  const insertItem = indexDb.prepare(
    `INSERT OR REPLACE INTO index_filter_items
       (source_id, field, device_id, generation, item_id, parent_id, label, members_incomplete)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let offset = 0; offset < items.length; offset += FILTER_COPY_LIST_BATCH) {
    indexDb.transaction(() => {
      for (const item of items.slice(offset, offset + FILTER_COPY_LIST_BATCH)) {
        insertItem.run(
          ...listKey,
          list.generation,
          item.item_id,
          item.parent_id,
          item.label,
          item.members_incomplete,
        );
      }
    })();
  }
  const insertMember = indexDb.prepare(
    `INSERT OR REPLACE INTO index_filter_item_members
       (source_id, field, device_id, generation, item_id, identifier_type, identifier_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let offset = 0; offset < members.length; offset += FILTER_COPY_LIST_BATCH) {
    indexDb.transaction(() => {
      for (const member of members.slice(offset, offset + FILTER_COPY_LIST_BATCH)) {
        insertMember.run(
          ...listKey,
          list.generation,
          member.item_id,
          member.identifier_type,
          member.identifier_value,
        );
      }
    })();
  }
  // The switch, then the rows of the version it replaced.
  indexDb.transaction(() => {
    indexDb
      .prepare(
        `INSERT INTO index_filter_lists (source_id, field, device_id, generation, digest)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_id, field, device_id) DO UPDATE SET
           generation = excluded.generation, digest = excluded.digest`,
      )
      .run(...listKey, list.generation, list.digest);
  })();
  for (const table of ["index_filter_items", "index_filter_item_members"]) {
    for (;;) {
      const removed = indexDb
        .prepare(
          `DELETE FROM ${table} WHERE ${where} AND generation <> ?
             AND item_id IN (SELECT item_id FROM ${table} WHERE ${where} AND generation <> ? LIMIT ${FILTER_COPY_LIST_BATCH})`,
        )
        .run(...listKey, list.generation, ...listKey, list.generation).changes;
      if (removed < FILTER_COPY_LIST_BATCH) break;
    }
  }
}
