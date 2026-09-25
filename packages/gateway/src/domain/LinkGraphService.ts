// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { assertNever, countryNameToISO2, createLogger, extractPhonesFromText } from "@omnesis/core";
import { getKnownUrlPatternSources } from "../known-url-patterns.js";
import {
  getCachedSafeUrlPatternMatchers,
  type SafeUrlPatternMatcher,
} from "../known-url-pattern-safety.js";
import { markLinkStatsDirty } from "../data/DirtyMarks.js";
import { documentsMetadataCodec } from "../data/json-columns.js";
import { collectorRosterRevisionMatches } from "../collector-declaration-roster.js";
import { sourcePrefixPredicate } from "../data/source-addressing.js";
import {
  computeUrlOwnershipRepairs,
  extractIdFromUrl,
  resolveUrlLink,
  type LinkRetarget,
  type SameResourceUpdate,
} from "./UrlOwnershipReconciliation.js";
import type { ExtractedLink } from "@omnesis/core";

export {
  DIRECT_URL_OWNER_LOOKUP_SQL,
  OWNERSHIP_DOCUMENT_SCAN_SQL,
  OWNERSHIP_LINK_SCAN_SQL,
  PATTERN_OWNER_LOOKUP_SQL,
} from "./UrlOwnershipReconciliation.js";
export type { LinkRetarget, SameResourceUpdate } from "./UrlOwnershipReconciliation.js";

const log = createLogger("gateway:links");

const DUPLICATE_CONTENT_CAP = 100;
/**
 * Provenance origin recorded on `duplicate-content` edges — the algorithm that
 * produced them (extracted-content SHA-256 match). Bumping the version marks
 * these edges stale for a future re-derivation pass (provenance invalidation model).
 */
const DUPLICATE_CONTENT_PROVENANCE_ORIGIN = "extracted-content-hash-v1";
const SAME_RESOURCE_PROVENANCE_ORIGIN = "canonical-source-url-v1";

/**
 * Whether a url target matches the url-id pattern of *some known source
 * type* — registered (added) or not. The keep-decision for the unresolvable-url prune:
 * a link matching a known-but-not-yet-added source (e.g. a Notion URL
 * before Notion is added) must NOT be pruned, so it survives to resolve via
 * the reconcile path once that source is ingested. Registration is
 * irrelevant to the keep decision; it only matters for *resolution*, which
 * `extractIdFromUrl` handles separately (a not-yet-added source has no docs
 * to resolve against anyway).
 */
function urlTargetMatchesKnownSourceType(
  db: Db,
  normalizedTarget: string,
  knownUrlPatterns: ReadonlyArray<{ regex: SafeUrlPatternMatcher }>,
): boolean {
  if (extractIdFromUrl(db, normalizedTarget) !== null) return true;
  for (const pattern of knownUrlPatterns) {
    if (pattern.regex.test(normalizedTarget)) return true;
  }
  return false;
}

/**
 * When a new doc arrives, check if existing unresolved non-URL links point to it.
 *
 * URL target selection requires the complete descriptor-derived target roles,
 * which are held by the main process rather than this writer worker. The
 * periodic read-side reconciler owns URL resolution so reference-only
 * documents can never claim inbound URL edges just because they arrived first.
 */
export function resolveInboundLinks(
  db: Db,
  docId: string,
  _sourceUrl: string | null,
  sourceId: string,
  externalId: string,
): number {
  const now = new Date().toISOString();
  let resolved = 0;

  // 1. `references` match via external_id, title, or a declared link key
  //    (scoped to same source_id) — the same three names `resolveLink`
  //    resolves forward, so a link waiting on this document and one written
  //    after it reach it by the same rule.
  const arriving = db
    .prepare<
      [string],
      { title: string | null; metadata: string | null }
    >("SELECT title, metadata FROM documents WHERE id = ?")
    .get(docId);
  const names = new Set<string>([externalId.toLowerCase()]);
  if (arriving?.title) names.add(arriving.title.toLowerCase());
  if (arriving?.metadata) {
    const parsed = documentsMetadataCodec.parseWithFallback(arriving.metadata, {
      rowId: docId,
    }) as { extra?: { linkKeys?: unknown } };
    const keys = parsed?.extra?.linkKeys;
    if (Array.isArray(keys)) {
      for (const key of keys) if (typeof key === "string" && key) names.add(key.toLowerCase());
    }
  }

  // One statement per name, keyed on the exact target so it is served by the
  // partial unresolved-link index and then a primary-key lookup per match.
  // This runs on the writer for every arriving document; the `IN (SELECT id
  // FROM documents WHERE source_id = ?)` form walks the whole source instead,
  // which on a large mailbox is six figures of probes per document.
  const resolveReferencesTo = db.prepare(
    `UPDATE document_links SET target_doc_id = ?, resolved_at = ?
     WHERE normalized_target = ? AND target_doc_id IS NULL AND link_type = 'references'
       AND EXISTS (
         SELECT 1 FROM documents d
          WHERE d.id = document_links.source_doc_id AND d.source_id = ?
       )`,
  );
  for (const name of names) {
    resolved += resolveReferencesTo.run(docId, now, name, sourceId).changes;
  }

  // 2. `contains` (attachment) match via parentExternalId (scoped to same source_id)
  //    When a parent email arrives, resolve attachment docs' outbound links to it.
  const containsResult = db
    .prepare(
      `UPDATE document_links SET target_doc_id = ?, resolved_at = ?
     WHERE target_doc_id IS NULL AND link_type = 'contains'
       AND normalized_target = ?
       AND source_doc_id IN (SELECT id FROM documents WHERE source_id = ?)`,
    )
    .run(docId, now, externalId, sourceId);
  resolved += containsResult.changes;

  // 4. `part-of-thread` match via threadId/conversationId in metadata (scoped to same source_id)
  const meta = db
    .prepare<[string], { metadata: string }>("SELECT metadata FROM documents WHERE id = ?")
    .get(docId);

  let documentPhoneRegion: string | undefined;
  if (meta) {
    const parsed = documentsMetadataCodec.parseWithFallback(meta.metadata, { rowId: docId }) as {
      extra?: { threadId?: unknown; conversationId?: unknown; iCalUID?: unknown };
      ingestionContext?: { phoneRegion?: string };
    };
    documentPhoneRegion = parsed.ingestionContext?.phoneRegion;
    const threadId = parsed?.extra?.threadId ?? parsed?.extra?.conversationId;
    if (typeof threadId === "string") {
      const threadResult = db
        .prepare(
          `UPDATE document_links SET target_doc_id = ?, resolved_at = ?
         WHERE target_doc_id IS NULL AND link_type = 'part-of-thread'
           AND normalized_target = ?
           AND source_doc_id IN (SELECT id FROM documents WHERE source_id = ?)
           AND source_doc_id != ?`,
        )
        .run(docId, now, threadId, sourceId, docId);
      resolved += threadResult.changes;
    }

    // 5. Calendar-event match via iCalUID. Cross-source by
    // design — an ICS attachment from outlook-email links to the
    // matching event in google-calendar (or, in future, any other
    // calendar-source). No same-source scoping clause.
    const iCalUID = parsed?.extra?.iCalUID;
    if (typeof iCalUID === "string" && iCalUID.length > 0) {
      const calResult = db
        .prepare(
          `UPDATE document_links SET target_doc_id = ?, resolved_at = ?
         WHERE target_doc_id IS NULL AND link_type = 'calendar-event'
           AND normalized_target = ?
           AND source_doc_id != ?`,
        )
        .run(docId, now, iCalUID, docId);
      resolved += calResult.changes;
    }
  }

  // 6. Shared-phone match: a document already
  // waiting to resolve a `shares-phone` link (some earlier document
  // mentioned a phone number nothing else had mentioned yet) resolves now if
  // THIS new document's content mentions that same phone. Re-extracts from
  // the new doc's own content rather than reading its already-inserted
  // `document_links` rows, so this doesn't depend on insert ordering
  // relative to this doc's own outbound extraction. No same-source scoping
  // — cross-source by design, like `calendar-event`.
  const content = db
    .prepare<[string], { content: string }>("SELECT content FROM documents WHERE id = ?")
    .get(docId)?.content;
  if (content) {
    const phones = extractPhonesFromText(content, countryNameToISO2(documentPhoneRegion));
    if (phones.length > 0) {
      const phoneStmt = db.prepare(
        `UPDATE document_links SET target_doc_id = ?, resolved_at = ?
         WHERE target_doc_id IS NULL AND link_type = 'shares-phone'
           AND normalized_target = ? AND source_doc_id != ?`,
      );
      for (const phone of phones) {
        const phoneResult = phoneStmt.run(docId, now, phone, docId);
        resolved += phoneResult.changes;
      }
    }
  }

  // Resolution shifts the resolved count in `link_stats`. Bump once
  // per call regardless of which sub-update fired — cheap UPDATE; the
  // OCC token in `upsertLinkStats` does the rest.
  if (resolved > 0) {
    markLinkStatsDirty(db);
  }
  return resolved;
}

