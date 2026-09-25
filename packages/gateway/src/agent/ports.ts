// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-side implementations of the agent tool ports. These adapt the
 * gateway's search pipeline + document repository to the narrow surface
 * the tool layer expects (`@omnesis/agent/tools/types`).
 *
 * Kept thin on purpose — every adapter is a few lines mapping a richer
 * gateway type to the wire-stable `DocRef` shape. The tools themselves
 * (and their tests) never see SearchPipeline or better-sqlite3.
 *
 * The watch port lives in its own file (`./watch-port.ts`) because it carries
 * more than a type mapping: it compiles a request into a watch and owns the
 * notify-only rule. It is the agent's one write surface into automations.
 */

import {
  LOOKUP_PEOPLE_MAX_LIMIT,
  RecordPortError,
  SqlPortNotPermittedError,
  SqlPortOverCapError,
  UnsupportedSearchFilterError,
} from "@omnesis/agent";
import {
  deriveRecordCitationFields,
  experimentalVisible,
  parseSourceKey,
  recordReference,
} from "@omnesis/core";
import { STREAM_COLUMN } from "../analytics/internal.js";
import { ScopedSqlDeniedError } from "../analytics/sandbox-tables.js";
import { readDocConnections } from "../brain/doc-connections.js";
import { assemblePersonLookup, type PersonLookupGate } from "../domain/person-lookup.js";
import {
  findDocumentIdBySourceExternalId,
  listDocumentsByIds,
  lookupDocumentIdsBySourceUrl,
} from "../data/repositories/DocumentRepository.js";
import { permittedSourceIds } from "../access/permitted-sources.js";
import {
  reconstructBoundDocumentRef,
  type BoundDocumentBinding,
} from "../analytics/bound-documents.js";
import { buildDocumentGraphWithBoundRows, expandOneHop } from "../domain/DocumentGraphService.js";
import { eventTrailFromGraph } from "../domain/buildTimeline.js";
import { getUrlCanonicalizers } from "../url-canonicalizers.js";
import { findConversationDocId } from "../sources/omnesis-chat/citation-writer.js";
import { OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID } from "../sources/omnesis-chat/ids.js";
import { mergeFilters } from "../search/filters.js";
import { parseQuery, type ParsedFilterToken } from "../search/query-parser.js";
import type Database from "better-sqlite3";
import type {
  Breadcrumb,
  ColumnType,
  DocRef,
  EventTrail,
  GraphVertex,
  RecordReference,
} from "@omnesis/core";
import type { AnalyticsCatalogEntry } from "@omnesis/source-sdk";
import type { OneHopNeighbor } from "../domain/DocumentGraphService.js";
import type { SourceId } from "@omnesis/types";
import type {
  DocumentByUrlPort,
  DocumentByUrlPortResult,
  DocumentPort,
  DocumentPortResult,
  PersonPort,
  PersonPortInput,
  PersonPortResult,
  SearchPort,
  SearchPortInput,
  SearchPortResult,
  SqlPort,
  SqlPortResult,
  SqlPortSource,
  RecordPort,
  RecordCitationResolved,
  TrailPort,
  TrailPortOptions,
} from "@omnesis/agent";

import type { AnalyticsDb, RecordTableSchema } from "../analytics-db.js";
import type { CorpusAuthorization } from "../access/corpus-authorization.js";
import type { SearchPipeline } from "../search/pipeline.js";
import type { SearchResultItem } from "../search/types.js";
import type { SyncStatusRegistry } from "../sync-status.js";

type Db = Database.Database;

/**
 * Look up the provider-declared `unitName` ("emails", "events",
 * "files", …) for a sourceId from the live sync-status registry. The
 * collector reports it on every `sync.status` event so the registry is
 * the authoritative in-memory cache for the gateway. Source-agnostic:
 * adding a new provider with `unitName: "voicemails"` automatically
 * propagates here.
 */
function unitNameFor(
  syncStatus: SyncStatusRegistry | undefined,
  sourceId: string,
): string | undefined {
  return syncStatus?.get(sourceId as SourceId)?.unitName;
}

// ─── SearchPort ────────────────────────────────────────────────────────────

/**
 * An authorization narrows the search to the sources its grant permits, and
 * resolving that set reads the database, so the two arrive together: a port
 * that could hold a grant without the means to enforce it is refused at
 * construction rather than left to pass every hit.
 */
