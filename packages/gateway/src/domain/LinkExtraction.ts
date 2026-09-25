// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { extractLinks, graphEdgeProvenance } from "@omnesis/core";
import {
  getCachedSafeUrlCanonicalizerRegistry,
  getCachedSafeUrlPatternMatchers,
} from "../known-url-pattern-safety.js";
import { markLinkStatsDirty } from "../data/DirtyMarks.js";
import { getCachedUrlIdPatterns } from "../db.js";
import { collectorRosterRevisionMatches } from "../collector-declaration-roster.js";
import { getKnownUrlPatterns } from "../known-url-patterns.js";
import { documentsMetadataCodec } from "../data/json-columns.js";
import { resolveLink, linkDuplicateContentDocs } from "./LinkGraphService.js";
import { linkExtractionInputDigest } from "./LinkExtractionInput.js";
import type { SafeUrlPatternMatcher } from "../known-url-pattern-safety.js";
import type { ExtractedLink, GraphEdgeProvenanceKind, UrlCanonicalizerSpec } from "@omnesis/core";

/**
 * Provenance kind for an extractor-derived edge — the type-level default from
 * `@omnesis/core` (url → content-derived; the structural conventions →
 * source-declared; duplicate-content → cross-source-derived). The single
 * source of truth is `graphEdgeProvenance`; this just narrows the `undefined`
 * an unknown type would yield to a safe `source-declared`.
 */
function provenanceKindFor(linkType: string): GraphEdgeProvenanceKind {
  return graphEdgeProvenance(linkType) ?? "source-declared";
}

/** `EdgeDeclaration.metadata` → the JSON string persisted in `metadata_json`. */
function metadataJsonFor(link: ExtractedLink): string | null {
  return link.metadata ? JSON.stringify(link.metadata) : null;
}

/**
 * Whether an as-yet-unresolved `url`-type link could still resolve to an
 * Omnesis document later — i.e. whether it is worth storing at all.
 *
 * On the live corpus the overwhelming majority of extracted url links
 * point at external web pages (news sites, newsletters, tracking links)
 * that will never become Omnesis documents. Stored with
 * `target_doc_id IS NULL`, they bloat `document_links` and force the
 * reconcile scan to revisit them forever. Callers gate on this AFTER an
 * eager `resolveLink` attempt, so a link that resolves *right now* (the
 * direct `source_url` strategy 1, OR a url-id pattern → already-ingested
 * doc strategy 2) is always kept regardless. This predicate decides only
 * the *deferred* case (target not yet ingested): a link is kept iff its
 * target matches *some* source type's url-id pattern.
 *
 * The pattern set passed here is the union of two layers (see
 * `keepGatePatterns`):
 *   - **registered** patterns, from `sync_state.url_patterns` — the
 *     currently-added sources; and
 *   - **known** patterns, from `known-url-patterns.ts` — every source type
 *     the collector knows about, added or not.
 * Keying on the known superset means a link to a first-class source the
 * user hasn't added *yet* (e.g. a Notion URL before Notion is a source) is
 * kept unresolved and resolves via the reconcile path once that source is
 * added and ingested — instead of being dropped permanently (re-extraction
 * only re-fires on the *source* doc changing, so a dropped link never
 * comes back on its own).
 *
 * INTENTIONAL TRADE-OFF: a url whose target matches no source type's
 * url-id pattern is NOT kept. The targets that fail this gate are
 * pages no known dedicated source can own (news sites, newsletters, tracking
 * links). A Web Pages capture can still satisfy one of those URLs when it
 * already exists at extraction time; browser-history summaries and bookmark
 * records are not URL target representations at all. We accept dropping the
 * remaining external URLs because:
 *   - they are the permanently-external majority this issue targets (the
 *     host set is unbounded — any external URL);
 *   - they cannot become a structured source document later;
 *   - the common in-order cases (target already ingested, or a content
 *     re-extraction once it is) still resolve via the eager `resolveLink`.
 */
function urlTargetCouldResolve(
  db: Db,
  knownPatterns: ReadonlyArray<{ regex: SafeUrlPatternMatcher }>,
  normalizedTarget: string,
): boolean {
  // The registered layer is read per call rather than held: its memo reloads
  // on its own when another connection commits a `url_patterns` change, and
  // the reload frees the RE2 handles behind the matchers it replaces. A
  // reference captured before an intervening `resolveLink` would therefore
  // point at a deleted handle. The known layer is keyed by its argument and
  // never disposed, so it is passed in.
  for (const pattern of getCachedUrlIdPatterns(db)) {
    if (pattern.regex.test(normalizedTarget)) return true;
  }
  for (const pattern of knownPatterns) {
    if (pattern.regex.test(normalizedTarget)) return true;
  }
  return false;
}

/**
 * The `document_links.link_type` values `extractLinks` /
 * `linkDuplicateContentDocs` OWN — the only rows the re-extraction wipe may
 * delete before re-inserting. Scoping the wipe to this set (rather than
 * "everything except cited") means every edge written by a DIFFERENT writer is
 * preserved automatically:
 *   - `cited` — agent citations (`sources/omnesis-chat/citation-writer.ts`).
 *   - `replies-to` / `succeeds` / `accompanies` — source-declared edges from the
 *     `EdgeDeclaration` contract (`EdgeDeclarationWriter`), which extractLinks
 *     never derives. They live alongside the convention-derived structural
 *     edges in `document_links` but are owned by their own diff-and-delete.
 * The convention-derived structural edges (contains / part-of-thread /
 * references) and the calendar cross-reference ARE in this set, so a doc whose
 * metadata convention changes correctly drops the stale edge on re-extraction.
 */