/**
 * Document types whose content originates from binary file bytes (extracted
 * via the shared attachment pipeline) and that are eligible for
 * `duplicate-content` cross-linking. Authored content like emails, notes,
 * messages, contacts, etc. is intentionally OUT of scope — those tend to
 * have legitimate non-duplicate identical bodies (mailing-list resends,
 * recurring templates) that would clutter the graph.
 */
const BINARY_EXTRACTED_DOC_TYPES = ["attachment", "file"] as const;
const BINARY_EXTRACTED_DOC_TYPES_SET = new Set<string>(BINARY_EXTRACTED_DOC_TYPES);

/**
 * Emit `duplicate-content` outbound links from the just-upserted
 * binary-extracted doc to every other binary-extracted doc with the same
 * `extracted_content_hash`. The reverse direction is automatically visible
 * via the standard inbound lookup, so we only insert one row per pair (this
 * doc → other).
 *
 * Scope: documents whose body comes from extracted file bytes — Gmail /
 * Outlook / iMessage / WhatsApp `attachment` docs AND Google Drive `file`
 * docs. The dedup key is `extracted_content_hash` (raw extracted text)
 * rather than `content_hash` (rendered display content) so a Drive PDF
 * (whose `content` is wrapped with a markdown header) and the same PDF
 * attached to an email (whose `content` is the raw text) match — the
 * wrapped/unwrapped split made the old `content_hash`-keyed lookup miss
 * cross-source pairs.
 *
 * Limit: caps at 100 matches per call to bound runtime + link-table growth
 * for pathological cases (e.g. an empty PDF whose extracted text is
 * literally `""` would otherwise link every other empty-text doc).
 */
export function linkDuplicateContentDocs(
  db: Db,
  docId: string,
  extractedContentHash: string | undefined,
  documentType: string | undefined,
): number {
  if (!documentType || !BINARY_EXTRACTED_DOC_TYPES_SET.has(documentType)) return 0;
  if (!extractedContentHash) return 0;

  // The IN list is fixed at module load; inline as a literal so SQLite can
  // use the partial index. Keep in sync with `BINARY_EXTRACTED_DOC_TYPES`
  // and the matching `idx_documents_attachment_content_hash` partial-index
  // predicate in `data/schema.ts`.
  const otherDocs = db
    .prepare<[string, string, number], { id: string }>(
      `SELECT id FROM documents
        WHERE extracted_content_hash = ?
          AND id != ?
          AND json_extract(metadata, '$.documentType') IN ('attachment', 'file')
        LIMIT ?`,
    )
    .all(extractedContentHash, docId, DUPLICATE_CONTENT_CAP);

  if (otherDocs.length === DUPLICATE_CONTENT_CAP) {
    log.warn(
      `linkDuplicateContentDocs: cap hit at ${DUPLICATE_CONTENT_CAP} for doc ${docId} (hash ${extractedContentHash.slice(0, 12)}…); siblings beyond the cap won't be cross-linked until they're re-extracted`,
    );
  }

  if (otherDocs.length === 0) return 0;

  const now = new Date().toISOString();
  // The link table's UNIQUE index is `(source_doc_id, link_type,
  // normalized_target)`. Naively using the hash as normalized_target
  // would let us emit only ONE duplicate-content link per source doc — but
  // a single attachment can legitimately match multiple others. So we key
  // normalized_target on the target's doc id (one row per directed pair),
  // and keep the hash as raw_target for diagnostic visibility.
  const insertStmt = db.prepare(
    `INSERT INTO document_links
       (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at, provenance_kind, provenance_origin, provenance_version, declared_at)
     VALUES (?, 'duplicate-content', ?, ?, ?, ?, ?, 'cross-source-derived', ?, NULL, ?)
     ON CONFLICT(source_doc_id, link_type, normalized_target) DO UPDATE SET
       target_doc_id = excluded.target_doc_id,
       resolved_at = excluded.resolved_at`,
  );

  let inserted = 0;
  for (const other of otherDocs) {
    insertStmt.run(
      docId,
      extractedContentHash,
      other.id,
      other.id,
      now,
      now,
      DUPLICATE_CONTENT_PROVENANCE_ORIGIN,
      now,
    );
    inserted += 1;
  }
  if (inserted > 0) markLinkStatsDirty(db);
  return inserted;
}

/**
 * Resolve a single link to a target document.
 *
 * Exported because resolution happens away from where links are written:
 * the batch pipeline resolves on a read handle (`resolveExtractedLinks`),
 * the single-document path resolves inline (`processDocumentLinks`), and
 * the periodic reconcile re-tries whatever is still unresolved. All three
 * dispatch through here, so one link type means the same thing whichever
 * path reaches it.
 */
export function resolveLink(
  db: Db,
  link: ExtractedLink,
  sourceSourceId: string,
  sourceDocId: string,
  fallbackRepresentationSourcePrefixes: readonly string[],
  referenceOnlySourcePrefixes: readonly string[] = [],
): { docId: string } | null {
  const type = link.type;
  switch (type) {
    case "url":
      return resolveUrlLink(
        db,
        link.normalizedTarget,
        fallbackRepresentationSourcePrefixes,
        referenceOnlySourcePrefixes,
      );
    case "references":
      return resolveReferencesLink(db, link.normalizedTarget, sourceSourceId);
    case "part-of-thread":
      return resolvePartOfThreadLink(db, link.normalizedTarget, sourceSourceId, sourceDocId);
    case "contains":
      return resolveContainsLink(db, link.normalizedTarget, sourceSourceId);
    case "calendar-event":
      return resolveCalendarEventLink(db, link.normalizedTarget, sourceDocId);
    case "shares-phone":
      return resolveSharesPhoneLink(db, link.normalizedTarget, sourceDocId);
    case "replies-to":
    case "succeeds":
    case "accompanies":
    case "bookmarks":
    case "visited":
    case "duplicate-content":
    case "same-resource":
    case "cited":
      return null;
    default:
      return assertNever(type);
  }
}

