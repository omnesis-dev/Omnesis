// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Writer for source-declared edges (#430) — the explicit `EdgeDeclaration`
 * contract path, distinct from the implicit `metadata.extra` conventions that
 * `extractLinks` reads.
 *
 * A source emits `edges: EdgeDeclaration[]` alongside its documents in a sync
 * page. `applyDeclaredEdges` runs inside the same atomic `upsertWithCursor`
 * transaction, AFTER the documents are upserted, so the declaring document
 * always exists. For each edge it:
 *   - resolves both endpoints `(sourceId, externalId) → documentId`;
 *   - if the target is resolved, writes a `document_links` row with
 *     `source-declared` provenance;
 *   - if the target hasn't been ingested yet (a forward reference), parks the
 *     edge in `pending_edges` so the graph walker and link stats never see a
 *     half-resolved edge;
 *   - diffs the just-declared set against the doc's existing source-declared
 *     edges of the SAME types and deletes the ones not re-declared (the
 *     contract is a full snapshot per document, scoped to the types declared
 *     this sync — convention-derived edges of other types are untouched).
 *
 * `drainPendingEdges` is the periodic companion: it retries resolution of the
 * pending rows, promotes resolved ones into `document_links`, and drops rows
 * whose target never arrives within a TTL.
 *
 * These edges are NOT in `EXTRACT_LINKS_MANAGED_TYPES`, so the link-backfill
 * re-extraction wipe leaves them alone — their lifecycle is owned here.
 */

import { createLogger, type DocumentRef, type EdgeDeclaration } from "@omnesis/core";
import { markLinkStatsDirty } from "../data/DirtyMarks.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("gateway:edges");

/**
 * How long a forward-reference edge waits in `pending_edges` for its target to
 * appear before it is dropped (and logged). 24h is generous for a target that
 * arrives in a later sync page or a sibling source's next cycle; a target still
 * missing after a day was most likely deleted upstream or mistyped.
 */
const DEFAULT_PENDING_EDGE_TTL_MS = 24 * 60 * 60 * 1000;

/** Resolve a `DocumentRef` to the `(sourceId, externalId)` it addresses. */
function refIdentity(
  ref: DocumentRef,
  declaringSourceId: string,
): { sourceId: string; externalId: string } {
  return ref.kind === "internal"
    ? { sourceId: declaringSourceId, externalId: ref.sourceDocumentId }
    : { sourceId: ref.sourceId, externalId: ref.sourceDocumentId };
}

/**
 * The `document_links.normalized_target` for a declared edge — the target's
 * `(sourceId, externalId)` JSON-encoded. JSON makes the decomposition
 * unambiguous (no separator can collide with an id) and keeps the stored value
 * ASCII. Stable across re-declarations, so the `UNIQUE(source_doc_id,
 * link_type, normalized_target)` constraint dedups a re-emitted edge onto the
 * same row; distinct from the bare-externalId normalized_target the conventions
 * use, so a declared and a convention edge never collide on the unique key.
 */
function normalizedTargetFor(target: { sourceId: string; externalId: string }): string {
  return JSON.stringify([target.sourceId, target.externalId]);
}

/** A stable, collision-free in-memory key for a `(type, normalizedTarget)` pair. */
function edgeKey(linkType: string, normalizedTarget: string): string {
  return JSON.stringify([linkType, normalizedTarget]);
}

/** Merge `EdgeDeclaration.metadata` + `ordering` into the persisted JSON. */
function metadataJsonFor(edge: EdgeDeclaration): string | null {
  const merged: Record<string, unknown> = { ...(edge.metadata ?? {}) };
  if (edge.ordering !== undefined) merged.ordering = edge.ordering;
  return Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
}

export interface ApplyDeclaredEdgesResult {
  /** Edges resolved and written into `document_links`. */
  written: number;
  /** Edges parked in `pending_edges` (target not yet ingested). */
  pending: number;
  /** Edges removed by the per-document diff (retracted by the source). */
  removed: number;
  /** Edges skipped because their declaring (`from`) document could not resolve. */
  skipped: number;
}

/**
 * Persist a sync page's declared edges. MUST run inside the writer transaction,
 * after the page's documents are upserted.
 */