const EXTRACT_LINKS_MANAGED_TYPES: readonly string[] = [
  "url",
  "shares-phone",
  "references",
  "part-of-thread",
  "contains",
  "calendar-event",
  "duplicate-content",
];

const EXTRACT_LINKS_MANAGED_PLACEHOLDERS = EXTRACT_LINKS_MANAGED_TYPES.map(() => "?").join(", ");

/**
 * Build the host-keyed canonicalizer registry from a spec array, or
 * return undefined if no specs were supplied (caller path running on
 * a worker without an explicit handoff). Callers on the main thread
 * pass the live registry's spec list; workers receive it via the call
 * payload so they don't depend on worker-local module state.
 */
function registryFromSpecs(
  specs: readonly UrlCanonicalizerSpec[] | undefined,
): ReadonlyMap<string, UrlCanonicalizerSpec> | undefined {
  if (!specs || specs.length === 0) return undefined;
  return getCachedSafeUrlCanonicalizerRegistry(specs);
}

/**
 * Check whether a source declares best-effort content retention
 * (its content may shrink between syncs due to buffer rollover).
 * When true, link extraction is additive-only — existing links are
 * preserved even when the new content no longer contains them.
 */
function isBestEffortRetention(db: Db, sourceId: string): boolean {
  const row = db
    .prepare<
      [string],
      { content_retention: string | null }
    >("SELECT content_retention FROM sync_state WHERE source_id = ?")
    .get(sourceId);
  return row?.content_retention === "best-effort";
}

/**
 * Extract links from a document's content/metadata, store in document_links,
 * and resolve what we can immediately. Marks the document as processed via
 * the links_extracted_at column.
 */