/**
 * Resolve a `shares-phone` link: find another document that ALSO extracted
 * this same normalized phone number from its content (i.e. it has its own
 * `document_links` row of the same type + target). Cross-source by design —
 * a call-log day-document and an email/webpage sharing a phone number
 * resolve regardless of source.
 *
 * Like `resolveUrlLink`, this picks a single target (`LIMIT 1`) even though
 * more than one other document could share the phone — the schema's
 * `UNIQUE(source_doc_id, link_type, normalized_target)` constraint means one
 * source row can only carry one target. A phone mentioned across many
 * documents (a shared support line) still resolves cheaply for every one of
 * them (each is an independent indexed lookup), it just doesn't create a
 * fully-connected mesh — the same accepted simplification `url` links make.
 */
function resolveSharesPhoneLink(
  db: Db,
  normalizedTarget: string,
  sourceDocId: string,
): { docId: string } | null {
  const row = db
    .prepare<[string, string], { source_doc_id: string }>(
      `SELECT source_doc_id FROM document_links
       WHERE link_type = 'shares-phone' AND normalized_target = ? AND source_doc_id != ?
       LIMIT 1`,
    )
    .get(normalizedTarget, sourceDocId);
  return row ? { docId: row.source_doc_id } : null;
}

/**
 * Resolve an `iCalUID` to the calendar event document carrying it.
 * Cross-source by design — an ICS attachment from `outlook-email:...`
 * resolves to a `google-calendar:...` event with the matching UID. The
 * event source must populate `metadata.extra.iCalUID` (Google Calendar
 * and Apple Calendar do this).
 */
function resolveCalendarEventLink(
  db: Db,
  iCalUID: string,
  sourceDocId: string,
): { docId: string } | null {
  const row = db
    .prepare<[string, string], { id: string }>(
      `SELECT id FROM documents
        WHERE json_extract(metadata, '$.extra.iCalUID') = ?
          AND id != ?
        LIMIT 1`,
    )
    .get(iCalUID, sourceDocId);
  return row ? { docId: row.id } : null;
}

/**
 * Resolve a `references` link within its own source. A target answers to its
 * external id, its title, or any name it declares in `metadata.extra.linkKeys`
 * — the last is how a document is reachable by a name that is neither, such as
 * the folder-qualified path an Obsidian note is linked by when its bare name
 * is ambiguous.
 *
 * Declared keys are consulted only when the id and title found nothing, so the
 * common case pays for no JSON.
 */
function resolveReferencesLink(
  db: Db,
  normalizedTarget: string,
  sourceId: string,
): { docId: string } | null {
  const byName = db
    .prepare<[string, string, string], { id: string }>(
      `SELECT id FROM documents
       WHERE source_id = ? AND (LOWER(external_id) = ? OR LOWER(title) = ?)
       LIMIT 1`,
    )
    .get(sourceId, normalizedTarget, normalizedTarget);
  if (byName) return { docId: byName.id };
  const byKey = db
    .prepare<[string, string], { id: string }>(
      `SELECT id FROM documents
       WHERE source_id = ?
         AND EXISTS (
           SELECT 1 FROM json_each(metadata, '$.extra.linkKeys')
            WHERE json_each.type = 'text' AND LOWER(json_each.value) = ?
         )
       LIMIT 1`,
    )
    .get(sourceId, normalizedTarget);
  return byKey ? { docId: byKey.id } : null;
}

/**
 * Resolve a `contains` (attachment) link: match parentExternalId against
 * external_id within the same source_id.
 */
function resolveContainsLink(
  db: Db,
  parentExternalId: string,
  sourceId: string,
): { docId: string } | null {
  const row = db
    .prepare<[string, string], { id: string }>(
      `SELECT id FROM documents
       WHERE external_id = ? AND source_id = ?
       LIMIT 1`,
    )
    .get(parentExternalId, sourceId);
  return row ? { docId: row.id } : null;
}

/**
 * Where a document sits in the containment convention: on its own, inside
 * another document, or pointing at a container the corpus does not hold.
 */
export type DocumentContainment =
  /** The document declares no container — it stands on its own. */
  | { kind: "standalone" }
  /** The document is a part of `parentDocumentId` (an attachment of it). */
  | { kind: "contained"; parentDocumentId: string }
  /** The document declares a container that is not in the corpus. */
  | { kind: "orphan" };

/**
 * Resolve the document that `documentId` is a part of.
 *
 * Sources that split a record into an owning document plus the attachments
 * extracted from it declare the relationship with the cross-source
 * `metadata.extra.parentExternalId` convention; this runs the same
 * `parentExternalId` → `external_id` lookup, scoped to the same source, that
 * turns the convention into a `contains` edge. Reading the convention
 * directly rather than the materialised `document_links` row means the
 * answer does not depend on link extraction having caught up with the
 * document.
 *
 * Resolution is one level deep. The convention describes an owning record
 * and the parts pulled out of it, never a chain of parts.
 */
export function resolveContainingDocument(db: Db, documentId: string): DocumentContainment {
  const row = db
    .prepare<
      [string],
      { external_id: string; source_id: string; metadata: string }
    >(`SELECT external_id, source_id, metadata FROM documents WHERE id = ?`)
    .get(documentId);
  if (!row) return { kind: "standalone" };
  const metadata = documentsMetadataCodec.parseWithFallback(row.metadata, {
    rowId: documentId,
  }) as { extra?: { parentExternalId?: unknown } };
  const parentExternalId = metadata.extra?.parentExternalId;
  // The same guards `extractLinks` applies before emitting a `contains` edge:
  // a non-string, empty, or self-referential value declares no container.
  if (
    typeof parentExternalId !== "string" ||
    parentExternalId.length === 0 ||
    parentExternalId === row.external_id
  ) {
    return { kind: "standalone" };
  }
  const parent = resolveContainsLink(db, parentExternalId, row.source_id);
  return parent ? { kind: "contained", parentDocumentId: parent.docId } : { kind: "orphan" };
}

function resolvePartOfThreadLink(
  db: Db,
  normalizedTarget: string,
  sourceId: string,
  sourceDocId: string,
): { docId: string } | null {
  const row = db
    .prepare<[string, string, string, string], { id: string }>(
      `SELECT id FROM documents
       WHERE (json_extract(metadata, '$.extra.threadId') = ?
              OR json_extract(metadata, '$.extra.conversationId') = ?)
         AND source_id = ?
         AND id != ?
       LIMIT 1`,
    )
    .get(normalizedTarget, normalizedTarget, sourceId, sourceDocId);
  return row ? { docId: row.id } : null;
}

/**
 * One row in the result of `computeLinkResolutions`. `targetDocId` is
 * the doc this unresolved link now resolves to, or null if it still
 * can't be resolved (caller may choose to skip null rows).
 */
export interface LinkResolution {
  linkId: number;
  targetDocId: string | null;
}

