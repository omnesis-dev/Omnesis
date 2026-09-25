// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One-time fold of the legacy browser-extension source into `web`.
 *
 * Early browser-extension builds wrote `source_id = "browser"`,
 * `documentType = "web-page"`, and used the normalized URL directly as the
 * external id. The `web` source uses
 * `urlToExternalId(normalizeUrl(url))` instead. This migration:
 *
 *   1. Recompute each legacy doc's `external_id` to the canonical scheme and
 *      re-home it onto `(provider_id="web", source_id="web")`,
 *      `documentType="webpage"`.
 *   2. Where normalization collapses duplicate browser rows onto the same
 *      `(web, external_id)`, keep the most recently updated row.
 *   3. Remap every `document_links` (source + target) and `pending_edges`
 *      (source) reference from a deleted loser id to the surviving id, dropping
 *      rows that would violate a unique key after the remap.
 *
 * ## Identity recompute uses the generic normalizer (no per-host registry)
 *
 * The per-host canonicalizer registry (Gmail/Drive) is process-level state the
 * collector pushes at runtime — it is not available at DB-open time when this
 * migration runs. That is correct here: the only declared canonicalizer hosts
 * are `ownedWebDomains` that the browser capture path already skips, so no
 * legacy browser document can carry such a URL. The generic
 * `normalizeUrl(url)` therefore reproduces exactly what the steady-state
 * producers compute for these documents.
 *
 * ## Idempotency
 *
 * Every step is keyed on the presence of rows under the legacy source ids. Once
 * the fold has run, no `browser` documents remain, so a replay
 * finds nothing to do and returns a zero-effect summary. The page-visits
 * analytics plane lives in the separate DuckDB analytics store and is re-homed
 * automatically when the `web` descriptor re-registers its `page_visits` schema
 * at boot (the analytics catalog's source-id upsert) — there is nothing to fold
 * in this SQLite migration for it.
 *
 * ## Why the old source ids are named here
 *
 * Naming `browser` is a one-time data migration over historical rows. The
 * steady-state write paths never branch on this retired id.
 */

import { normalizeUrl, urlToExternalId } from "@omnesis/core";
import { WEB_DOCUMENT_TYPE, WEB_PROVIDER_ID, WEB_SOURCE_ID } from "../web-dataset.js";
import type { Db } from "./types.js";

const LEGACY_BROWSER_SOURCE_ID = "browser";

/** A legacy web-page row as read for the fold. */
interface LegacyDocRow {
  readonly id: string;
  readonly source_id: string;
  readonly source_url: string | null;
  readonly metadata: string;
  readonly updated_at: string;
}

/** Effect summary, for logging + the migration test. */
export interface FoldWebPagesResult {
  /** Legacy browser docs scanned. */
  readonly scanned: number;
  /** Docs re-homed to `web` as a surviving row. */
  readonly folded: number;
  /** Duplicate browser docs deleted after URL normalization. */
  readonly deduped: number;
  /** `document_links` rows whose endpoints were remapped to a survivor. */
  readonly linksRemapped: number;
  /** `pending_edges` rows whose source was remapped to a survivor. */
  readonly pendingRemapped: number;
}

const EMPTY_RESULT: FoldWebPagesResult = Object.freeze({
  scanned: 0,
  folded: 0,
  deduped: 0,
  linksRemapped: 0,
  pendingRemapped: 0,
});

/**
 * Read the human-readable URL to re-normalize for a legacy doc. The `source_url`
 * column is the canonical store; `metadata.sourceUrl` is the fallback for any
 * row that never populated the column.
 */
function urlForDoc(row: LegacyDocRow): string | null {
  if (row.source_url && row.source_url.length > 0) return row.source_url;
  try {
    const meta = JSON.parse(row.metadata) as { sourceUrl?: unknown };
    if (typeof meta.sourceUrl === "string" && meta.sourceUrl.length > 0) return meta.sourceUrl;
  } catch {
    // Malformed metadata JSON — no fallback URL available.
  }
  return null;
}

/** Stamp the current web-page document type onto a metadata JSON blob. */
function stampMetadata(metadata: string): string {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    obj = {};
  }
  obj.documentType = WEB_DOCUMENT_TYPE;
  return JSON.stringify(obj);
}