export function createGatewaySearchPort(
  pipeline: SearchPipeline,
  syncStatus?: SyncStatusRegistry,
  db?: Db,
): SearchPort;
export function createGatewaySearchPort(
  pipeline: SearchPipeline,
  syncStatus: SyncStatusRegistry | undefined,
  db: Db,
  authorization: CorpusAuthorization,
): SearchPort;
export function createGatewaySearchPort(
  pipeline: SearchPipeline,
  syncStatus?: SyncStatusRegistry,
  db?: Db,
  authorization?: CorpusAuthorization,
): SearchPort {
  if (authorization && !db) {
    throw new Error("An authorized search port needs the database to resolve its sources");
  }
  return {
    async search(input: SearchPortInput, signal?: AbortSignal): Promise<SearchPortResult> {
      signal?.throwIfAborted();
      const t0 = Date.now();
      const parsed = authorization?.restricted ? parseQuery(input.query) : null;
      if (parsed) rejectUnsupportedRestrictedFilters(parsed.tokens);
      const requestedFilters = parsed ? mergeFilters(parsed.filters, input.filters) : input.filters;
      const permitted = authorization && db ? permittedSourceIds(db, authorization) : null;
      const response = await pipeline.search(
        {
          text: parsed?.text ?? input.query,
          limit: input.limit,
          filters: requestedFilters
            ? {
                sourceIds: requestedFilters.sourceIds,
                documentTypes: requestedFilters?.documentTypes,
                dateFrom: requestedFilters?.dateFrom,
                dateTo: requestedFilters?.dateTo,
              }
            : undefined,
          // Cognitive projection: in experimental mode the agent's ordinary search
          // reaches the understanding layer (open loops surface alongside docs,
          // down-weighted). Agent search port only — the public /search route
          // never sets this, so its behaviour is unchanged. The pipeline re-gates
          // on experimental defensively.
          cognitiveProjection: authorization?.restricted ? false : experimentalVisible(),
        },
        permitted ? { sourceIds: searchSourceIntersection(permitted) } : undefined,
      );
      // SearchPipeline does not yet expose a cancellation seam for its worker
      // and embedder phases. Never release a result after the HTTP/MCP caller
      // has gone away, even though an already-running search may finish its
      // bounded local computation in the background.
      signal?.throwIfAborted();
      // Adjacency-aware retrieval: the agent sees the refCount
      // connectedness hint and the auto-attached top-hit breadcrumb.
      let results: DocRef[] = response.results
        .filter((item) => !permitted || permitted.has(item.sourceId))
        .map((item) => searchResultToDocRef(item, syncStatus, !authorization?.restricted));
      // Resolved before the breadcrumb walk, because the walk can reach the
      // conversation too — see `attachBreadcrumbs`.
      const ownConversationDocId =
        db && input.currentConversationId
          ? findConversationDocId(
              db,
              OMNESIS_CHAT_PROVIDER_ID,
              OMNESIS_CHAT_SOURCE_ID,
              input.currentConversationId,
            )
          : null;
      if (ownConversationDocId) {
        results = results.filter((r) => r.documentId !== ownConversationDocId);
      }
      // Breadcrumb is attached here in the AGENT search port only — never on
      // the public /search route — so portal / iOS search payloads stay lean.
      if (db && !authorization?.restricted) {
        attachBreadcrumbs(db, results, ownConversationDocId);
      }
      // Durable memory is generally available; loop and temporal connections
      // remain experimental. Restricted callers receive no memory overlays.
      if (db && !authorization?.restricted) {
        attachDocConnections(db, results);
      }
      return {
        query: input.query,
        durationMs: response.timing.totalMs ?? Date.now() - t0,
        totalCandidates:
          (response.timing.bm25Candidates ?? 0) + (response.timing.vectorCandidates ?? 0) ||
          undefined,
        results,
      };
    },
  };
}

const NO_AUTHORIZED_SOURCE_ID = "\u0000omnesis:no-authorized-source";

/**
 * The hard source intersection handed to ranking. An empty permitted set
 * becomes one impossible id rather than no filter, because to the pipeline
 * "no source filter" means every source.
 */
function searchSourceIntersection(permitted: ReadonlySet<string>): string[] {
  return permitted.size > 0 ? [...permitted] : [NO_AUTHORIZED_SOURCE_ID];
}

/**
 * The query filters a restricted search does not forward. A person filter
 * resolves its reference through the people index, which spans every source,
 * and a tag filter reads a cross-source overlay; neither can be scoped to the
 * grant, so the search refuses them instead of silently dropping them. The
 * refusal names each token as the caller typed it (`by:maya`, `#work`), not
 * by the canonical key it parsed to.
 */
function rejectUnsupportedRestrictedFilters(tokens: readonly ParsedFilterToken[]): void {
  const unsupported = [
    ...new Set(
      tokens
        .filter((entry) => entry.filter === "person" || entry.filter === "tag")
        .map((entry) => entry.token),
    ),
  ];
  if (unsupported.length === 0) return;
  const plural = unsupported.length > 1;
  throw new UnsupportedSearchFilterError(
    unsupported,
    `This grant is restricted to selected sources, and the ${unsupported.join(", ")} ` +
      `${plural ? "filters are" : "filter is"} not available to it. Remove ${plural ? "them" : "it"} ` +
      "and search by text, source, type or date.",
  );
}

/** Top-hit count and per-hit neighbour count for the search breadcrumb. */
const BREADCRUMB_TOP_N = 3;
const BREADCRUMB_FANOUT = 3;

/**
 * Staple a tiny 1-hop breadcrumb onto the top few hits of an agent search, so
 * the most valuable adjacent document (an attachment, the calendar event
 * behind an email, a thread reply) arrives whether or not the agent decides
 * to walk the graph. Mutates the passed DocRefs in place. Bounded and
 * hub-avoiding because it rides the one shared `expandOneHop` walker.
 *
 * `excludeDocId`, when set, is the in-progress conversation's own document.
 * The walk is bidirectional and every citation this conversation has already
 * made is an edge from that document to the cited one — so without this the
 * conversation reappears as a neighbour of its own citations, handing back the
 * id that was just withheld from the result list.
 */
function attachBreadcrumbs(db: Db, results: DocRef[], excludeDocId: string | null = null): void {
  for (let i = 0; i < results.length && i < BREADCRUMB_TOP_N; i++) {
    const r = results[i]!;
    const { neighbors } = expandOneHop(db, r.documentId, { fanout: BREADCRUMB_FANOUT });
    const visible = excludeDocId
      ? neighbors.filter((n) => n.documentId !== excludeDocId)
      : neighbors;
    if (visible.length > 0) r.breadcrumb = visible.map(oneHopNeighborToBreadcrumb);
  }
}