/**
 * One periodic-reconcile batch as seen by the writer. Carries both the
 * per-row resolutions and the cursor advancement signal:
 * `scannedMaxId` is the largest `document_links.id` the compute pass
 * inspected (0 if the scan returned no rows). The writer-side
 * `upsertLinkResolutions` interprets `scannedMaxId === 0` as "we ran
 * past the tail of the unresolved range" and wraps the cursor back to
 * 0, incrementing `link_reconcile_state.cycle_count`.
 */
export interface LinkReconcileBatch {
  resolutions: LinkResolution[];
  /** Resolved URL links whose historical target is no longer preferred. */
  retargets?: LinkRetarget[];
  sameResourceUpdates?: SameResourceUpdate[];
  ownershipLinkScannedMaxId?: number;
  ownershipLinkCycleMaxId?: number;
  ownershipDocumentScannedMaxRowid?: number;
  ownershipDocumentCycleMaxRowid?: number;
  scannedMaxId: number;
  urlCycleMaxId?: number;
  /**
   * Ids of links that can never resolve, for the writer to delete: unresolved
   * `url` links the cursor scan visited whose target neither matches a
   * `source_url` now nor any registered url-id pattern later, and
   * `duplicate-content` edges whose other copy was deleted. Empty on most
   * ticks once the historical backlog is drained — new such url links are
   * dropped at extraction by `urlTargetCouldResolve`.
   */
  deletableLinkIds: number[];
  /** Roster snapshot that made destructive URL decisions safe to compute. */
  expectedCollectorRosterRevision?: number;
}

/**
 * Read the periodic-reconcile cursor. Singleton row keyed on id=1.
 * Returns 0 if the row is missing — defensive; schema setup seeds it
 * on fresh installs, and the row is recreated by `runSchemaSetup`
 * idempotently on every boot.
 */
function readReconcileCursor(db: Db): { cursor: number; cycleMaxId: number } {
  const row = db
    .prepare<
      [],
      { cursor: number; url_cycle_max_id: number }
    >("SELECT cursor, url_cycle_max_id FROM link_reconcile_state WHERE id = 1")
    .get();
  return { cursor: row?.cursor ?? 0, cycleMaxId: row?.url_cycle_max_id ?? 0 };
}

/**
 * Per-tick budget for the non-URL plain scan. Non-URL link types are
 * resolved as they are extracted, on the read handle
 * (`resolveExtractedLinks`); the residual unresolved set is therefore
 * dominated by "target doc hasn't been ingested yet" cases and is small
 * in practice. A small constant keeps the URL backlog dominant in the
 * cursor budget — the URL scan gets the entire caller-supplied limit.
 */
const NON_URL_SCAN_LIMIT = 50;

/**
 * Hard ceiling on how many unresolved url links the direct safety-net scan
 * (3) may examine per tick.
 *
 * Below the ceiling the scan sees the entire unresolved set each tick and
 * a link resolves as soon as its target exists, which is the property it
 * is here for. Above it the scan sees a prefix — the index it drives from
 * is ordered by `normalized_target`, so a resolvable link sorting after
 * that many unresolvable ones waits for the cursor scan (1) to reach it
 * instead. That is slower, not wrong, and it is the deliberate trade: a
 * backlog large enough to exceed this degrades the tick's latency rather
 * than the gateway's.
 */
const DIRECT_SCAN_EXAMINE_LIMIT = 20_000;

/**
 * The direct safety-net scan (3) of `computeLinkResolutions`, exported so a
 * test can hold its query plan to the shape the bound depends on: driven
 * from the unresolved-link index, probing `documents` by `source_url`. A
 * plan that scans `documents` instead still returns correct rows, which is
 * why this needs a guard and not just a result assertion — that shape is
 * what cost the io worker whole minutes per tick.
 */
function directResolvableScanSql(referencePredicate: string): string {
  return `SELECT dl.id AS link_id, dl.normalized_target
         FROM (SELECT id, normalized_target
                 FROM document_links INDEXED BY idx_document_links_unresolved
                WHERE target_doc_id IS NULL
                  AND link_type = 'url'
                LIMIT ?) AS dl
        WHERE EXISTS (
          SELECT 1 FROM documents d
           WHERE d.source_url = dl.normalized_target
             AND NOT (${referencePredicate})
          LIMIT 1
        )
        LIMIT ?`;
}

export const DIRECT_RESOLVABLE_SCAN_SQL = directResolvableScanSql("0");

interface UnresolvedRow {
  id: number;
  source_doc_id: string;
  link_type: string;
  normalized_target: string;
}

/**
 * Map a batch of unresolved-link rows to `LinkResolution`s via
 * `resolveLink`. Caches `source_id` lookups within the batch so
 * multiple links sharing a `source_doc_id` only pay one PK lookup.
 * Pure read — no UPDATEs.
 */
function resolveRowsToResolutions(
  db: Db,
  rows: ReadonlyArray<UnresolvedRow>,
  fallbackRepresentationSourcePrefixes: readonly string[],
  referenceOnlySourcePrefixes: readonly string[],
): LinkResolution[] {
  const knownTypes: Record<ExtractedLink["type"], true> = {
    url: true,
    references: true,
    contains: true,
    "part-of-thread": true,
    "replies-to": true,
    succeeds: true,
    accompanies: true,
    bookmarks: true,
    visited: true,
    "duplicate-content": true,
    "same-resource": true,
    "calendar-event": true,
    "shares-phone": true,
    cited: true,
  };
  const sourceIdCache = new Map<string, string>();
  const lookupSourceId = (docId: string): string | null => {
    if (sourceIdCache.has(docId)) return sourceIdCache.get(docId)!;
    const row = db
      .prepare<[string], { source_id: string }>("SELECT source_id FROM documents WHERE id = ?")
      .get(docId);
    if (row) {
      sourceIdCache.set(docId, row.source_id);
      return row.source_id;
    }
    return null;
  };

  const out: LinkResolution[] = [];
  for (const row of rows) {
    if (!(row.link_type in knownTypes)) {
      out.push({ linkId: row.id, targetDocId: null });
      continue;
    }
    const sourceId = lookupSourceId(row.source_doc_id);
    if (!sourceId) {
      // Source doc vanished between scan and lookup; nothing to do.
      out.push({ linkId: row.id, targetDocId: null });
      continue;
    }
    const link: ExtractedLink = {
      type: row.link_type as ExtractedLink["type"],
      rawTarget: row.normalized_target,
      normalizedTarget: row.normalized_target,
    };
    const target = resolveLink(
      db,
      link,
      sourceId,
      row.source_doc_id,
      fallbackRepresentationSourcePrefixes,
      referenceOnlySourcePrefixes,
    );
    out.push({ linkId: row.id, targetDocId: target?.docId ?? null });
  }
  return out;
}

