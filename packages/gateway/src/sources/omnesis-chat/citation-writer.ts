// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pre-resolved citation edges for omnesis-chat conversation documents.
 *
 * Each annotation the agent makes via the `annotate` tool becomes a
 * `document_links` row pointing from the conversation document to the
 * cited document. Unlike the URL-derived edges populated by
 * `LinkExtraction`, these arrive with `target_doc_id` already known —
 * the agent passes the docId directly — so the resolver pipeline can
 * skip them entirely.
 *
 * The per-edge quote / quoteAuthor / note payload is stored as JSON in
 * `document_links.metadata_json` (added in schema v11). Consumers
 * rendering a citation edge can read the column without re-loading the
 * source conversation transcript.
 *
 * Two citation variants share this `'cited'` edge path:
 *   - a **document** citation (the `annotate` tool) — `target_doc_id` is the
 *     cited doc, `normalized_target` is `omnesis://doc/<id>#<idx>`.
 *   - a **record** citation (the `cite_record` tool) — one analytics row;
 *     `target_doc_id` is the row's bound document when one exists or `NULL`,
 *     `normalized_target` is `omnesis://row/<table>/<encodedPk>#<idx>` (built
 *     from the `recordKey`) so it never collides with a document citation, and
 *     `metadata_json` carries a `kind:'record'` discriminator + the immutable
 *     row snapshot + semantic time + table/PK identity + derived title/fields.
 * The row-vs-doc distinction lives in `metadata_json`, so no schema migration
 * is forced.
 *
 * Idempotency: each replace is a full sweep + insert for the given
 * (sourceDocId, link_type='cited') pair. The agent can re-cite the same doc or
 * row multiple times in one conversation; each citation gets its own row
 * because `normalized_target` is uniqueified with an index (`#<index>`)
 * appended. Re-running the upsert over the same conversation reproduces the
 * identical edge set (no duplicate/destroyed edges) — the idempotence oracle.
 */

import { analyticsRowKey } from "@omnesis/core";
import { markLinkStatsDirty } from "../../data/DirtyMarks.js";
import type { LinkType } from "@omnesis/core";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** The `document_links.link_type` for agent-authored citation edges. */
export const CONVERSATION_CITATION_LINK_TYPE: LinkType = "cited";

/**
 * Provenance origin recorded on `cited` edges. Identifies the agent
 * annotator that authored the citation; bumping the version would invalidate
 * a generation's citations for re-derivation.
 */
const CITATION_PROVENANCE_ORIGIN = "agent-citation-v1";

/**
 * A document citation (the `annotate` tool) — the agent marked an unstructured
 * document that informed its answer. `kind` is optional and defaults to
 * `"document"` so existing callers stay source-compatible.
 */
export interface ConversationDocumentCitationInput {
  kind?: "document";
  /** Document id of the cited target — already resolved. */
  targetDocId: string;
  /** Verbatim excerpt the agent pulled from the target. */
  quote?: string;
  /** First name of the quote's author when applicable. */
  quoteAuthor?: string;
  /** One-line "why this matters" caption the agent recorded. */
  note?: string;
}

/** One labelled key field surfaced on a record citation (derived, redacted). */
export interface RecordCitationKeyField {
  label: string;
  value: string | number | boolean | null;
}

/**
 * A record citation (the `cite_record` tool) — one analytics row the
 * agent cited as a point-in-time record. Carries the immutable, gateway-derived
 * snapshot + identity; `boundDocumentId` is the co-described document when one
 * exists (becomes `target_doc_id`) or `null` (a record with no bound document
 * still renders, just without a deep link).
 */
export interface ConversationRecordCitationInput {
  kind: "record";
  /** DuckDB table the cited row lives in. */
  table: string;
  /** `analyticsRowKey(table, pk…)` — synthesises `normalized_target`. */
  recordKey: string;
  /** The typed primary-key columns addressing the row, in declared order. */
  primaryKeyColumns: { name: string; value: string; castType?: string }[];
  /** Derived human title (never empty). */
  title: string;
  /** Key fields surfaced in the drawer (label + redacted value), in order. */
  keyFields: RecordCitationKeyField[];
  /** The row's declared semantic time (always present for a record citation). */
  semanticTime: string;
  /** Immutable row snapshot, sensitive columns already redacted. */
  snapshot: Record<string, string | number | boolean | null>;
  /** Catalog source id that owns the table. */
  sourceId: string;
  /** Bare source type derived from `sourceId`. */
  sourceType: string;
  /** Human table name from the analytics catalog. */
  tableDisplayName: string;
  /** Co-described document id when the row binds one, else `null`. */
  boundDocumentId: string | null;
}

export type ConversationCitationInput =
  | ConversationDocumentCitationInput
  | ConversationRecordCitationInput;