/**
 * Attach the Cognition Steward's inline connections — the open loops each hit is a
 * source for, the durable annotations recorded about it, and the temporal
 * annotations it grounds — to every search result, in experimental mode. Mirrors
 * `attachBreadcrumbs`; mutates the DocRefs in place. This is the agent search
 * port only (never the public /search route), so the payload stays lean for
 * the portal / iOS clients.
 */
function attachDocConnections(db: Db, results: DocRef[]): void {
  for (const r of results) {
    const { openLoops, annotations, temporalAnnotations } = readDocConnections(db, r.documentId, {
      annotations: true,
      temporalAnnotations: experimentalVisible(),
      openLoops: experimentalVisible(),
    });
    if (openLoops.length > 0) r.openLoops = openLoops;
    if (annotations.length > 0) r.annotations = annotations;
    if (temporalAnnotations.length > 0) r.temporalAnnotations = temporalAnnotations;
  }
}

function searchResultToDocRef(
  item: SearchResultItem,
  syncStatus: SyncStatusRegistry | undefined,
  includeRefCount = false,
): DocRef {
  const ref: DocRef = {
    documentId: item.documentId,
    sourceType: item.sourceId.split(":", 1)[0] ?? item.sourceId,
    sourceId: item.sourceId,
    documentType: item.documentType,
    title: item.title,
    snippet: item.chunkText,
    ts: parseEpochMillis(item.sourceCreatedAt),
    url: item.sourceUrl,
    appUrl: item.appUrl,
    mimeType: item.mimeType,
    people: item.author ? [item.author] : undefined,
    unitName: unitNameFor(syncStatus, item.sourceId),
  };
  // refCount is computed for free by the ref-count search stage; surface it to
  // the agent only under the adjacency gate. Sparse by construction —
  // the stage sets it only when > 0, so an isolated doc simply has no field.
  if (includeRefCount && item.refCount !== undefined && item.refCount > 0) {
    ref.refCount = item.refCount;
  }
  return ref;
}

/**
 * Project a graph neighbour to the compact breadcrumb wire shape: the
 * neighbour's id (so the agent can `fetch_document` or `annotate` it), its
 * title, the edge label, and a deep link. No body — a breadcrumb is a
 * pointer, never a payload.
 */
function oneHopNeighborToBreadcrumb(n: OneHopNeighbor): Breadcrumb {
  const crumb: Breadcrumb = { documentId: n.documentId, edge: n.edgeType };
  if (n.title) crumb.title = n.title;
  if (n.appUrl) crumb.appUrl = n.appUrl;
  return crumb;
}

/**
 * Project a graph neighbour to a compact `DocRef` for the
 * `fetch_document(includeNeighbors)` result. Body deliberately dropped (the
 * re-bill multiplier punishes inlined bodies) — the agent fetches a
 * neighbour in full only if it decides to read it.
 */
function oneHopNeighborToDocRef(
  n: OneHopNeighbor,
  syncStatus: SyncStatusRegistry | undefined,
): DocRef {
  const sourceId = n.sourceId ?? "";
  return {
    documentId: n.documentId,
    sourceType: sourceId.split(":", 1)[0] || sourceId || "unknown",
    sourceId: sourceId || "unknown",
    documentType: n.documentType,
    title: n.title,
    ts: parseEpochMillis(n.sourceCreatedAt),
    url: n.sourceUrl,
    appUrl: n.appUrl,
    mimeType: n.mimeType,
    unitName: unitNameFor(syncStatus, sourceId),
  };
}

