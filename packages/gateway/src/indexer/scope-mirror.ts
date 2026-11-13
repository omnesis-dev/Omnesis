// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createScopeFactsDocumentTriggers,
  createScopeFactsSchema,
} from "../access/scope-schema.js";
import type { ScopeSourceGeneration } from "../access/scope-generations.js";
import type { Db } from "../data/types.js";

interface ReplayState {
  source_id: string;
  epoch: string;
  generation: number;
  phase: string;
  cursor: number;
}
export function createScopeMirrorSchema(db: Db): void {
  createScopeFactsSchema(db);
  createScopeFactsDocumentTriggers(db);
  db.exec(`CREATE TABLE IF NOT EXISTS index_scope_generations (
    source_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, generation INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS index_scope_documents(document_id TEXT PRIMARY KEY,source_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_index_scope_documents_source ON index_scope_documents(source_id);
  CREATE TABLE IF NOT EXISTS index_scope_acknowledgements (source_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,generation INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS index_scope_replay (
    source_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, generation INTEGER NOT NULL,
    phase TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS index_scope_hierarchy_replay(source_id TEXT PRIMARY KEY,kind TEXT NOT NULL DEFAULT '',entity_id TEXT NOT NULL DEFAULT '');`);
}

function tableExists(db: Db, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

/** The per-document tables the index keeps a copy of. */
const ITEM_TABLES = [
  "document_scope_facts",
  "document_scope_completeness",
  "document_scope_subjects",
  "document_scope_conversations",
  "scope_hierarchy_dependencies",
  "scope_native_refresh_witnesses",
] as const;

interface ItemMirror {
  /** Drop a mirrored item; with `sourceId`, only while the index holds it for that source. */
  delete(id: string, sourceId?: string): void;
  /** Replace a mirrored item with the corpus's rows, or drop it when the source no longer owns it. */
  copy(id: string, sourceId: string): void;
}

/**
 * Statements for copying items, prepared once for a replay call rather than
 * once per document. A table missing on either side is left out.
 */
function createItemMirror(corpus: Db, index: Db): ItemMirror {
  const mirrored = ITEM_TABLES.filter((table) => tableExists(index, table));
  const deletes = mirrored.map((table) =>
    index.prepare<[string]>(`DELETE FROM ${table} WHERE document_id=?`),
  );
  const copies = mirrored
    .filter((table) => tableExists(corpus, table))
    .map((table) => {
      const read = corpus.prepare<[string], Record<string, string | number | null>>(
        `SELECT * FROM ${table} WHERE document_id=?`,
      );
      const columns = read.columns().map((column) => column.name);
      const write = index.prepare<[string]>(
        `INSERT INTO ${table} (${columns.join(",")})
      SELECT ${columns.map((column) => `json_extract(value,'$.${column}')`).join(",")} FROM json_each(?)`,
      );
      return { read, write };
    });
  const mirroredOwner = index.prepare<[string], { source_id: string }>(
    "SELECT source_id FROM index_scope_documents WHERE document_id=?",
  );
  const forget = index.prepare<[string]>("DELETE FROM index_scope_documents WHERE document_id=?");
  const remember = index.prepare<[string, string]>(
    "INSERT INTO index_scope_documents VALUES (?,?)",
  );
  const corpusOwner = corpus.prepare<[string, string], { source_id: string }>(
    "SELECT source_id FROM documents WHERE id=? UNION ALL SELECT source_id FROM scope_conversations WHERE subject_document_id=? LIMIT 1",
  );
  const mirror: ItemMirror = {
    delete(id, sourceId) {
      if (sourceId && mirroredOwner.get(id)?.source_id !== sourceId) return;
      for (const statement of deletes) statement.run(id);
      forget.run(id);
    },
    copy(id, sourceId) {
      if (corpusOwner.get(id, id)?.source_id !== sourceId) {
        mirror.delete(id, sourceId);
        return;
      }
      mirror.delete(id);
      remember.run(id, sourceId);
      for (const { read, write } of copies) {
        const rows = read.all(id);
        if (rows.length) write.run(JSON.stringify(rows));
      }
    },
  };
  return mirror;
}

function copyHierarchyDirty(
  corpus: Db,
  index: Db,
  sourceId: string,
  kind: string,
  entityId: string,
): void {
  index
    .prepare("DELETE FROM scope_hierarchy_dirty WHERE source_id=? AND kind=? AND entity_id=?")
    .run(sourceId, kind, entityId);
  const row = corpus
    .prepare("SELECT * FROM scope_hierarchy_dirty WHERE source_id=? AND kind=? AND entity_id=?")
    .get(sourceId, kind, entityId) as Record<string, string> | undefined;
  if (row)
    index
      .prepare(
        "INSERT INTO scope_hierarchy_dirty(source_id,kind,entity_id,revision,cursor_document_id) VALUES(?,?,?,?,?)",
      )
      .run(row.source_id, row.kind, row.entity_id, row.revision, row.cursor_document_id);
}

/**
 * Initial replay walks bounded document/virtual-subject pages without restarting
 * for concurrent writes. A coalesced durable dirty queue then catches changes
 * after that baseline. Subsequent generations copy only changed subjects.
 * Publication and its generation are atomic on the existing index writer.
 */
export function replayScopeMirror(
  corpus: Db,
  index: Db,
  options: { batchSize?: number; maxBatches?: number } = {},
): {
  pages: number;
  published: number;
  copied: number;
  completed: ScopeSourceGeneration[];
} {
  const batchSize = options.batchSize ?? 100;
  const maxBatches = options.maxBatches ?? 1;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000 ||
    !Number.isSafeInteger(maxBatches) ||
    maxBatches < 1
  )
    throw new Error("Invalid scope replay batch.");
  let pages = 0,
    published = 0,
    copied = 0;
  const completed: ScopeSourceGeneration[] = [];
  let itemMirror: ItemMirror | undefined;
  const items = (): ItemMirror => (itemMirror ??= createItemMirror(corpus, index));
  while (pages < maxBatches) {
    const worked = corpus.transaction(() => {
      const clock = corpus
        .prepare<[], { epoch: string }>("SELECT epoch FROM scope_generation_clock WHERE id=1")
        .get();
      if (!clock) return false;
      const sources = corpus
        .prepare<[], { source_id: string; generation: number }>(
          "SELECT source_id,generation FROM scope_source_generations ORDER BY generation,source_id",
        )
        .all();
      const source = sources.find((row) => {
        const mirrored = index
          .prepare<[string], { epoch: string; generation: number }>(
            "SELECT epoch,generation FROM index_scope_generations WHERE source_id=?",
          )
          .get(row.source_id);
        return mirrored?.epoch !== clock.epoch || mirrored.generation !== row.generation;
      });
      if (!source) return false;
      const current = index
        .prepare<[string], ReplayState>("SELECT * FROM index_scope_replay WHERE source_id=?")
        .get(source.source_id);
      const mirrored = index
        .prepare<[string], { epoch: string; generation: number }>(
          "SELECT epoch,generation FROM index_scope_generations WHERE source_id=?",
        )
        .get(source.source_id);
      let state: ReplayState =
        current?.epoch === clock.epoch
          ? current
          : mirrored?.epoch === clock.epoch
            ? {
                ...source,
                epoch: clock.epoch,
                generation: mirrored.generation,
                phase: "delta",
                cursor: mirrored.generation,
              }
            : { ...source, epoch: clock.epoch, phase: "clear", cursor: 0 };
      const rebuild = corpus
        .prepare<[string, number], { generation: number }>(
          "SELECT generation FROM scope_replay_dirty WHERE source_id=? AND kind='rebuild' AND generation>? LIMIT 1",
        )
        .get(source.source_id, state.generation);
      if (rebuild) state = { ...source, epoch: clock.epoch, phase: "clear", cursor: 0 };
      index.transaction(() => {
        index
          .prepare("DELETE FROM index_scope_generations WHERE source_id=?")
          .run(source.source_id);
        if (state.phase === "clear") {
          const ids = index
            .prepare<[string, number], { document_id: string }>(
              "SELECT document_id FROM index_scope_documents WHERE source_id=? LIMIT ?",
            )
            .all(source.source_id, batchSize);
          for (const row of ids) items().delete(row.document_id, source.source_id);
          if (ids.length < batchSize) {
            state.phase = "hierarchy-clear";
            state.cursor = 0;
          }
        } else if (state.phase === "hierarchy-clear") {
          const changed = index
            .prepare(
              `DELETE FROM scope_hierarchy_dirty WHERE source_id=? AND (kind,entity_id) IN
            (SELECT kind,entity_id FROM scope_hierarchy_dirty WHERE source_id=? LIMIT ?)`,
            )
            .run(source.source_id, source.source_id, batchSize);
          if (changed.changes < batchSize) {
            index
              .prepare(
                "INSERT INTO index_scope_hierarchy_replay(source_id) VALUES(?) ON CONFLICT(source_id) DO UPDATE SET kind='',entity_id=''",
              )
              .run(source.source_id);
            state.phase = "hierarchy";
          }
        } else if (state.phase === "hierarchy") {
          const cursor = index
            .prepare<[string], { kind: string; entity_id: string }>(
              "SELECT kind,entity_id FROM index_scope_hierarchy_replay WHERE source_id=?",
            )
            .get(source.source_id) ?? { kind: "", entity_id: "" };
          const rows = corpus
            .prepare<[string, string, string, number], { kind: string; entity_id: string }>(
              "SELECT kind,entity_id FROM scope_hierarchy_dirty WHERE source_id=? AND (kind,entity_id)>(?,?) ORDER BY kind,entity_id LIMIT ?",
            )
            .all(source.source_id, cursor.kind, cursor.entity_id, batchSize);
          for (const row of rows) {
            copyHierarchyDirty(corpus, index, source.source_id, row.kind, row.entity_id);
            copied++;
          }
          const last = rows.at(-1);
          if (last)
            index
              .prepare(
                "UPDATE index_scope_hierarchy_replay SET kind=?,entity_id=? WHERE source_id=?",
              )
              .run(last.kind, last.entity_id, source.source_id);
          if (rows.length < batchSize) {
            state.phase = "documents";
            state.cursor = 0;
          }
        } else if (state.phase === "documents" || state.phase === "conversations") {
          const virtual = state.phase === "conversations";
          const rows = corpus
            .prepare<[string, number, number], { rowid: number; id: string }>(
              virtual
                ? "SELECT rowid,subject_document_id AS id FROM scope_conversations WHERE source_id=? AND rowid>? ORDER BY rowid LIMIT ?"
                : "SELECT rowid,id FROM documents WHERE source_id=? AND rowid>? ORDER BY rowid LIMIT ?",
            )
            .all(source.source_id, state.cursor, batchSize);
          for (const row of rows) {
            items().copy(row.id, source.source_id);
            copied++;
            state.cursor = row.rowid;
          }
          if (rows.length < batchSize) {
            state.phase = virtual ? "delta" : "conversations";
            state.cursor = virtual ? state.generation : 0;
          }
        } else {
          const dirty = corpus
            .prepare<
              [string, number, number, number],
              { kind: string; subject_document_id: string; generation: number }
            >(
              "SELECT kind,subject_document_id,generation FROM scope_replay_dirty WHERE source_id=? AND generation>? AND generation<=? ORDER BY generation LIMIT ?",
            )
            .all(source.source_id, state.cursor, source.generation, batchSize);
          for (const row of dirty) {
            if (row.kind === "subject") {
              items().copy(row.subject_document_id, source.source_id);
              copied++;
            } else if (row.kind === "hierarchy") {
              const key: unknown = JSON.parse(row.subject_document_id);
              if (
                !Array.isArray(key) ||
                key.length !== 2 ||
                !key.every((value) => typeof value === "string")
              )
                throw new Error("Invalid hierarchy replay subject.");
              copyHierarchyDirty(corpus, index, source.source_id, key[0], key[1]);
              copied++;
            }
            state.cursor = row.generation;
          }
          if (dirty.length < batchSize) {
            for (const table of [
              "scope_fact_backfill",
              "source_scope_kind_readiness",
              "source_scope_refreshes",
              "source_scope_refresh_requirements",
              "scope_native_reprojection_sources",
            ]) {
              if (!tableExists(corpus, table) || !tableExists(index, table)) continue;
              index.prepare(`DELETE FROM ${table} WHERE source_id=?`).run(source.source_id);
              const rows = corpus
                .prepare(`SELECT * FROM ${table} WHERE source_id=?`)
                .all(source.source_id) as Array<Record<string, string | number>>;
              for (const row of rows) {
                const columns = Object.keys(row);
                index
                  .prepare(
                    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
                  )
                  .run(...Object.values(row));
              }
            }
            index
              .prepare("INSERT INTO index_scope_generations VALUES (?,?,?)")
              .run(source.source_id, clock.epoch, source.generation);
            index.prepare("DELETE FROM index_scope_replay WHERE source_id=?").run(source.source_id);
            index
              .prepare("DELETE FROM index_scope_hierarchy_replay WHERE source_id=?")
              .run(source.source_id);
            index
              .prepare(
                `INSERT INTO index_scope_acknowledgements VALUES (?,?,?) ON CONFLICT(source_id) DO UPDATE SET epoch=excluded.epoch,generation=excluded.generation`,
              )
              .run(source.source_id, clock.epoch, source.generation);
            published++;
            completed.push({
              sourceId: source.source_id,
              epoch: clock.epoch,
              generation: source.generation,
            });
            return;
          }
        }
        index
          .prepare(
            `INSERT INTO index_scope_replay VALUES (?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET
          epoch=excluded.epoch,generation=excluded.generation,phase=excluded.phase,cursor=excluded.cursor`,
          )
          .run(state.source_id, state.epoch, state.generation, state.phase, state.cursor);
      })();
      return true;
    })();
    if (!worked) break;
    pages++;
  }
  return { pages, published, copied, completed };
}