export function processDocumentLinks(
  db: Db,
  docId: string,
  content: string,
  metadata: { extra?: Record<string, unknown> } | undefined,
  sourceId: string,
  externalId: string,
  sourceUrl: string | null,
  canonicalizers?: readonly UrlCanonicalizerSpec[],
): { extracted: number; resolved: number } {
  // Legacy compatibility helper used by focused tests and maintenance
  // scripts. It is intentionally not exposed as a writer-worker operation:
  // URL lookups and non-URL resolution read corpus state and must never park
  // the production gateway's only writer. Production extraction uses the
  // split fetch → CPU extract → reader resolve → bounded writer apply path.
  // URL ownership resolution lives in the periodic
  // `compute.linkResolutions` → `links.upsertLinkResolutions` pair, which
  // runs on the IO worker (read-only handle) so its SELECT phase never
  // parks the writer.
  //
  // We keep `void sourceUrl` and `void externalId` as a marker that
  // the inbound-resolution SQL we used to inline lives in
  // `computeLinkResolutions` now.
  void sourceUrl;
  void externalId;

  const now = new Date().toISOString();

  // Sources with best-effort content retention (e.g. WhatsApp) may lose
  // older content between syncs due to buffer rollover. For these sources,
  // link extraction is additive-only: we never delete existing links,
  // only insert new ones.
  const additive = isBestEffortRetention(db, sourceId);

  if (!additive) {
    // 1. Delete existing outbound links (re-extraction on update). Scoped to
    //    `EXTRACT_LINKS_MANAGED_TYPES` — edges owned by another writer (cited,
    //    source-declared replies-to/succeeds/accompanies) are left untouched.
    db.prepare(
      `DELETE FROM document_links WHERE source_doc_id = ? AND link_type IN (${EXTRACT_LINKS_MANAGED_PLACEHOLDERS})`,
    ).run(docId, ...EXTRACT_LINKS_MANAGED_TYPES);
  }
  // Mark link_stats dirty — DELETE may remove rows, INSERTs below may
  // add them, both shift counts. Bump once per call: the singleton
  // stats row's `dirty_version` only needs a single bump per "batch
  // of mutations" to invalidate any in-flight compute.
  markLinkStatsDirty(db);

  // 2. Extract links (passing externalId so the extractor can drop self-loops
  //    — e.g. Gmail's first-message-in-thread where threadId == externalId,
  //    and the canonicalizer registry so URL variants collapse to the same
  //    normalized form the matching document carries as `source_url`).
  //
  //    Canonicalizer registry is passed in by the main-thread caller —
  //    `getUrlCanonicalizers()` is per-process state and this code runs
  //    inside a writer worker, so reading it locally would give an
  //    empty registry.
  const links = extractLinks(content, metadata, externalId, registryFromSpecs(canonicalizers));

  // 3. Bulk insert with target_doc_id=NULL. The compute reconcile pass
  //    fills in target_doc_id later. We still dedupe by
  //    (source_doc_id, link_type, normalized_target) on conflict.
  //
  //    In additive mode we use DO NOTHING so existing links (including
  //    their resolved target_doc_id and raw_target) are preserved
  //    unchanged. A stale raw_target is cosmetic — resolution uses
  //    normalized_target. In normal mode we reset resolution on
  //    conflict so re-extraction re-resolves.
  const insertStmt = additive
    ? db.prepare(`
        INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at, metadata_json, provenance_kind, provenance_origin, provenance_version, declared_at)
        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(source_doc_id, link_type, normalized_target) DO NOTHING
      `)
    : db.prepare(`
        INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at, metadata_json, provenance_kind, provenance_origin, provenance_version, declared_at)
        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(source_doc_id, link_type, normalized_target) DO UPDATE SET
          raw_target = excluded.raw_target,
          target_doc_id = NULL,
          resolved_at = NULL,
          metadata_json = excluded.metadata_json,
          provenance_kind = excluded.provenance_kind,
          provenance_origin = excluded.provenance_origin
      `);

  // Inline-resolve non-URL link types. This legacy
  // single-doc path runs the read (resolveLink) and the apply in the SAME
  // transaction. URL target selection needs descriptor-derived roles that
  // are unavailable in the writer worker, so the periodic read-side
  // reconciler handles URLs.
  const resolveUpdateStmt = db.prepare(
    `UPDATE document_links
        SET target_doc_id = ?, resolved_at = ?
      WHERE source_doc_id = ? AND link_type = ? AND normalized_target = ?
        AND target_doc_id IS NULL`,
  );

  // A url link that neither resolves now nor could ever resolve
  // (its target matches no source type's url-id pattern) is a permanent
  // external dead-end — don't store it. See `urlTargetCouldResolve`.
  const knownPatterns = getKnownUrlPatterns();
  const sourceUrlExists = db.prepare<[string], { present: number }>(
    "SELECT 1 AS present FROM documents WHERE source_url = ? LIMIT 1",
  );
  // This compatibility path runs in the writer worker, whose module globals
  // do not receive the main thread's descriptor registry. Leave URL ownership
  // to the periodic read-side reconcile instead of making a partial decision.
  let inserted = 0;
  const insertAll = db.transaction((items: ExtractedLink[]) => {
    for (const link of items) {
      const target = link.type === "url" ? null : resolveLink(db, link, sourceId, docId, [], []);
      if (
        link.type === "url" &&
        !target &&
        !sourceUrlExists.get(link.normalizedTarget) &&
        !urlTargetCouldResolve(db, knownPatterns, link.normalizedTarget)
      ) {
        continue;
      }
      insertStmt.run(
        docId,
        link.type,
        link.rawTarget,
        link.normalizedTarget,
        now,
        metadataJsonFor(link),
        provenanceKindFor(link.type),
        sourceId,
        now,
      );
      inserted += 1;
      if (target) {
        resolveUpdateStmt.run(target.docId, now, docId, link.type, link.normalizedTarget);
      }
    }
  });

  insertAll(links);

  // Also emit duplicate-content links for binary-extracted
  // docs (attachment + Drive file). Runs unconditionally — Drive `file`
  // docs typically have zero extracted-from-content links, so a previous
  // early-return on `links.length === 0` would have skipped this entirely
  // and silently disabled cross-source PDF dedup.
  const docMeta = db
    .prepare<[string], { extracted_content_hash: string | null; document_type: string | null }>(
      `SELECT extracted_content_hash, json_extract(metadata, '$.documentType') AS document_type
         FROM documents WHERE id = ?`,
    )
    .get(docId);
  const dupLinks = docMeta
    ? linkDuplicateContentDocs(
        db,
        docId,
        docMeta.extracted_content_hash ?? undefined,
        docMeta.document_type ?? undefined,
      )
    : 0;

  // 4. Mark as processed (links_extracted_at gates the periodic backfill).
  db.prepare("UPDATE documents SET links_extracted_at = ? WHERE id = ?").run(now, docId);

  // `extracted` counts links actually stored — `urlTargetCouldResolve`
  // drops the permanently-unresolvable url majority, so it can be
  // well below `links.length`. `resolved=0` because callers tracking
  // resolution counts read from the periodic reconcile's logs.
  return { extracted: inserted + dupLinks, resolved: 0 };
}

/**
 * Process links for a single unprocessed document.
 * Returns null if no unprocessed documents remain.
 * Uses the links_extracted_at column + partial index for O(1) lookup.
 */
export function backfillOneDocument(
  db: Db,
  canonicalizers?: readonly UrlCanonicalizerSpec[],
): { extracted: number; resolved: number } | null {
  const row = db
    .prepare<
      [],
      {
        id: string;
        source_id: string;
        external_id: string;
        content: string;
        metadata: string;
        source_url: string | null;
      }
    >(
      `SELECT id, source_id, external_id, content, metadata, source_url
       FROM documents
       WHERE links_extracted_at IS NULL
       LIMIT 1`,
    )
    .get();

  if (!row) return null;

  const meta = documentsMetadataCodec.parseWithFallback(row.metadata, { rowId: row.id }) as {
    extra?: Record<string, unknown>;
  };

  return processDocumentLinks(
    db,
    row.id,
    row.content,
    meta,
    row.source_id,
    row.external_id,
    row.source_url,
    canonicalizers,
  );
}