function parseEpochMillis(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read the canonical `metadata.extra.mimeType` off a parsed document
 * metadata blob. Attachments and file-like docs store their MIME type
 * here (see `buildAttachmentDocument` in `@omnesis/core`); renderers use
 * it to pick the file-type icon.
 */
function extraMimeType(metadata: Record<string, unknown> | undefined): string | undefined {
  const extra = metadata?.extra;
  if (typeof extra !== "object" || extra === null) return undefined;
  const mime = (extra as Record<string, unknown>).mimeType;
  return typeof mime === "string" ? mime : undefined;
}

// ─── DocumentPort ──────────────────────────────────────────────────────────

export function createGatewayDocumentPort(
  db: Db,
  syncStatus?: SyncStatusRegistry,
  limits?: { maxStoredDocumentBytes?: number },
  authorization?: CorpusAuthorization,
): DocumentPort {
  return {
    async fetch(
      documentId: string,
      opts?: { includeNeighbors?: boolean },
    ): Promise<DocumentPortResult | null> {
      const permitted = authorization ? permittedSourceIds(db, authorization) : null;
      const rows =
        limits?.maxStoredDocumentBytes === undefined && !permitted
          ? listDocumentsByIds(db, [documentId])
          : db.transaction((id: string, maxBytes: number | undefined) => {
              const size = db
                .prepare<[string], { source_id: string; stored_bytes: number }>(
                  `SELECT
                     source_id,
                     length(CAST(content AS BLOB)) +
                     length(CAST(metadata AS BLOB)) +
                     length(CAST(title AS BLOB)) AS stored_bytes
                   FROM documents
                   WHERE id = ?`,
                )
                .get(id);
              if (size && permitted && !permitted.has(size.source_id)) return [];
              if (size && maxBytes !== undefined && size.stored_bytes > maxBytes) {
                throw new Error("Document exceeds the configured read-size limit");
              }
              // The size check and full read share one synchronous SQLite
              // transaction/snapshot, so a collector update cannot enlarge
              // the body between authorization and materialization.
              return listDocumentsByIds(db, [id]);
            })(documentId, limits?.maxStoredDocumentBytes);
      const row = rows[0];
      if (!row) return null;
      const sourceType = row.sourceId.split(":", 1)[0] ?? row.sourceId;
      let metadata: Record<string, unknown> | undefined;
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = undefined;
      }
      const url = typeof metadata?.sourceUrl === "string" ? metadata.sourceUrl : undefined;
      const appUrl = typeof metadata?.appUrl === "string" ? metadata.appUrl : undefined;
      const documentType =
        typeof metadata?.documentType === "string" ? metadata.documentType : undefined;
      const mimeType = extraMimeType(metadata);
      const ref: DocRef = {
        documentId: row.id,
        sourceType,
        sourceId: row.sourceId,
        documentType,
        title: row.title,
        snippet: row.content.slice(0, 500),
        ts: parseEpochMillis(row.sourceCreatedAt),
        url,
        appUrl,
        mimeType,
        unitName: unitNameFor(syncStatus, row.sourceId),
      };
      // Inline connections on the deep read: open loops the document is a
      // source for, the durable annotations recorded about it (grounded priors
      // to reground, never facts), and the temporal annotations it grounds.
      // Only loop and temporal connections require experimental mode.
      if (!authorization?.restricted) {
        const conn = readDocConnections(db, row.id, {
          annotations: true,
          temporalAnnotations: experimentalVisible(),
          openLoops: experimentalVisible(),
        });
        if (conn.openLoops.length > 0) ref.openLoops = conn.openLoops;
        if (conn.annotations.length > 0) ref.annotations = conn.annotations;
        if (conn.temporalAnnotations.length > 0) {
          ref.temporalAnnotations = conn.temporalAnnotations;
        }
      }
      const result: DocumentPortResult = {
        ref,
        document: {
          id: row.id,
          sourceId: row.sourceId,
          title: row.title,
          content: row.content,
          metadata,
          sourceCreatedAt: row.sourceCreatedAt,
          updatedAt: row.updatedAt,
        },
      };
      // Honor includeNeighbors: a bounded 1-hop expansion via the one
      // shared walker — compact DocRefs, bodies dropped, ordered
      // most-structural-first (newest within a type). `neighborsTruncated`
      // tells the agent the set is a recency-ordered sample, not the full
      // neighbourhood.
      if (opts?.includeNeighbors && !authorization?.restricted) {
        const expansion = expandOneHop(db, row.id);
        if (expansion.neighbors.length > 0) {
          result.neighbors = expansion.neighbors.map((n) => oneHopNeighborToDocRef(n, syncStatus));
          result.neighborsTruncated = expansion.truncated;
        }
      }
      return result;
    },
  };
}

// ─── DocumentByUrlPort (lookup_document_by_url) ──────────────────────────

/**
 * Wraps the same `lookupDocumentIdsBySourceUrl` repo function that
 * powers `POST /documents/by-url` and the `omnesis lookup <url>` CLI —
 * URL canonicalisation chain runs server-side, so the agent can pass
 * the user's exact paste without sanitising.
 *
 * Returns at most one ref. When a URL legitimately fans out to several
 * docs (an email and its attachments share a `source_url`), the
 * adapter loads all candidates and picks the one with the earliest
 * `source_created_at` — typically the parent, since every source
 * today ingests an email/note/page before its attachments. Falling
 * back to the FIRST id from the underlying repo would be
 * non-deterministic (the repo SELECT has no ORDER BY, so on a fanout
 * the chosen row depends on storage layout).
 */
export function createGatewayDocumentByUrlPort(
  db: Db,
  syncStatus?: SyncStatusRegistry,
  authorization?: CorpusAuthorization,
): DocumentByUrlPort {
  return {
    async lookup(url: string): Promise<DocumentByUrlPortResult> {
      const t0 = Date.now();
      const matches = lookupDocumentIdsBySourceUrl(db, [url], getUrlCanonicalizers());
      const ids = matches.get(url) ?? [];
      if (ids.length === 0) {
        return { url, durationMs: Date.now() - t0 };
      }
      const permitted = authorization ? permittedSourceIds(db, authorization) : null;
      const rows = permitted
        ? db.transaction((candidateIds: readonly string[]) => {
            const sourceLookup = db.prepare<[string], { source_id: string }>(
              "SELECT source_id FROM documents WHERE id = ?",
            );
            const allowedIds = candidateIds.filter((id) => {
              const row = sourceLookup.get(id);
              return row ? permitted.has(row.source_id) : false;
            });
            // Authorization and materialization share one reader snapshot, and
            // denied candidate bodies are never loaded into the process.
            return allowedIds.length > 0 ? listDocumentsByIds(db, allowedIds) : [];
          })(ids)
        : listDocumentsByIds(db, ids);
      if (rows.length === 0) {
        return { url, durationMs: Date.now() - t0 };
      }
      // Pick the earliest-ingested row. Tiebreak on `id` so the choice
      // is stable when two rows share a timestamp (rare, but possible
      // on bulk imports). Empty / unparseable timestamps sort last so
      // a corrupted row never wins by accident.
      const row = rows.slice().sort((a, b) => {
        const ta = parseEpochMillis(a.sourceCreatedAt);
        const tb = parseEpochMillis(b.sourceCreatedAt);
        if (ta === undefined && tb === undefined) return a.id.localeCompare(b.id);
        if (ta === undefined) return 1;
        if (tb === undefined) return -1;
        if (ta !== tb) return ta - tb;
        return a.id.localeCompare(b.id);
      })[0]!;
      const sourceType = row.sourceId.split(":", 1)[0] ?? row.sourceId;
      let metadata: Record<string, unknown> | undefined;
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = undefined;
      }
      const sourceUrl = typeof metadata?.sourceUrl === "string" ? metadata.sourceUrl : undefined;
      const appUrl = typeof metadata?.appUrl === "string" ? metadata.appUrl : undefined;
      const documentType =
        typeof metadata?.documentType === "string" ? metadata.documentType : undefined;
      const ref: DocRef = {
        documentId: row.id,
        sourceType,
        sourceId: row.sourceId,
        documentType,
        title: row.title,
        snippet: row.content.slice(0, 500),
        ts: parseEpochMillis(row.sourceCreatedAt),
        url: sourceUrl,
        appUrl,
        mimeType: extraMimeType(metadata),
        unitName: unitNameFor(syncStatus, row.sourceId),
      };
      return { url, durationMs: Date.now() - t0, ref };
    },
  };
}