/**
 * Pure-read companion to `upsertLinkResolutions`. Runs five bounded scans:
 *
 *  1. **URL cursor scan.** Reads up to `limit` rows whose
 *     `link_type = 'url'` and `id > cursor`. URL links have no
 *     inline-resolve-on-extract path (the unresolvable external-URL
 *     volume can dwarf the new-link rate, so eager resolution would
 *     waste writer cycles on links that will never resolve). The
 *     cursor makes the periodic pass advance row-by-row across the
 *     full backlog; on an empty scan the writer wraps the cursor to 0
 *     and bumps `cycle_count`. This scan covers BOTH url resolution
 *     strategies (direct `source_url` match AND url-pattern →
 *     `external_id`), so pattern matches the direct scan (3) can't
 *     express still resolve here.
 *
 *  2. **Non-URL scan, no cursor.** Reads up to `NON_URL_SCAN_LIMIT`
 *     unresolved rows excluding `url` and derived `same-resource` edges.
 *     Every remaining non-URL type is eagerly
 *     resolved at extraction time, so the residual unresolved set is
 *     small and dominated by "target doc hasn't been ingested yet"
 *     cases, plus the first document to claim a given phone number
 *     (`shares-phone` pairs are directional — the claimant resolves
 *     once a second document mentions the same number). The plain
 *     re-scan every tick (~5 min) is the safety net for both.
 *
 *  3. **Resolvable-URL direct scan.** An indexed join of unresolved
 *     `url` links against `documents.source_url`, finding the links
 *     that ARE resolvable right now regardless of where they sit
 *     relative to the cursor. Without this, a URL pointing at an
 *     already-ingested doc waits for scan (1) to walk the entire
 *     external-URL backlog before its cursor reaches it — days on a
 *     large corpus. The join returns the target id directly, so these
 *     resolve without a per-row `resolveLink` call. URL resolutions
 *     from (1) and (3) are deduped and capped at `limit` together so
 *     the direct scan never inflates the per-tick batch budget.
 *
 *  4. **Resolved-URL ownership repair.** Walks a persisted row-id cursor
 *     across raw link rows, examining at most a fixed window per tick. URL
 *     edges aimed at a declared fallback representation are retargeted when a
 *     non-fallback document claims the same canonical `source_url`. Traversal
 *     hubs are unrelated. A cycle-start high-water mark guarantees the cursor
 *     wraps even while new links keep arriving.
 *
 *  5. **Representation repair.** Walks an independent persisted row-id
 *     cursor across raw document rows. Fallback captures and non-fallback
 *     owners that claim the same URL receive a `same-resource` edge even if no
 *     third document links to either one; stale edges are removed or healed.
 *     This cursor has its own cycle high-water mark for the same moving-tail bound.
 *
 * The returned `scannedMaxId` reflects only the cursor scan (1) — the
 * cursor is a URL-backlog progression concept and is independent of (3).
 *
 * Designed to run on a read-only handle (IO worker) so the
 * SELECT-heavy resolution doesn't park the writer. Pure SELECTs, no
 * transaction, no UPDATE. Rows that still can't be resolved are
 * returned with `targetDocId: null`.
 */
