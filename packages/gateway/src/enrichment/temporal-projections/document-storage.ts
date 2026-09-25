// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  TEMPORAL_KINDS,
  TEMPORAL_MODALITIES,
  TEMPORAL_STATUSES,
  temporalVocabularyCheck,
} from "@omnesis/types";
import { createLogger } from "@omnesis/core";
import { deriveTemporalFact, stableProjectionId } from "./derive.js";
import type { DocumentTemporalProjectionSpec } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type { Db } from "../../data/types.js";

const log = createLogger("gateway:temporal-projections");

/**
 * Install the SQLite half of source-owned temporal projections.
 *
 * Analytics-row projections live in DuckDB's private
 * `_temporal_projections` table. Document-backed projections live here so
 * they can be replaced in the same SQLite transaction as their owning
 * document. The coverage row is authoritative for the declaration currently
 * advertised by a source; it is not a claim that historical documents were
 * backfilled.
 */
export function createDocumentTemporalProjectionTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_temporal_projections (
      id TEXT PRIMARY KEY CHECK (id LIKE 'tp_%'),
      source_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      document_external_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_exclusive_ms INTEGER NOT NULL CHECK (end_exclusive_ms >= start_ms),
      start_canonical TEXT NOT NULL,
      end_canonical TEXT NOT NULL,
      precision TEXT NOT NULL CHECK (precision IN ('instant', 'day')),
      all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
      time_zone TEXT,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (${temporalVocabularyCheck("kind", TEMPORAL_KINDS)}),
      modality TEXT NOT NULL CHECK (${temporalVocabularyCheck("modality", TEMPORAL_MODALITIES)}),
      status TEXT NOT NULL CHECK (${temporalVocabularyCheck("status", TEMPORAL_STATUSES)}),
      source_updated_at TEXT,
      projected_at TEXT NOT NULL,
      UNIQUE(document_id, slot),
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_document_temporal_projections_window
      ON document_temporal_projections(start_ms, end_exclusive_ms)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_document_temporal_projections_source
      ON document_temporal_projections(source_id, slot)
  `);

  // No FK to sync_state: that table is keyed per (source, device), so it
  // has no single-column parent key to reference. Cleanup is explicit —
  // the unregister path below and the source-wipe flows in
  // DocumentRepository delete these rows alongside the source's sync state.
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_temporal_projection_sources (
      source_id TEXT PRIMARY KEY,
      slots_json TEXT NOT NULL,
      last_materialized_at TEXT,
      last_sync_at TEXT NOT NULL
    )
  `);
}

/**
 * Replace every source-owned slot for one document.
 *
 * This function intentionally owns no transaction: `upsertDocuments` invokes
 * it from the transaction that inserts/updates the document row, so a field a
 * source has since retracted deletes its former projection atomically with the
 * document update rather than leaving a fact nothing asserts any more.
 *
 * Sharing that transaction is also why nothing here throws: the document is the
 * thing being stored, and a projection is derived metadata about it.
 */