// ─── SqlPort ──────────────────────────────────────────────────────────────

const AGENT_SQL_QUERY_TIMEOUT_MS = 30_000;

/**
 * Wraps `AnalyticsDb.executeQuery` for the agent's `run_sql` tool.
 *
 * Read-only enforcement lives in the engine itself (DuckDB opened with
 * `access_mode=READ_ONLY` + `enable_external_access=false` per query)
 * so the adapter doesn't second-guess via regex. The runner wraps every
 * query in a sub-select + LIMIT, so the agent can pass plain `SELECT ...`
 * without manual row caps and cannot bypass the ceiling with SQL text.
 *
 * Beyond running the query, we enrich the result with `sources` and
 * `subjects` — looked up in the analytics catalog so clients can render
 * the right per-source icon and a friendly title without holding any
 * source-specific knowledge themselves. A source-scoped port looks them
 * (and row identities) up in the permitted slice of the catalog only, so
 * a table-less query can never surface denied-source metadata.
 *
 * Timing comes from the runner; we round-trip the original SQL so the
 * portal's "Open in SQL view" link reproduces exactly what the model
 * ran.
 */
export function createGatewaySqlPort(
  analytics: AnalyticsDb,
  opts?: { permittedSourceIds?: ReadonlySet<string> },
): SqlPort {
  return {
    async run(sql: string, runOpts): Promise<SqlPortResult> {
      const maxRows = runOpts?.maxRows ?? 200;
      // Fetch one row past the cap so an over-cap result is detectable without
      // a silent partial. If more than `maxRows` come back the query is too
      // broad — throw so the agent narrows it; the agent never reasons
      // over a clipped table.
      // A source-restricted denial arrives as a distinct error so the tool
      // wrapper can answer it actionably (drop the refused tables) rather
      // than as an opaque failure. Only a scoped port throws it — the
      // built-in agent and the operator's SQL view run unscoped.
      let result: Awaited<ReturnType<AnalyticsDb["executeQuery"]>>;
      try {
        result = await analytics.executeQuery(sql, {
          limit: maxRows + 1,
          timeoutMs: AGENT_SQL_QUERY_TIMEOUT_MS,
          signal: runOpts?.signal,
          ...(opts?.permittedSourceIds ? { permittedSourceIds: opts.permittedSourceIds } : {}),
        });
      } catch (error) {
        if (error instanceof ScopedSqlDeniedError) {
          throw new SqlPortNotPermittedError({
            tables: error.tables,
            tableFunctions: error.tableFunctions,
            shows: error.shows,
            macros: error.macros,
          });
        }
        throw error;
      }
      if (result.rowCount > maxRows) {
        throw new SqlPortOverCapError(maxRows);
      }
      const fullCatalog = await analytics.getCatalog();
      // A scoped port attributes and identifies results only against the
      // grant's permitted sources. The SQL gate above already refused every
      // real read outside the grant — but `enrichSqlWithCatalog` matches
      // `FROM`/`JOIN` mentions even inside comments, and
      // `deriveRowIdentities` matches projected aliases against primary-key
      // names, so a table-less query could still surface denied-source
      // metadata from the unrestricted catalog. Filter by the same exact
      // membership rule the gate enforces. Unscoped ports (built-in agent,
      // operator SQL view) keep the whole catalog.
      const permitted = opts?.permittedSourceIds;
      const catalog = permitted
        ? fullCatalog.filter((entry) => permitted.has(entry.sourceId))
        : fullCatalog;
      const { sources, subjects } = enrichSqlWithCatalog(catalog, sql);
      const rowIdentities = deriveRowIdentities(catalog, result.columns, result.rows);
      return {
        sql,
        columns: [...result.columns],
        rows: result.rows.map((r) => [...r]),
        rowCount: result.rowCount,
        // Never truncated — over-cap throws above.
        truncated: false,
        rowIdentities,
        durationMs: result.timing,
        sources,
        subjects,
      };
    },
  };
}

/**
 * Per-row record identity for a `run_sql` result.
 *
 * Identity is surfaced ONLY when the projected columns expose exactly one
 * known table's *full* primary key. That rule deliberately omits identity for
 * the cases where a row has no addressable source row:
 *   - aggregates (`COUNT(*)`, `AVG(...)` — no PK columns present),
 *   - projections that drop a PK column (a composite key partially selected),
 *   - joins/CTEs that surface several tables' PKs at once (ambiguous — which
 *     table is THE row? — so neither is claimed).
 * In all those cases the entry is `null`: identity is never fabricated. The
 * returned array is positionally aligned with `rows`. Returns `undefined`
 * (field omitted) when no known table's PK is covered at all.
 *
 * Each non-null entry is built via `recordReference`, so its `recordKey`
 * round-trips through `analyticsRowKey` exactly like the `same-entity`
 * bound-row identity does.
 */