export function computeLinkResolutions(
  db: Db,
  limit: number = 50,
  fallbackRepresentationSourcePrefixes: readonly string[] = [],
  referenceOnlySourcePrefixes: readonly string[] = [],
  urlTargetRolesReady = true,
  knownUrlPatternSources: readonly string[] = getKnownUrlPatternSources(),
  knownUrlPatternDeclarationReady = true,
  expectedCollectorRosterRevision?: number,
): LinkReconcileBatch {
  if (limit <= 0) {
    return {
      resolutions: [],
      retargets: [],
      scannedMaxId: 0,
      deletableLinkIds: [],
      expectedCollectorRosterRevision,
    };
  }
  const cursorState = readReconcileCursor(db);
  const urlCycleMaxId = !urlTargetRolesReady
    ? undefined
    : cursorState.cycleMaxId > 0
      ? cursorState.cycleMaxId
      : (db
          .prepare<
            [],
            { maxId: number }
          >("SELECT COALESCE(MAX(id), 0) AS maxId FROM document_links")
          .get()?.maxId ?? 0);
  const knownUrlPatterns = getCachedSafeUrlPatternMatchers(knownUrlPatternSources);
  // (1) URL cursor scan — fair-share progression across the full
  // unresolved-URL backlog, carrying the reconcile cursor (see
  // `scannedMaxId` below). Covers both URL resolution strategies
  // (source_url match + url-pattern → external_id), so url-pattern
  // matches that the direct scan (3) can't express still resolve here.
  const urlRows = !urlTargetRolesReady
    ? []
    : db
        .prepare<[number, number, number], UnresolvedRow>(
          `SELECT id, source_doc_id, link_type, normalized_target
         FROM document_links
        WHERE link_type = 'url' AND target_doc_id IS NULL AND id > ? AND id <= ?
        ORDER BY id
        LIMIT ?`,
        )
        .all(cursorState.cursor, urlCycleMaxId ?? 0, limit);

  // (2) Non-URL scan runs every tick (no cursor). Bounded by a small
  // constant so it can't crowd out the URL budget on a pathologically
  // large non-URL backlog.
  const nonUrlRows = db
    .prepare<[number], UnresolvedRow>(
      `SELECT id, source_doc_id, link_type, normalized_target
         FROM document_links
        WHERE link_type NOT IN ('url', 'same-resource') AND target_doc_id IS NULL
        LIMIT ?`,
    )
    .all(NON_URL_SCAN_LIMIT);

  // (3) Resolvable-URL direct scan — unresolved `url` links whose
  // `normalized_target` already equals an indexed doc's `source_url`.
  // The join yields the target id directly, so these need no per-row
  // re-resolution. This is the fast path: a URL that points at an
  // already-ingested document resolves on the next reconcile tick
  // instead of waiting for the cursor (1) to walk the entire
  // mostly-unresolvable external-URL backlog — which is days on a large
  // corpus.
  //
  // This is a SAFETY NET, not a normal path. A link extracted after its
  // target exists resolves on the read handle at extraction time
  // (`resolveExtractedLinks`). What survives is a link whose target
  // arrived later, or one left behind by an older build. It is bounded so
  // keeping that eventual-healing path costs little in steady state.
  //
  // It is driven from the UNRESOLVED-LINK side and probes
  // `idx_documents_source_url`. That direction matters: `LIMIT` bounds
  // matches returned, not rows examined, so a scan driven from `documents`
  // pays one pass over the whole corpus precisely when there is nothing to
  // find — which, since permanently-unresolvable external URLs are pruned
  // and links resolve as they are extracted, is the steady
  // state. Driven from the links, the unresolved set is the small side.
  // Both bounds here are explicit: at most
  // `DIRECT_SCAN_EXAMINE_LIMIT` links are examined, each by one indexed
  // point lookup, and at most `limit` matches are returned.
  //
  // Covers only the direct `source_url` strategy — url-pattern →
  // external_id matches (strategy 2 of `resolveUrlLink`) resolve via the
  // cursor scan (1). A few documents can share a `source_url`; the dedup
  // below collapses each link to one target, matching `resolveUrlLink`'s
  // `LIMIT 1`.
  const directReferencePredicate = sourcePrefixPredicate(
    "d.source_id",
    referenceOnlySourcePrefixes,
  );
  const directRows = !urlTargetRolesReady
    ? []
    : db
        .prepare<
          unknown[],
          { link_id: number; normalized_target: string }
        >(directResolvableScanSql(directReferencePredicate.sql))
        .all(DIRECT_SCAN_EXAMINE_LIMIT, ...directReferencePredicate.params, limit);

  // (4) Historical URL ownership repair. The collaborator performs both
  // bounded scans on this read handle and returns only finished mutation rows
  // for the writer. No corpus scan or target lookup runs on the writer thread.
  const ownershipPlan = computeUrlOwnershipRepairs(
    db,
    limit,
    fallbackRepresentationSourcePrefixes,
    referenceOnlySourcePrefixes,
    urlTargetRolesReady,
  );
  const {
    retargets,
    sameResourceUpdates,
    ownershipLinkScannedMaxId,
    ownershipLinkCycleMaxId,
    ownershipDocumentScannedMaxRowid,
    ownershipDocumentCycleMaxRowid,
  } = ownershipPlan;

  if (
    urlRows.length === 0 &&
    nonUrlRows.length === 0 &&
    directRows.length === 0 &&
    retargets.length === 0 &&
    sameResourceUpdates.length === 0 &&
    !ownershipPlan.examinedAny
  ) {
    return {
      resolutions: [],
      retargets: [],
      sameResourceUpdates: [],
      ownershipLinkScannedMaxId,
      ownershipLinkCycleMaxId,
      ownershipDocumentScannedMaxRowid,
      ownershipDocumentCycleMaxRowid,
      scannedMaxId: 0,
      urlCycleMaxId,
      deletableLinkIds: [],
      expectedCollectorRosterRevision,
    };
  }

  // `scannedMaxId` reflects ONLY the cursor scan (1) — it is the
  // URL-backlog progression signal and must stay independent of the
  // direct scan (3), which never touches the cursor.
  let scannedMaxId = 0;
  for (const row of urlRows) {
    if (row.id > scannedMaxId) scannedMaxId = row.id;
  }

  // Resolve the cursor + non-URL rows via `resolveLink` in one batch so
  // the source_id cache is shared. The first `urlRows.length` entries
  // correspond to the URL rows (order preserved), the rest are non-URL.
  const scanned = resolveRowsToResolutions(
    db,
    [...urlRows, ...nonUrlRows],
    fallbackRepresentationSourcePrefixes,
    referenceOnlySourcePrefixes,
  );
  const urlScanResolutions = scanned.slice(0, urlRows.length);
  const nonUrlResolutions = scanned.slice(urlRows.length);

  // Merge URL resolutions from the cursor scan (1) and the direct scan
  // (3), deduped by linkId and capped at `limit` so the batch can't
  // exceed the caller's per-tick budget. The fill order matters:
  //
  //  - Pass 1a — RESOLVED cursor rows first. The cursor advances past
  //    every scanned row this tick (`scannedMaxId`), so a resolved
  //    cursor row dropped for budget is skipped until the next full
  //    cycle. These include strategy-2 (url-pattern) matches the direct
  //    scan can't express, so they're the most expensive to drop.
  //  - Pass 1b — direct matches fill remaining budget. A dropped direct
  //    match is cursor-independent and simply re-found next tick, so it
  //    only costs one tick of latency. On overlap the direct match
  //    (always resolved) is authoritative over a cursor result.
  //  - Pass 2 — UNRESOLVED cursor rows fill any leftover budget. They do
  //    no writer work (upsert skips nulls) but preserve the
  //    "compute reports what it scanned" shape the split-path tests
  //    assert.
  const urlByLink = new Map<number, string | null>();
  for (const r of urlScanResolutions) {
    if (r.targetDocId === null) continue;
    if (urlByLink.size >= limit) break;
    urlByLink.set(r.linkId, r.targetDocId);
  }
  for (const row of directRows) {
    const preferred = resolveUrlLink(
      db,
      row.normalized_target,
      fallbackRepresentationSourcePrefixes,
      referenceOnlySourcePrefixes,
    );
    const targetDocId = preferred?.docId ?? null;
    if (urlByLink.has(row.link_id)) {
      urlByLink.set(row.link_id, targetDocId);
      continue;
    }
    if (urlByLink.size >= limit) continue;
    urlByLink.set(row.link_id, targetDocId);
  }
  for (const r of urlScanResolutions) {
    if (r.targetDocId !== null || urlByLink.has(r.linkId)) continue;
    if (urlByLink.size >= limit) break;
    urlByLink.set(r.linkId, null);
  }

  const resolutions: LinkResolution[] = [
    ...Array.from(urlByLink, ([linkId, targetDocId]) => ({ linkId, targetDocId })),
    ...nonUrlResolutions,
  ];

  // Unresolvable-url prune: among the url rows the cursor just visited, find the ones
  // that can never resolve — they didn't resolve now (the cursor scan's
  // `resolveLink` returned null, which also means no `source_url` match,
  // so the direct scan (3) can't claim them either) AND their target
  // matches no KNOWN source type's url-id pattern (so they can't resolve
  // later, even after the user adds a source). These are the
  // permanently-external links; the writer deletes them so the cursor
  // doesn't re-scan them on the next cycle. A link to a known-but-not-yet-
  // added source survives the prune and resolves once that source is added.
  const deletableLinkIds: number[] = [];
  for (let i = 0; i < urlRows.length; i++) {
    if (urlScanResolutions[i]?.targetDocId !== null) continue;
    if (!knownUrlPatternDeclarationReady) continue;
    if (urlTargetMatchesKnownSourceType(db, urlRows[i].normalized_target, knownUrlPatterns)) {
      continue;
    }
    deletableLinkIds.push(urlRows[i].id);
  }

  // A `duplicate-content` edge whose other copy was deleted. The edge names
  // that copy by document id, so nothing can ever resolve it again, and no
  // owner re-derives it: it is recomputed only when the document that holds it
  // is re-extracted, which for an unchanged file is never. Left alone, deleting
  // one copy of a file strands an edge on every other copy — removing a whole
  // source stranded hundreds on a sibling. Declared edges are re-diffed by
  // their source each sync and `same-resource` has its own repair, so this is
  // the one fixed-target type nothing else cleans up. `resolved_at` set with no
  // target is what "its target was deleted" looks like: the edge was written
  // resolved. Served by the (target_doc_id, link_type) index, on this read
  // handle; the writer deletes by id, re-checking the target is still NULL.
  const strandedDuplicates = db
    .prepare<[number], { id: number }>(
      `SELECT id FROM document_links
        WHERE target_doc_id IS NULL AND link_type = 'duplicate-content'
          AND resolved_at IS NOT NULL
        LIMIT ?`,
    )
    .all(limit);
  for (const row of strandedDuplicates) deletableLinkIds.push(row.id);

  return {
    resolutions,
    retargets,
    sameResourceUpdates,
    ownershipLinkScannedMaxId,
    ownershipLinkCycleMaxId,
    ownershipDocumentScannedMaxRowid,
    ownershipDocumentCycleMaxRowid,
    scannedMaxId,
    urlCycleMaxId,
    deletableLinkIds,
    expectedCollectorRosterRevision,
  };
}