/**
 * Yieldable multi-doc variant of `backfillOneDocument`. Processes up to
 * `batchSize` unresolved documents, polling the preempt token between
 * each. Per-doc commits (no outer transaction) so a yield mid-batch
 * cleanly persists what's done so far.
 *
 * Returns the cumulative counts plus a `processed` count so the
 * periodic task can tell whether work was done. When `options.token`
 * is omitted, batchSize defaults to 1 — preserving the legacy
 * "one doc per call" semantics for callers that don't request yield.
 */
export function backfillSomeDocuments(
  db: Db,
  batchSize: number = 1,
  options: {
    token?: { requested(): boolean };
    canonicalizers?: readonly UrlCanonicalizerSpec[];
  } = {},
): { processed: number; extracted: number; resolved: number } {
  let processed = 0;
  let extracted = 0;
  let resolved = 0;
  const token = options.token;

  // SELECT one unresolved doc at a time so the read sees the freshest
  // state after the previous doc's commit (no stale cache from a
  // batched LIMIT-N SELECT).
  const selectStmt = db.prepare<
    [],
    {
      id: string;
      source_id: string;
      external_id: string;
      content: string;
      metadata: string;
      source_url: string | null;
    }
  >(
    `SELECT id, source_id, external_id, content, metadata, source_url
     FROM documents
     WHERE links_extracted_at IS NULL
     LIMIT 1`,
  );

  for (let i = 0; i < batchSize; i++) {
    const row = selectStmt.get();
    if (!row) break;

    const meta = documentsMetadataCodec.parseWithFallback(row.metadata, { rowId: row.id }) as {
      extra?: Record<string, unknown>;
    };

    const r = processDocumentLinks(
      db,
      row.id,
      row.content,
      meta,
      row.source_id,
      row.external_id,
      row.source_url,
      options.canonicalizers,
    );
    processed += 1;
    extracted += r.extracted;
    resolved += r.resolved;
    if (token?.requested() && i + 1 < batchSize) break;
  }
  return { processed, extracted, resolved };
}

/**
 * One document's worth of extracted links, as it travels the pipeline:
 * produced by the CPU phase, given its targets by the IO phase, and applied
 * by the writer. `inputDigest` is the optimistic-concurrency token over every
 * persisted field that affects extraction; the writer skips an entry if any
 * of those inputs changed after the reader snapshot. `contentHash` remains a
 * cheap explicit guard and is also part of that digest.
 */
export interface ExtractedLinkBatchEntry {
  docId: string;
  contentHash: string;
  sourceId: string;
  links: ExtractedLink[];
  /** Exact digest of every persisted document field that affects extraction. */
  inputDigest: string;
  /** Monotone roster revision used when destructive URL decisions were computed. */
  expectedCollectorRosterRevision?: number;
  /**
   * How many of this document's links are already applied.
   *
   * Set when a preempt lands part-way through a link-heavy document: the
   * continuation carries it and resumes from there. Without it a document
   * with thousands of links restarts from the delete on every attempt, and
   * under steady write pressure — where a preempt arrives every few
   * hundred milliseconds — it can be re-attempted indefinitely without
   * ever reaching its last chunk.
   */
  appliedLinks?: number;
  /**
   * Highest managed link id removed while preparing this document for a
   * replacement extraction. Carried only by writer continuations so a
   * link-heavy re-extraction can yield between bounded delete chunks.
   */
  deletedThroughLinkId?: number;
  /** The bounded replacement deletion has finished for this continuation. */
  deletionComplete?: boolean;
  /**
   * Eagerly-resolved link targets, keyed by {@link resolvedTargetKey}.
   * Filled in by `resolveExtractedLinks` on a read handle, for EVERY link
   * type and applied — EXISTS-guarded against the compute→writer gap — in
   * `upsertExtractedLinksBatch`. Absent when nothing resolved.
   *
   * Resolution is a lookup per link, and the writer is the one thread that
   * may change the database, so a lookup done there charges the whole
   * gateway for it. A document from a chatty source carries hundreds of
   * `references` links, which is minutes of held write lock for one
   * document — hence a separate read phase, whose findings this carries.
   */
  resolvedTargets?: Record<string, string>;
}

export interface ExtractedLinkResolution {
  docId: string;
  resolvedTargets?: Record<string, string>;
  /** URL targets the read phase proved are neither resolvable nor known-source URLs. */
  discardedUrlTargets?: string[];
}

/**
 * How many of one document's links the writer applies per transaction.
 * Small enough that even a document with thousands of links yields the
 * write lock promptly; large enough that the per-transaction cost stays
 * amortised.
 */
export const LINK_APPLY_CHUNK_SIZE = 50;

/**
 * Key for {@link ExtractedLinkBatchEntry.resolvedTargets}.
 *
 * Type and target together, because the same target string means different
 * documents for different link types: a `contains` parent id and a
 * `references` title are not interchangeable, and keying on the target
 * alone would let one silently answer for the other.
 */
export function resolvedTargetKey(linkType: string, normalizedTarget: string): string {
  return `${linkType}\u0000${normalizedTarget}`;
}

/**
 * Pure-read companion to `upsertExtractedLinksBatch`. Selects up to
 * `batchSize` documents whose `links_extracted_at IS NULL`, runs the
 * CPU-heavy `extractLinks` regex on each, and returns the extraction
 * batch without touching the writer. Designed to run on the compute
 * worker so the regex (1-5s on outlier docs like Notion pages or
 * browser-history daily summaries) doesn't park the writer.
 *
 * IO-only fetch for the three-phase link-extraction pipeline. Returns
 * raw doc rows the CPU pool needs for regex extraction.
 */