function deriveRowIdentities(
  catalog: ReadonlyArray<AnalyticsCatalogEntry>,
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): Array<RecordReference | null> | undefined {
  // Find every known table whose full primary key is covered by the result's
  // columns. Column matching is case-sensitive on the catalog's declared
  // names (DuckDB preserves them); a result column named `id` only ever maps
  // to one table's PK because we require the *complete* PK to be present.
  const colIndex = new Map<string, number>();
  columns.forEach((c, i) => {
    // First occurrence wins; a duplicated column name (a self-join) makes the
    // mapping ambiguous, so we don't claim identity off it.
    if (!colIndex.has(c)) colIndex.set(c, i);
  });

  const candidates: {
    table: string;
    pkCols: { name: string; index: number; castType: ColumnType }[];
  }[] = [];
  for (const entry of catalog) {
    if (entry.primaryKey.length === 0) continue;
    const pkCols: { name: string; index: number; castType: ColumnType }[] = [];
    let covered = true;
    for (const pkName of entry.primaryKey) {
      const idx = colIndex.get(pkName);
      if (idx === undefined) {
        covered = false;
        break;
      }
      const castType = entry.columns.find((c) => c.name === pkName)?.type ?? "VARCHAR";
      pkCols.push({ name: pkName, index: idx, castType });
    }
    if (covered) candidates.push({ table: entry.tableName, pkCols });
  }

  // Zero qualifying tables → no identity to surface. More than one → the
  // projection is ambiguous (a join across known tables); refuse to pick.
  if (candidates.length !== 1) return undefined;
  const { table, pkCols } = candidates[0]!;

  return rows.map((row) => {
    const primaryKeyColumns = pkCols.map((pk) => {
      const raw = row[pk.index];
      return {
        name: pk.name,
        // PK values stringify deterministically — `analyticsRowKey` is built
        // over strings, matching how the bound-row identity is keyed.
        value: raw === null || raw === undefined ? "" : String(raw),
        castType: pk.castType,
      };
    });
    // A NULL primary-key value can't address a row — never mint a phantom
    // identity for it. The stream column is the exception: its empty value
    // is the shared stream of a table that keys its rows by stream.
    if (primaryKeyColumns.some((c) => c.value === "" && c.name !== STREAM_COLUMN)) return null;
    return recordReference(table, primaryKeyColumns);
  });
}

// ─── RecordPort (cite_record) ───────────────────────────────────────────────

/**
 * Wraps `AnalyticsDb` + the document store for the agent's `cite_record` tool.
 *Given a `RecordReference` the agent obtained from `run_sql` and the
 * row snapshot it saw, it:
 *   1. loads the table's declared contract from the analytics catalog
 *      (`semanticTimeColumn`, the record display spec, the column defs);
 *   2. rejects an unknown table or a timeless row (frozen rule: a timeless row
 *      is not a timeline record citation);
 *   3. derives the title, key fields, semantic time, and redacted snapshot via
 *      the source-SDK's pure `deriveRecordCitationFields` (no source-specific
 *      code here — every noun/title/column comes from the provider's
 *      descriptor);
 *   4. resolves the co-described document id when the table declares a
 *      `boundDocument` binding and a matching document exists.
 *
 * The tool layer never touches DuckDB or the document store — it gets a fully
 * resolved `RecordCitationResolved` back (or a `RecordPortError`).
 */
export function createGatewayRecordPort(db: Database.Database, analytics: AnalyticsDb): RecordPort {
  return {
    async resolve(input): Promise<RecordCitationResolved> {
      const { reference, snapshot } = input;
      const resolved = await resolveRecordCitation(db, analytics, {
        table: reference.table,
        recordKey: reference.recordKey,
        primaryKeyColumns: reference.primaryKeyColumns,
        snapshot,
      });
      if (resolved.kind === "unknown_table") {
        throw new RecordPortError({ reason: "unknown_table", table: reference.table });
      }
      if (resolved.kind === "not_timeline_eligible") {
        throw new RecordPortError({ reason: "not_timeline_eligible", table: reference.table });
      }
      return resolved.citation;
    },
  };
}

/**
 * Shared resolve step for record citations — the single place that turns a
 * `(table, primaryKeyColumns, snapshot)` triple into a fully-derived,
 * client-ready {@link RecordCitationResolved}. Both `cite_record`
 * (`createGatewayRecordPort`) and `trace_connections` (`createGatewayTrailPort`,
 * surfacing bound rows) call this so a record is derived identically no matter
 * how it reached the agent.
 *
 * All source-specific work lives behind the source-SDK's pure
 * `deriveRecordCitationFields` (title / key fields / semantic time / redacted
 * snapshot from the declared contract) + the row→document inverse — there is no
 * `if (sourceType === …)` here.
 *
 * Returns a tagged result rather than throwing so the trail walk can skip a
 * non-citable row (unknown table or timeless) and keep going, while the
 * `cite_record` tool maps the same tags to its `RecordPortError`s.
 */
type RecordResolveResult =
  | { kind: "ok"; citation: RecordCitationResolved }
  | { kind: "unknown_table" }
  | { kind: "not_timeline_eligible" };