/**
 * Pure-write companion to `computeLinkResolutions`. Applies mutations in
 * fixed-size transactions, cooperatively yielding between them. Periodic
 * reconcile cursors advance only in a final transaction after every chunk
 * has completed and the collector roster revision still matches.
 *
 * Cursor advancement:
 *   - `scannedMaxId > 0`  → cursor moves forward to `scannedMaxId`
 *   - `scannedMaxId === 0` AND cursor > 0 → cursor wraps to 0,
 *     `cycle_count` increments, `last_wrapped_at` is stamped
 *   - `scannedMaxId === 0` AND cursor === 0 → no-op (nothing to do)
 *
 * Rows whose `targetDocId` is null leave the link unresolved on disk
 * but still advance the cursor — that's how the reconciler makes
 * progress past permanently-unresolvable rows.
 *
 * Target-existence guard: a target doc resolved during the (read-handle) compute pass
 * can be deleted before this (writer) apply — `target_doc_id` has a
 * `REFERENCES documents(id)` FK, so writing the now-dangling id would
 * throw `FOREIGN KEY constraint failed` and poison the batch (and, since
 * the resolver re-derives the same row every tick, stall the cursor
 * indefinitely). The `EXISTS (SELECT 1 FROM documents …)` clause degrades
 * that race to a no-op: the stale row stays unresolved and is retried on
 * a later tick once the target reappears or the link is re-extracted.
 *
 * Also deletes `batch.deletableLinkIds` — url links the cursor scan found
 * to be permanently unresolvable (unresolvable-url prune). The `target_doc_id IS NULL`
 * guard makes a delete a no-op if a concurrent path resolved the link
 * between compute and apply, so a resolvable link is never dropped.
 *
 * Returns the numbers resolved, retargeted, and pruned.
 */
export const LINK_RECONCILE_APPLY_CHUNK_SIZE = 50;

type LinkReconcileApplyPhase = "resolve" | "retarget" | "same-resource" | "delete" | "finish";

export interface LinkReconcileApplyState {
  batch: LinkReconcileBatch;
  phase: LinkReconcileApplyPhase;
  offset: number;
  updated: number;
  deleted: number;
  retargeted: number;
}

interface LinkReconcileApplyOutcome {
  updated: number;
  deleted: number;
  retargeted: number;
  remaining: LinkReconcileApplyState | null;
}

/** Bounded, cooperatively yieldable writer half of URL reconciliation. */
export function upsertLinkResolutionsYieldable(
  db: Db,
  input: LinkReconcileBatch | LinkReconcileApplyState,
  options: { token?: { requested(): boolean } } = {},
): LinkReconcileApplyOutcome {
  const state: LinkReconcileApplyState =
    "phase" in input
      ? { ...input }
      : {
          batch: input,
          phase: "resolve",
          offset: 0,
          updated: 0,
          deleted: 0,
          retargeted: 0,
        };
  const batch = state.batch;
  const now = new Date().toISOString();
  const updateStmt = db.prepare(
    `UPDATE document_links SET target_doc_id = ?, resolved_at = ?
      WHERE id = ? AND target_doc_id IS NULL
        AND EXISTS (SELECT 1 FROM documents WHERE id = ?)`,
  );
  const deleteStmt = db.prepare(
    "DELETE FROM document_links WHERE id = ? AND target_doc_id IS NULL",
  );
  const retargetStmt = db.prepare(
    `UPDATE document_links SET target_doc_id = ?, resolved_at = ?
      WHERE id = ? AND link_type = 'url' AND target_doc_id = ? AND normalized_target = ?
        AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND source_url = ?)
        AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND source_url = ?)`,
  );
  const clearReferenceTargetStmt = db.prepare(
    `UPDATE document_links SET target_doc_id = NULL, resolved_at = NULL
      WHERE id = ? AND link_type = 'url' AND target_doc_id = ? AND normalized_target = ?
        AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND source_url = ?)`,
  );
  const sameResourceStmt = db.prepare(
    `INSERT INTO document_links
       (source_doc_id, link_type, raw_target, normalized_target, target_doc_id,
        resolved_at, created_at, provenance_kind, provenance_origin, declared_at)
     SELECT ?, 'same-resource', ?, ?, ?, ?, ?, 'cross-source-derived', ?, ?
      WHERE EXISTS (SELECT 1 FROM documents WHERE id = ? AND source_url = ?)
        AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND source_url = ?)
     ON CONFLICT(source_doc_id, link_type, normalized_target) DO UPDATE SET
       raw_target = excluded.raw_target,
       target_doc_id = excluded.target_doc_id,
       resolved_at = excluded.resolved_at,
       provenance_kind = excluded.provenance_kind,
       provenance_origin = excluded.provenance_origin`,
  );
  const sameResourceInsertStmt = db.prepare(
    `INSERT INTO document_links
       (source_doc_id, link_type, raw_target, normalized_target, target_doc_id,
        resolved_at, created_at, provenance_kind, provenance_origin, declared_at)
     SELECT ?, 'same-resource', ?, ?, ?, ?, ?, 'cross-source-derived', ?, ?
      WHERE EXISTS (SELECT 1 FROM documents WHERE id = ? AND source_url = ?)
        AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND source_url = ?)
     ON CONFLICT(source_doc_id, link_type, normalized_target) DO NOTHING`,
  );
  const clearSameResourceStmt = db.prepare(
    `DELETE FROM document_links
      WHERE source_doc_id = ? AND link_type = 'same-resource'
        AND normalized_target IS ? AND target_doc_id IS ?
        AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND source_url IS ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM documents WHERE id = ? AND source_url IS ?))`,
  );
  const advanceCursorStmt = db.prepare(
    "UPDATE link_reconcile_state SET cursor = ?, url_cycle_max_id = ? WHERE id = 1",
  );
  const wrapCursorStmt = db.prepare(
    `UPDATE link_reconcile_state
        SET cursor = 0,
            url_cycle_max_id = 0,
            cycle_count = cycle_count + 1,
            last_wrapped_at = ?
      WHERE id = 1 AND url_cycle_max_id > 0`,
  );
  const advanceOwnershipLinkCursorStmt = db.prepare(
    "UPDATE link_reconcile_state SET ownership_link_cursor = ?, ownership_link_max_id = ? WHERE id = 1",
  );
  const wrapOwnershipLinkCursorStmt = db.prepare(
    "UPDATE link_reconcile_state SET ownership_link_cursor = 0, ownership_link_max_id = 0 WHERE id = 1",
  );
  const advanceOwnershipDocumentCursorStmt = db.prepare(
    "UPDATE link_reconcile_state SET ownership_document_cursor = ?, ownership_document_max_rowid = ? WHERE id = 1",
  );
  const wrapOwnershipDocumentCursorStmt = db.prepare(
    "UPDATE link_reconcile_state SET ownership_document_cursor = 0, ownership_document_max_rowid = 0 WHERE id = 1",
  );

  const rosterMatches = (): boolean =>
    batch.expectedCollectorRosterRevision === undefined ||
    collectorRosterRevisionMatches(db, batch.expectedCollectorRosterRevision);

  const nextPhase = (): void => {
    state.phase =
      state.phase === "resolve"
        ? "retarget"
        : state.phase === "retarget"
          ? "same-resource"
          : state.phase === "same-resource"
            ? "delete"
            : "finish";
    state.offset = 0;
  };

  for (;;) {
    if (state.phase === "finish") {
      db.transaction((): void => {
        if (!rosterMatches()) return;
        if (batch.scannedMaxId > 0) {
          advanceCursorStmt.run(batch.scannedMaxId, batch.urlCycleMaxId ?? batch.scannedMaxId);
        } else wrapCursorStmt.run(now);
        if (batch.ownershipLinkScannedMaxId !== undefined) {
          if (batch.ownershipLinkScannedMaxId > 0) {
            advanceOwnershipLinkCursorStmt.run(
              batch.ownershipLinkScannedMaxId,
              batch.ownershipLinkCycleMaxId ?? batch.ownershipLinkScannedMaxId,
            );
          } else wrapOwnershipLinkCursorStmt.run();
        }
        if (batch.ownershipDocumentScannedMaxRowid !== undefined) {
          if (batch.ownershipDocumentScannedMaxRowid > 0) {
            advanceOwnershipDocumentCursorStmt.run(
              batch.ownershipDocumentScannedMaxRowid,
              batch.ownershipDocumentCycleMaxRowid ?? batch.ownershipDocumentScannedMaxRowid,
            );
          } else wrapOwnershipDocumentCursorStmt.run();
        }
      })();
      return {
        updated: state.updated,
        deleted: state.deleted,
        retargeted: state.retargeted,
        remaining: null,
      };
    }

    const items =
      state.phase === "resolve"
        ? batch.resolutions
        : state.phase === "retarget"
          ? (batch.retargets ?? [])
          : state.phase === "same-resource"
            ? (batch.sameResourceUpdates ?? [])
            : batch.deletableLinkIds;
    if (state.offset >= items.length) {
      nextPhase();
      continue;
    }
    const end = Math.min(state.offset + LINK_RECONCILE_APPLY_CHUNK_SIZE, items.length);
    const result = db.transaction(() => {
      if (!rosterMatches()) return { abandoned: true, updated: 0, deleted: 0, retargeted: 0 };
      let updated = 0;
      let deleted = 0;
      let retargeted = 0;
      let representationsChanged = 0;
      if (state.phase === "resolve") {
        for (const row of batch.resolutions.slice(state.offset, end)) {
          if (row.targetDocId === null) continue;
          updated += updateStmt.run(row.targetDocId, now, row.linkId, row.targetDocId).changes;
        }
      } else if (state.phase === "retarget") {
        const represented = new Set<string>();
        for (const row of (batch.retargets ?? []).slice(state.offset, end)) {
          const changed =
            row.targetDocId === null
              ? clearReferenceTargetStmt.run(
                  row.linkId,
                  row.previousTargetDocId,
                  row.normalizedTarget,
                  row.previousTargetDocId,
                  row.normalizedTarget,
                ).changes
              : retargetStmt.run(
                  row.targetDocId,
                  now,
                  row.linkId,
                  row.previousTargetDocId,
                  row.normalizedTarget,
                  row.targetDocId,
                  row.normalizedTarget,
                  row.previousTargetDocId,
                  row.normalizedTarget,
                ).changes;
          if (changed === 0) continue;
          retargeted += 1;
          if (!row.connectRepresentations || row.targetDocId === null) continue;
          const key = `${row.previousTargetDocId}\u0000${row.normalizedTarget}\u0000${row.targetDocId}`;
          if (represented.has(key)) continue;
          represented.add(key);
          representationsChanged += sameResourceStmt.run(
            row.previousTargetDocId,
            row.normalizedTarget,
            row.normalizedTarget,
            row.targetDocId,
            now,
            now,
            SAME_RESOURCE_PROVENANCE_ORIGIN,
            now,
            row.previousTargetDocId,
            row.normalizedTarget,
            row.targetDocId,
            row.normalizedTarget,
          ).changes;
        }
      } else if (state.phase === "same-resource") {
        for (const row of (batch.sameResourceUpdates ?? []).slice(state.offset, end)) {
          const hadPrior = row.expectedPriorNormalizedTarget !== null;
          const cleared = clearSameResourceStmt.run(
            row.sourceDocId,
            row.expectedPriorNormalizedTarget,
            row.expectedPriorTargetDocId,
            row.sourceDocId,
            row.expectedSourceUrl,
            row.expectedPriorTargetDocId,
            row.expectedPriorTargetDocId,
            row.expectedPriorTargetSourceUrl,
          ).changes;
          if (hadPrior && cleared === 0) continue;
          representationsChanged += cleared;
          if (row.normalizedTarget === null || row.targetDocId === null) continue;
          representationsChanged += sameResourceInsertStmt.run(
            row.sourceDocId,
            row.normalizedTarget,
            row.normalizedTarget,
            row.targetDocId,
            now,
            now,
            SAME_RESOURCE_PROVENANCE_ORIGIN,
            now,
            row.sourceDocId,
            row.normalizedTarget,
            row.targetDocId,
            row.normalizedTarget,
          ).changes;
        }
      } else {
        for (const linkId of batch.deletableLinkIds.slice(state.offset, end)) {
          deleted += deleteStmt.run(linkId).changes;
        }
      }
      if (updated > 0 || deleted > 0 || retargeted > 0 || representationsChanged > 0) {
        markLinkStatsDirty(db);
      }
      return { abandoned: false, updated, deleted, retargeted };
    })();
    if (result.abandoned) {
      return {
        updated: state.updated,
        deleted: state.deleted,
        retargeted: state.retargeted,
        remaining: null,
      };
    }
    state.updated += result.updated;
    state.deleted += result.deleted;
    state.retargeted += result.retargeted;
    state.offset = end;
    if (state.offset >= items.length) nextPhase();
    if (options.token?.requested()) return { ...state, remaining: { ...state } };
  }
}