export function replaceDocumentTemporalProjections(
  db: Db,
  document: DocumentInput,
  specs: readonly DocumentTemporalProjectionSpec[],
  projectedAt: string,
  /** The stream the document belongs to (`""` = the source's one stream). */
  streamId = "",
): void {
  const stored = db
    .prepare<[string, string, string, string], { id: string }>(
      `SELECT id FROM documents
       WHERE provider_id = ? AND source_id = ? AND external_id = ? AND stream_id = ?`,
    )
    .get(document.providerId, document.sourceId, document.externalId, streamId);

  // A privacy tombstone may have suppressed this document before the caller
  // reached us. It owns no projection when no document row survived.
  if (!stored) return;

  // The page declaration is authoritative. Clearing all of this document's
  // prior slots also removes a slot retired by a later source version.
  db.prepare("DELETE FROM document_temporal_projections WHERE document_id = ?").run(stored.id);

  const insert = db.prepare(`
    INSERT INTO document_temporal_projections (
      id, source_id, document_id, document_external_id, slot,
      start_ms, end_exclusive_ms, start_canonical, end_canonical,
      precision, all_day, time_zone, label, kind, modality, status,
      source_updated_at, projected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // `$semanticTime` on a document is the document's own event time; every
  // other ref names a typed metadata field the spec was validated against.
  const read = (ref: string): unknown =>
    ref === "$semanticTime"
      ? document.sourceCreatedAt
      : (document.metadata as Record<string, unknown>)[ref];

  for (const spec of specs) {
    // A document that carries no declared date owns no projection for the
    // slot; the derivation declines it. Because this runs inside the
    // document's own write, a date that has since been retracted has already
    // had its row deleted above.
    //
    // A value that cannot be canonicalized costs the slot and nothing more.
    // A projection is derived, optional metadata, whereas this runs inside the
    // transaction that stores the document itself: letting one unparseable
    // date reach the caller would fail the whole page, leave the sync cursor
    // where it was, and stall the source on the same document forever. Sources
    // lift dates out of third-party content, so an unusable value is ordinary
    // input, not a defect to halt on.
    try {
      const fact = deriveTemporalFact({
        spec,
        read,
        fallbackLabel: document.title,
        context: `document ${document.externalId} slot ${spec.slot}`,
      });
      if (!fact) continue;

      // The row's identity is the document it describes plus the slot it
      // fills — exactly what `UNIQUE(document_id, slot)` already says. Deriving
      // the primary key from that same pair makes the two agree by
      // construction, and makes the delete above a complete cleanup: anything
      // this write could collide with belongs to this document and has just
      // been removed. A document's identity is (providerId, sourceId,
      // externalId); keying off any narrower part of it would let two
      // genuinely distinct documents claim one id.
      insert.run(
        stableProjectionId(stored.id, spec.slot),
        document.sourceId,
        stored.id,
        document.externalId,
        spec.slot,
        fact.startMs,
        fact.endExclusiveMs,
        fact.startCanonical,
        fact.endCanonical,
        fact.precision,
        fact.allDay ? 1 : 0,
        fact.timeZone,
        fact.label,
        fact.kind,
        fact.modality,
        fact.status,
        document.sourceUpdatedAt,
        projectedAt,
      );
    } catch (error) {
      log.warn(
        `Skipped temporal projection '${spec.slot}' for ${document.sourceId} ${document.externalId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Record the source's current document-projection declaration.
 *
 * `specs` is authoritative when present. An empty list retires all document
 * projection slots for the source. Omitting the field (an older client) is
 * handled by the caller as "no coverage update" for wire compatibility.
 */
export function registerDocumentTemporalProjectionCoverage(
  db: Db,
  sourceId: string,
  specs: readonly DocumentTemporalProjectionSpec[],
  materializedDocuments: boolean,
  syncedAt: string,
): void {
  if (specs.length === 0) {
    db.prepare("DELETE FROM document_temporal_projections WHERE source_id = ?").run(sourceId);
    db.prepare("DELETE FROM document_temporal_projection_sources WHERE source_id = ?").run(
      sourceId,
    );
    return;
  }

  const slots = [...specs.map((spec) => spec.slot)].sort();
  const placeholders = slots.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM document_temporal_projections
     WHERE source_id = ? AND slot NOT IN (${placeholders})`,
  ).run(sourceId, ...slots);

  db.prepare(
    `INSERT INTO document_temporal_projection_sources (
       source_id, slots_json, last_materialized_at, last_sync_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       slots_json = excluded.slots_json,
       last_materialized_at = CASE
         WHEN excluded.last_materialized_at IS NULL
           THEN document_temporal_projection_sources.last_materialized_at
         ELSE excluded.last_materialized_at
       END,
       last_sync_at = excluded.last_sync_at`,
  ).run(sourceId, JSON.stringify(slots), materializedDocuments ? syncedAt : null, syncedAt);
}