/**
 * Fold all legacy `browser` web-page documents into the `web`
 * source, in place. Idempotent: a replay (no legacy rows left) is a no-op.
 *
 * Runs inside the caller's migration transaction — it neither opens nor commits
 * one. All FK references are remapped *before* a loser row is deleted, so the
 * `ON DELETE CASCADE` / `ON DELETE SET NULL` constraints on `document_links`
 * never silently drop or null a surviving edge.
 */
export function foldWebPagesIntoWebSource(db: Db): FoldWebPagesResult {
  const rows = db
    .prepare<
      [string],
      LegacyDocRow
    >("SELECT id, source_id, source_url, metadata, updated_at FROM documents WHERE source_id = ?")
    .all(LEGACY_BROWSER_SOURCE_ID);

  if (rows.length === 0) return EMPTY_RESULT;

  /**
   * Group legacy docs by their recomputed canonical external_id. A doc with no
   * recoverable URL keeps its own external_id (it cannot collide with another
   * row) and is folded standalone so no data is lost.
   */
  interface Folded {
    readonly row: LegacyDocRow;
    readonly externalId: string;
  }
  const groups = new Map<string, Folded[]>();
  for (const row of rows) {
    const url = urlForDoc(row);
    const externalId = url ? urlToExternalId(normalizeUrl(url)) : `legacy:${row.id}`;
    const group = groups.get(externalId);
    if (group) group.push({ row, externalId });
    else groups.set(externalId, [{ row, externalId }]);
  }

  const updateSurvivor = db.prepare<[string, string, string, string]>(
    `UPDATE documents
        SET provider_id = '${WEB_PROVIDER_ID}',
            source_id = '${WEB_SOURCE_ID}',
            external_id = ?,
            metadata = ?,
            updated_at = ?
      WHERE id = ?`,
  );
  const remapLinkSource = db.prepare<[string, string]>(
    "UPDATE OR IGNORE document_links SET source_doc_id = ? WHERE source_doc_id = ?",
  );
  const remapLinkTarget = db.prepare<[string, string]>(
    "UPDATE OR IGNORE document_links SET target_doc_id = ? WHERE target_doc_id = ?",
  );
  const remapPendingSource = db.prepare<[string, string]>(
    "UPDATE OR IGNORE pending_edges SET source_doc_id = ? WHERE source_doc_id = ?",
  );
  const countLinkSource = db.prepare<[string], { c: number }>(
    "SELECT COUNT(*) AS c FROM document_links WHERE source_doc_id = ?",
  );
  const countLinkTarget = db.prepare<[string], { c: number }>(
    "SELECT COUNT(*) AS c FROM document_links WHERE target_doc_id = ?",
  );
  const countPendingSource = db.prepare<[string], { c: number }>(
    "SELECT COUNT(*) AS c FROM pending_edges WHERE source_doc_id = ?",
  );
  const deleteDoc = db.prepare<[string]>("DELETE FROM documents WHERE id = ?");
  const nowIso = new Date().toISOString();

  let folded = 0;
  let deduped = 0;
  let linksRemapped = 0;
  let pendingRemapped = 0;

  for (const group of groups.values()) {
    // Two raw URL spellings can normalize to one identity. Keep the freshest.
    let survivor = group[0]!;
    for (const candidate of group.slice(1)) {
      if (candidate.row.updated_at > survivor.row.updated_at) survivor = candidate;
    }

    updateSurvivor.run(
      survivor.externalId,
      stampMetadata(survivor.row.metadata),
      nowIso,
      survivor.row.id,
    );
    folded += 1;

    for (const loser of group) {
      if (loser.row.id === survivor.row.id) continue;
      // Remap every edge endpoint onto the survivor BEFORE deleting the loser,
      // so the FK cascade never drops/nulls an edge that should survive.
      linksRemapped += countLinkSource.get(loser.row.id)!.c;
      remapLinkSource.run(survivor.row.id, loser.row.id);
      linksRemapped += countLinkTarget.get(loser.row.id)!.c;
      remapLinkTarget.run(survivor.row.id, loser.row.id);
      pendingRemapped += countPendingSource.get(loser.row.id)!.c;
      remapPendingSource.run(survivor.row.id, loser.row.id);
      deleteDoc.run(loser.row.id);
      deduped += 1;
    }
  }

  return {
    scanned: rows.length,
    folded,
    deduped,
    linksRemapped,
    pendingRemapped,
  };
}