export function applyDeclaredEdges(
  db: Db,
  declaringSourceId: string,
  edges: readonly EdgeDeclaration[],
  now: string = new Date().toISOString(),
  /** The declaring page's stream; an endpoint in that stream wins over a namesake in another. */
  streamId = "",
): ApplyDeclaredEdgesResult {
  const result: ApplyDeclaredEdgesResult = { written: 0, pending: 0, removed: 0, skipped: 0 };
  if (edges.length === 0) return result;

  const lookupStmt = db.prepare<[string, string, string], { id: string }>(
    "SELECT id FROM documents WHERE source_id = ? AND external_id = ? ORDER BY stream_id = ? DESC LIMIT 1",
  );
  const resolveCache = new Map<string, string | null>();
  function resolveDocId(ident: { sourceId: string; externalId: string }): string | null {
    const key = JSON.stringify([ident.sourceId, ident.externalId]);
    const cached = resolveCache.get(key);
    if (cached !== undefined) return cached;
    const id = lookupStmt.get(ident.sourceId, ident.externalId, streamId)?.id ?? null;
    resolveCache.set(key, id);
    return id;
  }

  interface PreparedEdge {
    linkType: string;
    target: { sourceId: string; externalId: string };
    normalizedTarget: string;
    metadataJson: string | null;
  }
  // Group declared edges by their resolved `from` document.
  const byFrom = new Map<string, PreparedEdge[]>();
  for (const edge of edges) {
    const fromIdent = refIdentity(edge.from, declaringSourceId);
    const fromDocId = resolveDocId(fromIdent);
    if (!fromDocId) {
      // The declaring document should be co-emitted in this sync; a miss means
      // the source declared an edge from a doc it didn't ingest. Log and skip —
      // a document_links row needs a real source_doc_id (FK).
      result.skipped += 1;
      log.warn(
        `declared edge '${edge.type}': from-doc ${fromIdent.sourceId}/${fromIdent.externalId} not found, skipping`,
      );
      continue;
    }
    const target = refIdentity(edge.to, declaringSourceId);
    const list = byFrom.get(fromDocId);
    const prepared: PreparedEdge = {
      linkType: edge.type,
      target,
      normalizedTarget: normalizedTargetFor(target),
      metadataJson: metadataJsonFor(edge),
    };
    if (list) list.push(prepared);
    else byFrom.set(fromDocId, [prepared]);
  }

  const insertResolved = db.prepare(
    `INSERT INTO document_links
       (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at, metadata_json, provenance_kind, provenance_origin, provenance_version, declared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'source-declared', ?, NULL, ?)
     ON CONFLICT(source_doc_id, link_type, normalized_target) DO UPDATE SET
       target_doc_id = excluded.target_doc_id,
       resolved_at = excluded.resolved_at,
       metadata_json = excluded.metadata_json,
       provenance_origin = excluded.provenance_origin`,
  );
  const insertPending = db.prepare(
    `INSERT INTO pending_edges
       (source_doc_id, link_type, target_source_id, target_external_id, provenance_origin, provenance_version, metadata_json, declared_at, attempt_count)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0)
     ON CONFLICT(source_doc_id, link_type, target_source_id, target_external_id) DO UPDATE SET
       metadata_json = excluded.metadata_json,
       declared_at = excluded.declared_at`,
  );

  for (const [fromDocId, list] of byFrom) {
    const declaredTypes = [...new Set(list.map((p) => p.linkType))];
    const keep = new Set(list.map((p) => edgeKey(p.linkType, p.normalizedTarget)));
    const typePlaceholders = declaredTypes.map(() => "?").join(", ");

    // Diff-delete in document_links: drop source-declared edges of the declared
    // types whose (type, target) is not re-declared this sync.
    const existingLinks = db
      .prepare<string[], { id: number; link_type: string; normalized_target: string }>(
        `SELECT id, link_type, normalized_target FROM document_links
          WHERE source_doc_id = ? AND provenance_kind = 'source-declared'
            AND link_type IN (${typePlaceholders})`,
      )
      .all(fromDocId, ...declaredTypes);
    const deleteLinkStmt = db.prepare("DELETE FROM document_links WHERE id = ?");
    for (const row of existingLinks) {
      if (!keep.has(edgeKey(row.link_type, row.normalized_target))) {
        deleteLinkStmt.run(row.id);
        result.removed += 1;
      }
    }

    // Diff-delete in pending_edges: same scope, for forward refs not re-declared.
    const existingPending = db
      .prepare<
        string[],
        { id: number; link_type: string; target_source_id: string; target_external_id: string }
      >(
        `SELECT id, link_type, target_source_id, target_external_id FROM pending_edges
          WHERE source_doc_id = ? AND link_type IN (${typePlaceholders})`,
      )
      .all(fromDocId, ...declaredTypes);
    const deletePendingStmt = db.prepare("DELETE FROM pending_edges WHERE id = ?");
    for (const row of existingPending) {
      const nt = normalizedTargetFor({
        sourceId: row.target_source_id,
        externalId: row.target_external_id,
      });
      if (!keep.has(edgeKey(row.link_type, nt))) {
        deletePendingStmt.run(row.id);
        result.removed += 1;
      }
    }

    // Write the declared set: resolved → document_links, else → pending_edges.
    for (const p of list) {
      const targetDocId = resolveDocId(p.target);
      if (targetDocId) {
        insertResolved.run(
          fromDocId,
          p.linkType,
          p.target.externalId,
          p.normalizedTarget,
          targetDocId,
          now,
          now,
          p.metadataJson,
          declaringSourceId,
          now,
        );
        result.written += 1;
      } else {
        insertPending.run(
          fromDocId,
          p.linkType,
          p.target.sourceId,
          p.target.externalId,
          declaringSourceId,
          p.metadataJson,
          now,
        );
        result.pending += 1;
      }
    }
  }

  if (result.written > 0 || result.removed > 0) markLinkStatsDirty(db);
  return result;
}