export function fetchLinksForBatch(
  db: Db,
  batchSize: number,
): import("./LinkExtraction-cpu.js").LinkExtractionDocRow[] {
  return db
    .prepare<
      [number],
      {
        id: string;
        source_id: string;
        external_id: string;
        content: string;
        content_hash: string;
        metadata: string;
        extracted_content_hash: string | null;
      }
    >(
      `SELECT id, source_id, external_id, content, content_hash, metadata, extracted_content_hash
       FROM documents
       WHERE links_extracted_at IS NULL
       LIMIT ?`,
    )
    .all(batchSize);
}

export function extractLinksForBatch(
  db: Db,
  batchSize: number,
  fallbackRepresentationSourcePrefixes: readonly string[],
  referenceOnlySourcePrefixes: readonly string[],
  urlTargetRolesReady: boolean,
  knownUrlPatternSources: readonly string[],
  knownUrlPatternDeclarationReady: boolean,
  canonicalizers?: readonly UrlCanonicalizerSpec[],
): ExtractedLinkBatchEntry[] {
  const rows = db
    .prepare<
      [number],
      {
        id: string;
        source_id: string;
        external_id: string;
        content: string;
        content_hash: string;
        metadata: string;
        extracted_content_hash: string | null;
      }
    >(
      `SELECT id, source_id, external_id, content, content_hash, metadata, extracted_content_hash
       FROM documents
       WHERE links_extracted_at IS NULL
       LIMIT ?`,
    )
    .all(batchSize);

  // Compute worker doesn't share the main-thread canonicalizer
  // registry; the main-thread caller passes the spec list, we rebuild
  // the per-host Map here.
  const registry = registryFromSpecs(canonicalizers);

  const out: ExtractedLinkBatchEntry[] = [];
  for (const row of rows) {
    const meta = documentsMetadataCodec.parseWithFallback(row.metadata, { rowId: row.id }) as {
      extra?: Record<string, unknown>;
    };
    out.push({
      docId: row.id,
      contentHash: row.content_hash,
      inputDigest: linkExtractionInputDigest(row),
      sourceId: row.source_id,
      links: extractLinks(row.content, meta, row.external_id, registry),
    });
  }
  return withResolvedTargets(
    out,
    resolveExtractedLinks(
      db,
      out,
      fallbackRepresentationSourcePrefixes,
      referenceOnlySourcePrefixes,
      urlTargetRolesReady,
      knownUrlPatternSources,
      knownUrlPatternDeclarationReady,
    ),
  );
}

/**
 * Middle phase of link extraction: find each extracted link's target.
 *
 * This is the expensive half — one indexed lookup per link, and a
 * link-heavy document carries hundreds — and it runs on a read handle,
 * where it competes with other reads and blocks nobody, rather than inside
 * the writer's transaction where it would hold the gateway's only write
 * connection for its whole duration.
 *
 * `resolveLink` dispatches per type: url covers both the direct
 * `source_url` match (preferring owning sources over fallback captures) and the
 * `url-pattern → external_id` strategy;
 * references, contains and part-of-thread resolve within the document's own
 * source. Whatever is found lands in `resolvedTargets`, which the writer
 * applies EXISTS-guarded, since a target can be deleted in between.
 *
 * Returns only the targets, keyed by document id, rather than the entries
 * with the targets folded in. The caller already holds the entries, and
 * they carry every link's raw and normalized text — sending a link-heavy
 * batch back across the worker boundary to deliver a small map of strings
 * would copy megabytes to say kilobytes.
 */
export function resolveExtractedLinks(
  db: Db,
  entries: readonly ExtractedLinkBatchEntry[],
  fallbackRepresentationSourcePrefixes: readonly string[],
  referenceOnlySourcePrefixes: readonly string[] = [],
  urlTargetRolesReady = true,
  knownUrlPatternSources: readonly string[] = [],
  knownUrlPatternDeclarationReady = true,
): ExtractedLinkResolution[] {
  // `shares-phone` is the only link type that resolves against other
  // documents' extracted links rather than against `documents`, so its
  // targets are invisible here for the very documents this batch is about
  // to insert links for. The claims are carried forward instead: the first
  // document in the batch to mention a phone number claims it, and a later
  // one resolves to that claimant. Keyed by normalized phone, valued by
  // claiming document id.
  //
  // The claimant itself stays unresolved — the same asymmetry the type has
  // always had, since one `document_links` row can carry only one target.
  // It resolves when a further document mentions the phone, or on the
  // periodic reconcile scan.
  const phoneClaims = new Map<string, string>();

  const knownUrlPatterns = getCachedSafeUrlPatternMatchers(knownUrlPatternSources);
  const out: ExtractedLinkResolution[] = [];
  for (const entry of entries) {
    let resolvedTargets: Record<string, string> | undefined;
    let discardedUrlTargets: string[] | undefined;
    for (const link of entry.links) {
      let targetDocId =
        link.type === "url" && !urlTargetRolesReady
          ? undefined
          : resolveLink(
              db,
              link,
              entry.sourceId,
              entry.docId,
              fallbackRepresentationSourcePrefixes,
              referenceOnlySourcePrefixes,
            )?.docId;
      if (link.type === "shares-phone") {
        const claimant = phoneClaims.get(link.normalizedTarget);
        if (targetDocId === undefined && claimant !== undefined && claimant !== entry.docId) {
          targetDocId = claimant;
        }
        if (claimant === undefined) phoneClaims.set(link.normalizedTarget, entry.docId);
      }
      if (targetDocId !== undefined) {
        (resolvedTargets ??= {})[resolvedTargetKey(link.type, link.normalizedTarget)] = targetDocId;
      } else if (
        link.type === "url" &&
        urlTargetRolesReady &&
        knownUrlPatternDeclarationReady &&
        !urlTargetCouldResolve(db, knownUrlPatterns, link.normalizedTarget)
      ) {
        (discardedUrlTargets ??= []).push(link.normalizedTarget);
      }
    }
    if (resolvedTargets || discardedUrlTargets) {
      out.push({ docId: entry.docId, resolvedTargets, discardedUrlTargets });
    }
  }
  return out;
}