export interface UpsertConversationCitationsResult {
  /** Number of rows wiped from the previous edge set. */
  removed: number;
  /** Number of rows written in the new edge set. */
  inserted: number;
}

/**
 * Replace every `link_type='cited'` edge originating from `sourceDocId`
 * with the supplied set. Pure write — no resolution, no normalization
 * because every target is already a known docId.
 *
 * Each citation's `raw_target` and `normalized_target` are synthesized
 * as `omnesis://doc/<targetDocId>#<annotationIndex>`. The hash suffix
 * disambiguates multiple annotations on the same target so the
 * `UNIQUE(source_doc_id, link_type, normalized_target)` constraint
 * accepts every annotation as its own row instead of folding them.
 */
export function upsertConversationCitations(
  db: Db,
  sourceDocId: string,
  citations: ReadonlyArray<ConversationCitationInput>,
): UpsertConversationCitationsResult {
  const now = new Date().toISOString();
  const deleteStmt = db.prepare(
    "DELETE FROM document_links WHERE source_doc_id = ? AND link_type = ?",
  );
  const insertStmt = db.prepare(`
    INSERT INTO document_links
      (source_doc_id, link_type, raw_target, normalized_target, target_doc_id,
       resolved_at, created_at, metadata_json, provenance_kind, provenance_origin,
       provenance_version, declared_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'llm-derived', ?, NULL, ?)
  `);

  const txn = db.transaction(() => {
    const deleted = deleteStmt.run(sourceDocId, CONVERSATION_CITATION_LINK_TYPE);
    const removed = Number(deleted.changes ?? 0);
    let inserted = 0;
    citations.forEach((c, idx) => {
      const target = `${citationTargetBase(c)}#${idx}`;
      const targetDocId = c.kind === "record" ? c.boundDocumentId : c.targetDocId;
      const meta = serializeMetadata(c);
      insertStmt.run(
        sourceDocId,
        CONVERSATION_CITATION_LINK_TYPE,
        target,
        target,
        targetDocId,
        now,
        now,
        meta,
        CITATION_PROVENANCE_ORIGIN,
        now,
      );
      inserted++;
    });
    if (removed > 0 || inserted > 0) markLinkStatsDirty(db);
    return { removed, inserted };
  });
  return txn();
}

/**
 * The (index-less) `normalized_target` base for a citation. A document
 * citation addresses its target doc; a record citation addresses the row's
 * `recordKey` under an `omnesis://row/...` scheme so it never collides with a
 * document citation — even when the record's `boundDocumentId` equals some
 * document citation's `targetDocId`.
 */
function citationTargetBase(c: ConversationCitationInput): string {
  if (c.kind === "record") {
    // `recordKey` is `row:<table>:<encodedPk>`; reshape to the citation URI
    // scheme. The `<encodedPk>` is already percent-encoded by `analyticsRowKey`.
    const expected = analyticsRowKey(c.table, "");
    const encodedPk = c.recordKey.startsWith(expected)
      ? c.recordKey.slice(expected.length)
      : c.recordKey;
    return `omnesis://row/${c.table}/${encodedPk}`;
  }
  return `omnesis://doc/${c.targetDocId}`;
}

function serializeMetadata(c: ConversationCitationInput): string | null {
  if (c.kind === "record") {
    return JSON.stringify({
      kind: "record",
      table: c.table,
      tableDisplayName: c.tableDisplayName,
      recordKey: c.recordKey,
      primaryKeyColumns: c.primaryKeyColumns,
      title: c.title,
      keyFields: c.keyFields,
      semanticTime: c.semanticTime,
      snapshot: c.snapshot,
      sourceId: c.sourceId,
      sourceType: c.sourceType,
      boundDocumentId: c.boundDocumentId,
    });
  }
  const out: Record<string, string> = {};
  if (c.quote !== undefined) out.quote = c.quote;
  if (c.quoteAuthor !== undefined) out.quoteAuthor = c.quoteAuthor;
  if (c.note !== undefined) out.note = c.note;
  if (Object.keys(out).length === 0) return null;
  return JSON.stringify(out);
}

/**
 * Look up the gateway-assigned `documents.id` for a `(providerId,
 * sourceId, externalId)` triple. Returns null when the row hasn't been
 * upserted yet — caller treats that as a no-op and re-tries on the next
 * upsert cycle.
 *
 * Exported because the conversation upsert path needs to know the row's
 * id after `upsertDocuments` ran (the id is generated by
 * `randomUUID()` inside the writer; the caller never sees it).
 */
export function findConversationDocId(
  db: Db,
  providerId: string,
  sourceId: string,
  externalId: string,
): string | null {
  const row = db
    .prepare<
      [string, string, string],
      { id: string }
    >("SELECT id FROM documents WHERE provider_id = ? AND source_id = ? AND external_id = ?")
    .get(providerId, sourceId, externalId);
  return row?.id ?? null;
}