async function resolveRecordCitation(
  db: Database.Database,
  analytics: AnalyticsDb,
  input: {
    table: string;
    recordKey: string;
    primaryKeyColumns: ReadonlyArray<{ name: string; value: string; castType?: string }>;
    snapshot: Record<string, string | number | boolean | null>;
  },
): Promise<RecordResolveResult> {
  const table = await analytics.getRecordTableSchema(input.table);
  if (!table || !table.record) {
    return { kind: "unknown_table" };
  }

  // Frozen rule: a timeless table cannot produce a timeline record
  // citation. Reject before deriving so the agent narrows to a timed table.
  if (table.semanticTimeColumn === null) {
    return { kind: "not_timeline_eligible" };
  }

  const fields = deriveRecordCitationFields(
    {
      displayName: table.displayName,
      columns: table.columns,
      record: table.record,
      semanticTimeColumn: table.semanticTimeColumn,
    },
    input.snapshot,
  );

  // The declared column exists but this row's value is empty → not a
  // point-in-time record. Treat exactly like a timeless table.
  if (fields.semanticTime === null) {
    return { kind: "not_timeline_eligible" };
  }

  const boundDocumentId = resolveBoundDocumentId(db, table, input.primaryKeyColumns);
  const sourceType = parseSourceKey(table.sourceId).sourceType;

  return {
    kind: "ok",
    citation: {
      table: input.table,
      recordKey: input.recordKey,
      primaryKeyColumns: input.primaryKeyColumns.map((c) => ({ ...c })),
      title: fields.title,
      keyFields: fields.keyFields,
      semanticTime: fields.semanticTime,
      snapshot: fields.redactedSnapshot,
      sourceId: table.sourceId,
      sourceType,
      tableDisplayName: table.displayName,
      boundDocumentId,
    },
  };
}

/**
 * Resolve the co-described document id for a cited row, or `null` when
 * the table declares no `boundDocument` binding, the row's PK doesn't invert to
 * a document ref, or no matching document exists. The row→document inverse of
 * the graph walker's document→row `reconstructRowKey`.
 */
function resolveBoundDocumentId(
  db: Database.Database,
  table: RecordTableSchema,
  primaryKeyColumns: ReadonlyArray<{ name: string; value: string; castType?: string }>,
): string | null {
  if (!table.boundDocument) return null;

  const columnTypes: Record<string, ColumnType> = {};
  for (const c of table.columns) columnTypes[c.name] = c.type;
  const binding: BoundDocumentBinding = {
    tableName: table.tableName,
    tableDisplayName: table.displayName,
    sourceId: table.sourceId,
    primaryKey: table.primaryKey,
    columns: table.columns.map((c) => c.name),
    columnTypes,
    spec: table.boundDocument,
  };

  const pkValues = new Map<string, string>();
  for (const c of primaryKeyColumns) pkValues.set(c.name, c.value);
  // A stream-keyed table addresses its rows by stream too: a reference that
  // names none cannot say which device's document it means, so none is claimed.
  if (table.streamKeyed && !pkValues.has(STREAM_COLUMN)) return null;

  const ref = reconstructBoundDocumentRef(pkValues, binding);
  if (!ref) return null;
  return findDocumentIdBySourceExternalId(
    db,
    ref.sourceId,
    ref.externalId,
    pkValues.get(STREAM_COLUMN),
  );
}

/**
 * Pull `FROM <ident>` / `JOIN <ident>` table names out of the SQL, look
 * each one up in the analytics catalog, and return source attribution
 * + table display names. Source-agnostic: every fact comes from the
 * catalog entry that the source's own provider package wrote.
 */
function enrichSqlWithCatalog(
  catalog: ReadonlyArray<AnalyticsCatalogEntry>,
  sql: string,
): { sources: SqlPortSource[]; subjects: string[] } {
  const tableNames = extractTableNamesFromSql(sql);
  if (tableNames.length === 0) return { sources: [], subjects: [] };

  const byTable = new Map<string, (typeof catalog)[number]>();
  for (const entry of catalog) byTable.set(entry.tableName, entry);

  const subjects: string[] = [];
  const sources: SqlPortSource[] = [];
  const sourceSeen = new Set<string>();
  const subjectSeen = new Set<string>();
  for (const name of tableNames) {
    const entry = byTable.get(name);
    if (!entry) continue;
    if (entry.displayName && !subjectSeen.has(entry.displayName)) {
      subjectSeen.add(entry.displayName);
      subjects.push(entry.displayName);
    }
    if (!sourceSeen.has(entry.sourceId)) {
      sourceSeen.add(entry.sourceId);
      const sourceType = entry.sourceId.split(":", 1)[0] ?? entry.sourceId;
      sources.push({
        sourceId: entry.sourceId,
        sourceType,
        // The source's own human-facing name is not on the catalog
        // entry today; fall back to a humanised slug. The portal /
        // iOS clients overlay their own source-meta map for the
        // final label, so this is just a sensible default.
        displayName: humaniseSlug(sourceType),
      });
    }
  }
  return { sources, subjects };
}