/**
 * Fold what {@link resolveExtractedLinks} found back into its entries.
 * Kept beside it so the pairing is visible: the resolve phase returns
 * targets alone to keep the worker hop small, and this is where they
 * rejoin the batch the writer is given.
 */
export function withResolvedTargets(
  entries: readonly ExtractedLinkBatchEntry[],
  resolved: ReadonlyArray<ExtractedLinkResolution>,
): ExtractedLinkBatchEntry[] {
  const byDoc = new Map(resolved.map((r) => [r.docId, r]));
  return entries.map((entry) => {
    const resolution = byDoc.get(entry.docId);
    if (!resolution) return entry;
    const discarded = new Set(resolution.discardedUrlTargets ?? []);
    return {
      ...entry,
      links: entry.links.filter(
        (link) => link.type !== "url" || !discarded.has(link.normalizedTarget),
      ),
      ...(resolution.resolvedTargets ? { resolvedTargets: resolution.resolvedTargets } : {}),
    };
  });
}

/**
 * Pure-write final phase: apply a batch whose links were extracted on the
 * cpu pool and resolved on a read handle. Nothing here reads the corpus to
 * decide anything — a document's links are deleted, its new ones inserted,
 * and the targets the read phase found are applied.
 *
 * The batch is deliberately NOT one transaction. Each document opens with
 * its own, its links go in chunks of `LINK_APPLY_CHUNK_SIZE`, each its own,
 * and a final one marks it extracted — so the write lock is released
 * between chunks and a document with thousands of links cannot hold it for
 * the duration. The fsync per chunk is the price of that.
 *
 * Optimistic-concurrency invariant: each row's `contentHash` was
 * captured by the compute pass. Before applying, we re-read the doc's
 * current `content_hash` AND `links_extracted_at`:
 *   - if `content_hash` shifted, the doc was re-upserted between
 *     compute and writer — our extracted links may not match the new
 *     content. Skip; `links_extracted_at` stays NULL so the next
 *     periodic tick re-extracts against the fresh content.
 *   - if `links_extracted_at` is non-NULL, another pass already
 *     finished extraction for this doc. Skip.
 *
 * This guarantees eventual consistency without per-row SAVEPOINTs:
 * skipped rows just retry on the next periodic tick.
 */