export interface DrainPendingEdgesResult {
  /** Forward-reference edges whose target arrived and were promoted to document_links. */
  promoted: number;
  /** Edges dropped because their target never appeared within the TTL. */
  dropped: number;
  /** Edges still waiting (target not yet ingested, not yet expired). */
  retried: number;
}

/**
 * Periodic drain of `pending_edges`. Retries resolution of each parked
 * forward-reference; promotes resolved ones into `document_links` with
 * source-declared provenance; drops rows past their TTL with a log line so a
 * persistently-missing target is visible to the operator. Runs in one writer
 * transaction. Bounded by `limit` so a large backlog drains across ticks.
 */
export function drainPendingEdges(
  db: Db,
  opts: { limit?: number; ttlMs?: number; now?: Date } = {},
): DrainPendingEdgesResult {
  const limit = opts.limit ?? 200;
  const ttlMs = opts.ttlMs ?? DEFAULT_PENDING_EDGE_TTL_MS;
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const result: DrainPendingEdgesResult = { promoted: 0, dropped: 0, retried: 0 };

  interface PendingRow {
    id: number;
    source_doc_id: string;
    link_type: string;
    target_source_id: string;
    target_external_id: string;
    provenance_origin: string;
    provenance_version: string | null;
    metadata_json: string | null;
    declared_at: string;
  }
  // Never-attempted rows first, then least-recently-attempted: each retry
  // bumps `last_attempt_at`, so rows whose target never arrives rotate to the
  // back instead of pinning the front of the queue. A plain `ORDER BY id`
  // starves everything behind `limit` permanently-unresolvable rows.
  const rows = db
    .prepare<[number], PendingRow>(
      `SELECT id, source_doc_id, link_type, target_source_id, target_external_id,
              provenance_origin, provenance_version, metadata_json, declared_at
         FROM pending_edges ORDER BY COALESCE(last_attempt_at, '') ASC, id ASC LIMIT ?`,
    )
    .all(limit);
  if (rows.length === 0) return result;

  // An endpoint in the declaring document's stream wins over a namesake in
  // another stream.
  const lookupStmt = db.prepare<[string, string, string], { id: string }>(
    `SELECT id FROM documents WHERE source_id = ? AND external_id = ?
      ORDER BY stream_id = (SELECT stream_id FROM documents WHERE id = ?) DESC LIMIT 1`,
  );
  const promoteStmt = db.prepare(
    `INSERT INTO document_links
       (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at, metadata_json, provenance_kind, provenance_origin, provenance_version, declared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_doc_id, link_type, normalized_target) DO UPDATE SET
       target_doc_id = excluded.target_doc_id,
       resolved_at = excluded.resolved_at,
       metadata_json = excluded.metadata_json,
       provenance_origin = excluded.provenance_origin`,
  );
  const deleteStmt = db.prepare("DELETE FROM pending_edges WHERE id = ?");
  const bumpStmt = db.prepare(
    "UPDATE pending_edges SET last_attempt_at = ?, attempt_count = attempt_count + 1 WHERE id = ?",
  );

  const apply = db.transaction(() => {
    for (const row of rows) {
      const targetDocId = lookupStmt.get(
        row.target_source_id,
        row.target_external_id,
        row.source_doc_id,
      )?.id;
      if (targetDocId) {
        const normalizedTarget = normalizedTargetFor({
          sourceId: row.target_source_id,
          externalId: row.target_external_id,
        });
        promoteStmt.run(
          row.source_doc_id,
          row.link_type,
          row.target_external_id,
          normalizedTarget,
          targetDocId,
          nowIso,
          nowIso,
          row.metadata_json,
          "source-declared",
          row.provenance_origin,
          row.provenance_version,
          row.declared_at,
        );
        deleteStmt.run(row.id);
        result.promoted += 1;
        continue;
      }
      const ageMs = nowMs - Date.parse(row.declared_at);
      if (Number.isFinite(ageMs) && ageMs > ttlMs) {
        deleteStmt.run(row.id);
        result.dropped += 1;
        log.warn(
          `dropping pending '${row.link_type}' edge from doc ${row.source_doc_id} → ${row.target_source_id}/${row.target_external_id}: target not ingested within TTL`,
        );
        continue;
      }
      bumpStmt.run(nowIso, row.id);
      result.retried += 1;
    }
  });
  apply();

  if (result.promoted > 0) markLinkStatsDirty(db);
  return result;
}