function extractTableNamesFromSql(sql: string): string[] {
  if (!sql) return [];
  // Strip string literals (single- and double-quoted) first so a column
  // alias or filter value like `WHERE x = 'from foo'` doesn't get matched
  // as a table reference. Standard SQL escapes a quote by doubling it
  // (`'it''s'`), which the non-greedy match handles correctly because
  // each pair is consumed as two separate `''` segments.
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  const seen = new Set<string>();
  const out: string[] = [];
  // Schema-qualified names like `analytics.web_history` resolve to the
  // rightmost identifier — the catalog stores bare table names, so the
  // schema prefix is informational only.
  const re = /\b(?:from|join)\s+(?:[a-zA-Z_][a-zA-Z0-9_]*\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function humaniseSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

// ─── PersonPort (lookup_people) ───────────────────────────────────────────

/**
 * Fuzzy person lookup adapter. The heavy assembly — `searchPeople` plus the
 * per-candidate alias / channel-count (and experimental cognitive-backlink)
 * follow-ups — lives in the pure {@link assemblePersonLookup}. When a
 * {@link PersonLookupGate} is wired the port delegates it to the read-worker
 * pool (off the main event loop); absent a gate it runs the same assembly
 * synchronously on the main thread. Either way the port owns the limit clamp,
 * the timing, and the `experimental` computation — the worker never reads env.
 */
export function createGatewayPersonPort(
  db: Db,
  opts?: { lookupGate?: PersonLookupGate },
): PersonPort {
  return {
    async lookup(input: PersonPortInput): Promise<PersonPortResult> {
      const t0 = Date.now();
      const requested = input.limit ?? 5;
      // Re-clamp here so non-tool callers (port tests bypass zod) get
      // the same upper bound as the agent does via `lookupPeopleArgsSchema`.
      const limit = Math.min(LOOKUP_PEOPLE_MAX_LIMIT, Math.max(1, requested));
      // `experimental` is a main-thread env read — compute it here and pass the
      // boolean into the (possibly off-thread) assembly, never inside the worker.
      const experimental = experimentalVisible();
      const results = opts?.lookupGate
        ? await opts.lookupGate.lookupPeople(input.query, limit, { experimental })
        : assemblePersonLookup(db, input.query, limit, { experimental });

      return {
        query: input.query,
        durationMs: Date.now() - t0,
        results,
      };
    },
  };
}

// ─── TrailPort (trace_connections) ──────────────────────────────────────────────

export function createGatewayTrailPort(db: Db, analytics: AnalyticsDb): TrailPort {
  return {
    async build(seedIds: ReadonlyArray<string>, opts?: TrailPortOptions): Promise<EventTrail> {
      // Resolve each seed against the documents table — accept full ids
      // and unique prefixes (mirrors the /documents/:id/graph route).
      // An empty or unresolved seed throws; the tool wrapper translates
      // that into a kind:"error" ToolResult.
      if (seedIds.length === 0) throw new Error("no seeds supplied");
      const resolved: string[] = [];
      const seen = new Set<string>();
      for (const idOrPrefix of seedIds) {
        const trimmed = idOrPrefix.trim();
        if (trimmed.length === 0) throw new Error("seed id is empty");
        const rows = db
          .prepare<[string], { id: string }>("SELECT id FROM documents WHERE id LIKE ? LIMIT 2")
          .all(`${trimmed}%`);
        if (rows.length === 0) throw new Error(`seed not found: ${trimmed}`);
        if (rows.length > 1) {
          throw new Error(
            `ambiguous seed prefix: ${trimmed} (${rows.map((r) => r.id).join(", ")})`,
          );
        }
        const fullId = rows[0]!.id;
        if (seen.has(fullId)) continue;
        seen.add(fullId);
        resolved.push(fullId);
      }
      // trace_connections honesty: the tool advertises depth 4 / fanout 25,
      // so apply that documented budget when the call is unparameterised
      // rather than falling through to the walker's heavier 10 / 50 defaults —
      // the walk's cost then matches what the tool promises.
      //
      // Surface `same-entity` bound rows. The two-phase walk attaches an
      // `analytics-row` vertex (with its identity + projected snapshot) for
      // every reachable document whose source declares a `boundDocument`; we
      // then derive each row's record-citation fields the SAME way `cite_record`
      // does (the shared `resolveRecordCitation` step) so the timeline can
      // surface a point-in-time record and dedup it against its document.
      const graph = await buildDocumentGraphWithBoundRows(db, analytics, resolved, {
        depth: opts?.depth ?? 4,
        fanoutCap: opts?.fanoutCap ?? 25,
      });
      await attachRecordFields(db, analytics, graph);
      return eventTrailFromGraph(graph);
    },
  };
}

/**
 * Derive the client-ready record-citation fields for every `analytics-row`
 * vertex on a trail graph and stamp them onto `vertex.record`, reusing
 * the same `resolveRecordCitation` step `cite_record` uses. A row whose table
 * is unknown or timeless (or whose semantic-time value is empty on this row) is
 * left without a `record` — the timeline builder then drops it (a timeless row
 * is not a record citation, frozen rule), and a deduped doc keeps its plain
 * document event.
 *
 * The vertex already carries the row's projected `row` snapshot + structured
 * `rowPrimaryKeyColumns` from `attachBoundRows`, so this needs no extra DuckDB
 * read beyond the table-contract lookup the resolve step does (cached).
 */
async function attachRecordFields(
  db: Db,
  analytics: AnalyticsDb,
  graph: { vertices: GraphVertex[] },
): Promise<void> {
  for (const v of graph.vertices) {
    if (v.kind !== "analytics-row" || !v.tableName || !v.rowPrimaryKeyColumns) continue;
    const snapshot: Record<string, string | number | boolean | null> = {};
    for (const [k, val] of Object.entries(v.row ?? {})) {
      snapshot[k] =
        val === null ||
        typeof val === "string" ||
        typeof val === "number" ||
        typeof val === "boolean"
          ? val
          : String(val);
    }
    const resolved = await resolveRecordCitation(db, analytics, {
      table: v.tableName,
      recordKey: v.id,
      primaryKeyColumns: v.rowPrimaryKeyColumns,
      snapshot,
    });
    if (resolved.kind !== "ok") continue;
    const c = resolved.citation;
    v.record = {
      recordKey: c.recordKey,
      table: c.table,
      tableDisplayName: c.tableDisplayName,
      title: c.title,
      keyFields: c.keyFields,
      semanticTime: c.semanticTime,
      sourceId: c.sourceId,
      sourceType: c.sourceType,
      boundDocumentId: c.boundDocumentId,
      snapshot: c.snapshot,
    };
  }
}