export function upsertExtractedLinksBatch(
  db: Db,
  rows: ExtractedLinkBatchEntry[],
  options: {
    token?: { requested(): boolean };
  } = {},
): {
  applied: number;
  skipped: number;
  extracted: number;
  /** Rows that haven't been processed because the token requested yield. */
  remaining: ExtractedLinkBatchEntry[];
} {
  if (rows.length === 0) return { applied: 0, skipped: 0, extracted: 0, remaining: [] };

  const token = options.token;
  const now = new Date().toISOString();
  const checkStmt = db.prepare<
    [string],
    {
      source_id: string;
      external_id: string;
      content_hash: string;
      metadata: string;
      extracted_content_hash: string | null;
      links_extracted_at: string | null;
    }
  >(
    `SELECT source_id, external_id, content_hash, metadata, extracted_content_hash,
            links_extracted_at FROM documents WHERE id = ?`,
  );
  const selectManagedLinkIds = db.prepare<[string, ...string[], number, number], { id: number }>(
    `SELECT id
       FROM document_links
      WHERE source_doc_id = ?
        AND link_type IN (${EXTRACT_LINKS_MANAGED_PLACEHOLDERS})
        AND id > ?
      ORDER BY id
      LIMIT ?`,
  );
  const deleteManagedLinkById = db.prepare("DELETE FROM document_links WHERE id = ?");
  const insertStmt = db.prepare(`
    INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at, metadata_json, provenance_kind, provenance_origin, provenance_version, declared_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(source_doc_id, link_type, normalized_target) DO UPDATE SET
      raw_target = excluded.raw_target,
      target_doc_id = NULL,
      resolved_at = NULL,
      metadata_json = excluded.metadata_json,
      provenance_kind = excluded.provenance_kind,
      provenance_origin = excluded.provenance_origin
  `);
  // Additive-only insert: preserves existing links (including resolved
  // target_doc_id). Used for best-effort content retention sources.
  const insertAdditiveStmt = db.prepare(`
    INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at, metadata_json, provenance_kind, provenance_origin, provenance_version, declared_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(source_doc_id, link_type, normalized_target) DO NOTHING
  `);
  // Apply a target the read phase already resolved. EXISTS-guarded for
  // every link type: resolution happens on a reader now, so a target can
  // be deleted between being found and being written, and a link pointing
  // at a document that no longer exists is the one outcome worse than an
  // unresolved link. A link left unresolved here is picked up by inbound
  // resolution when its target next lands, or by the reconcile pass.
  const resolveTargetStmt = db.prepare(
    `UPDATE document_links
        SET target_doc_id = ?, resolved_at = ?
      WHERE source_doc_id = ? AND link_type = ? AND normalized_target = ?
        AND target_doc_id IS NULL
        AND EXISTS (SELECT 1 FROM documents WHERE id = ?)`,
  );
  const sourceIdLookup = db.prepare<
    [string],
    {
      source_id: string;
      document_type: string | null;
      extracted_content_hash: string | null;
    }
  >(
    `SELECT source_id,
            json_extract(metadata, '$.documentType') AS document_type,
            extracted_content_hash
       FROM documents WHERE id = ?`,
  );
  const markStmt = db.prepare("UPDATE documents SET links_extracted_at = ? WHERE id = ?");

  // Cache best-effort lookups per sourceId within this batch to avoid
  // redundant PK lookups against sync_state.
  const bestEffortCache = new Map<string, boolean>();
  function isAdditive(sourceId: string): boolean {
    let v = bestEffortCache.get(sourceId);
    if (v === undefined) {
      v = isBestEffortRetention(db, sourceId);
      bestEffortCache.set(sourceId, v);
    }
    return v;
  }

  let applied = 0;
  let skipped = 0;
  let extracted = 0;

  // A document's links are applied in bounded sub-batches, each its own
  // transaction, with the preempt token checked between them.
  //
  // One document is not a bound on how long the writer is held: a single
  // issue or wiki page can carry hundreds of `references` links, and one
  // transaction over all of them holds the only write connection for as
  // long as they take to insert. The sub-batch bounds it — a document with
  // an unusual number of links costs the writer a series of short holds
  // rather than one long one. Resolution is not part of that cost; it
  // happened on the read handle, and what runs here is pure writing.
  //
  // Correctness across the split: every sub-batch re-checks the document's
  // `content_hash` and that `links_extracted_at` is still NULL, and
  // `links_extracted_at` is stamped only after the last one, so a document
  // stopped part-way still looks un-extracted and is never mistaken for a
  // finished one. A yield returns the entry carrying `appliedLinks`, so the
  // next attempt resumes from that offset. A crash carries nothing, and the
  // next pass redoes the document from the delete onward — idempotent, at
  // the cost of repeating the chunks it had already written.
  const stillExtractable = (row: ExtractedLinkBatchEntry): boolean => {
    if (
      row.expectedCollectorRosterRevision !== undefined &&
      !collectorRosterRevisionMatches(db, row.expectedCollectorRosterRevision)
    ) {
      return false;
    }
    const current = checkStmt.get(row.docId);
    if (!current) return false;
    // Re-upserted between compute and here: our links describe content that
    // no longer exists. Leave it unmarked so the next tick re-extracts.
    if (current.content_hash !== row.contentHash) return false;
    if (linkExtractionInputDigest(current) !== row.inputDigest) {
      return false;
    }
    // Another pass finished this document while we were working.
    if (current.links_extracted_at !== null) return false;
    return true;
  };

  const deleteManagedChunk = db.transaction(
    (
      row: ExtractedLinkBatchEntry,
      afterLinkId: number,
    ): { abandoned: boolean; deleted: number; throughLinkId: number; complete: boolean } => {
      if (!stillExtractable(row)) {
        return { abandoned: true, deleted: 0, throughLinkId: afterLinkId, complete: false };
      }
      const ids = selectManagedLinkIds.all(
        row.docId,
        ...EXTRACT_LINKS_MANAGED_TYPES,
        afterLinkId,
        LINK_APPLY_CHUNK_SIZE,
      );
      for (const { id } of ids) deleteManagedLinkById.run(id);
      return {
        abandoned: false,
        deleted: ids.length,
        throughLinkId: ids.at(-1)?.id ?? afterLinkId,
        // A full chunk may have ended exactly on the final row. Treat it as
        // incomplete so the next bounded transaction proves the range empty.
        complete: ids.length < LINK_APPLY_CHUNK_SIZE,
      };
    },
  );

  /** Insert one sub-batch. Returns rows inserted, or -1 if abandoned. */
  const applyChunk = db.transaction(
    (
      row: ExtractedLinkBatchEntry,
      chunk: ExtractedLink[],
      sourceId: string,
      additive: boolean,
    ): number => {
      if (!stillExtractable(row)) return -1;
      const stmt = additive ? insertAdditiveStmt : insertStmt;
      let insertedHere = 0;
      for (const link of chunk) {
        const targetDocId =
          row.resolvedTargets?.[resolvedTargetKey(link.type, link.normalizedTarget)];
        stmt.run(
          row.docId,
          link.type,
          link.rawTarget,
          link.normalizedTarget,
          now,
          metadataJsonFor(link),
          provenanceKindFor(link.type),
          sourceId,
          now,
        );
        insertedHere += 1;
        if (targetDocId !== undefined) {
          resolveTargetStmt.run(
            targetDocId,
            now,
            row.docId,
            link.type,
            link.normalizedTarget,
            targetDocId,
          );
        }
      }
      return insertedHere;
    },
  );

  /** Finish a document: duplicate-content links, then mark it extracted. */
  const closeRow = db.transaction(
    (
      row: ExtractedLinkBatchEntry,
      docMeta: { document_type: string | null; extracted_content_hash: string | null } | undefined,
    ): number => {
      if (!stillExtractable(row)) return -1;
      // Emit duplicate-content links for binary-extracted docs whose raw
      // extracted text matches another binary-extracted doc's. Keyed on
      // `extracted_content_hash` (independent of any per-provider rendering
      // wrapper) so cross-source pairs match.
      const dupLinks = linkDuplicateContentDocs(
        db,
        row.docId,
        docMeta?.extracted_content_hash ?? undefined,
        docMeta?.document_type ?? undefined,
      );
      markStmt.run(now, row.docId);
      // Bump link_stats dirty per-row. DELETE+INSERT shifts the total counts
      // and per-type buckets; one bump invalidates any in-flight compute
      // snapshot via the OCC token. Idempotent — multiple bumps within a
      // batch coalesce to one refresh.
      markLinkStatsDirty(db);
      return dupLinks;
    },
  );

  let i = 0;
  // The entry to resume from, when a document is interrupted part-way. It
  // replaces that document in `remaining` rather than being written back
  // into the caller's array — these rows arrive from a worker, and a caller
  // that still holds them should see what it handed over.
  let resumeEntry: ExtractedLinkBatchEntry | null = null;
  for (; i < rows.length; i++) {
    let row = rows[i];
    const docMeta = sourceIdLookup.get(row.docId);
    const sourceId = docMeta?.source_id ?? row.sourceId;
    const additive = isAdditive(row.sourceId);

    // A resumed document keeps the links it already wrote. A fresh
    // replacement first clears managed links in bounded transactions; the
    // continuation carries its delete cursor so preemption cannot restart a
    // high-cardinality delete forever or turn it into one unbounded write.
    const resumeFrom = row.appliedLinks ?? 0;
    if (!additive && resumeFrom === 0 && !row.deletionComplete) {
      let throughLinkId = row.deletedThroughLinkId ?? 0;
      let deletionAbandoned = false;
      while (true) {
        const deletion = deleteManagedChunk(row, throughLinkId);
        if (deletion.abandoned) {
          deletionAbandoned = true;
          break;
        }
        throughLinkId = deletion.throughLinkId;
        row = {
          ...row,
          deletedThroughLinkId: throughLinkId,
          deletionComplete: deletion.complete,
        };
        if (token?.requested() && deletion.deleted > 0) {
          resumeEntry = row;
          break;
        }
        if (deletion.complete) break;
      }
      if (deletionAbandoned) {
        skipped += 1;
        continue;
      }
      if (resumeEntry) break;
    } else if (!stillExtractable(row)) {
      skipped += 1;
      continue;
    }

    let insertedThisRow = 0;
    let abandoned = false;
    let yieldedAt: number | null = null;
    for (let offset = resumeFrom; offset < row.links.length; offset += LINK_APPLY_CHUNK_SIZE) {
      const chunk = row.links.slice(offset, offset + LINK_APPLY_CHUNK_SIZE);
      const insertedHere = applyChunk(row, chunk, sourceId, additive);
      if (insertedHere < 0) {
        abandoned = true;
        break;
      }
      insertedThisRow += insertedHere;
      if (token?.requested() && offset + LINK_APPLY_CHUNK_SIZE < row.links.length) {
        yieldedAt = offset + LINK_APPLY_CHUNK_SIZE;
        break;
      }
    }
    if (abandoned) {
      skipped += 1;
      continue;
    }
    // Unfinished: the document stays unmarked, and comes back carrying how
    // far it got so the next attempt continues instead of starting again.
    // The chunks that did commit are counted, so a direct caller's totals
    // describe the call it made. Note that the scheduler is not such a
    // caller: on a yield the runner re-enqueues the continuation and drops
    // this result object, so only the final, non-yielding call's counters
    // reach the task — its throughput log under-reports a batch that was
    // preempted part-way.
    if (yieldedAt !== null) {
      extracted += insertedThisRow;
      resumeEntry = { ...row, appliedLinks: yieldedAt };
      break;
    }

    const dupLinks = closeRow(row, docMeta);
    if (dupLinks < 0) {
      skipped += 1;
      continue;
    }
    applied += 1;
    // Count links actually stored — the resolvability gate drops the
    // permanently-unresolvable url majority, so this is below
    // `row.links.length` for link-heavy docs.
    extracted += insertedThisRow + dupLinks;

    if (token?.requested() && i + 1 < rows.length) {
      i += 1;
      break;
    }
  }

  return {
    applied,
    skipped,
    extracted,
    remaining: resumeEntry ? [resumeEntry, ...rows.slice(i + 1)] : rows.slice(i),
  };
}