/** Synchronous compatibility wrapper; production dispatch uses the yieldable variant. */
export function upsertLinkResolutions(
  db: Db,
  batch: LinkReconcileBatch,
): { updated: number; deleted: number; retargeted: number } {
  const result = upsertLinkResolutionsYieldable(db, batch);
  return { updated: result.updated, deleted: result.deleted, retargeted: result.retargeted };
}

/**
 * In-process draining variant. Scans every unresolved link (no
 * cursor) up to `limit` and resolves what it can in one transaction.
 * Test helper + back-compat write op for callers that want
 * "best-effort drain right now" semantics, not the periodic-fair-share
 * progression the scheduler needs.
 *
 * The Scheduler-driven path (linkReconcileTask) uses
 * `computeLinkResolutions` + `upsertLinkResolutions` instead, which
 * carry the cursor through `link_reconcile_state` so the URL backlog
 * drains row-by-row over a single cycle.
 *
 * Returns the number of rows written.
 */
export function reconcileUnresolvedLinks(
  db: Db,
  limit: number = 50,
  urlTargetRolesReady = false,
): number {
  const unresolvedRows = db
    .prepare<[number, number], UnresolvedRow>(
      `SELECT id, source_doc_id, link_type, normalized_target
         FROM document_links
        WHERE target_doc_id IS NULL
          AND (? OR link_type != 'url')
        LIMIT ?`,
    )
    .all(urlTargetRolesReady ? 1 : 0, limit);
  if (unresolvedRows.length === 0) return 0;

  const resolutions = resolveRowsToResolutions(db, unresolvedRows, [], []);
  const now = new Date().toISOString();
  const updateStmt = db.prepare(
    "UPDATE document_links SET target_doc_id = ?, resolved_at = ? WHERE id = ? AND target_doc_id IS NULL",
  );

  const apply = db.transaction((): number => {
    let updated = 0;
    for (const r of resolutions) {
      if (r.targetDocId === null) continue;
      const result = updateStmt.run(r.targetDocId, now, r.linkId);
      if (result.changes > 0) updated++;
    }
    if (updated > 0) markLinkStatsDirty(db);
    return updated;
  });
  return apply();
}
