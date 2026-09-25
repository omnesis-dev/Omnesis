// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, experimentalVisible } from "@omnesis/core";
import { type SyncCursor } from "@omnesis/source-sdk";
import {
  buildPage,
  clampLimit,
  scopeSatisfies,
  SCOPE_WRITE_ALL,
  trySourceId,
  type DocumentInput,
} from "@omnesis/types";
import { normalizeSnapshot } from "../../absence/snapshot-claims.js";
import { enforceBroadWriteScope, enforceWriteScopeForSource, scope } from "../scope.js";
import { DOCUMENTS_BODY_LIMIT_BYTES, ingestBodyLimit } from "../body-limits.js";
import { validateJson } from "../validate.js";
import {
  prepareStructuredPageBody,
  acknowledgeStructuredPageBody,
} from "../schemas/pending-source-page.js";
import {
  beginSyncAttemptBody,
  deleteDocumentsBody,
  documentsBulkBody,
  documentsByUrlBody,
  documentsContentHashSiblingsBody,
  documentsExistsBody,
  documentsStatsBulkBody,
  ingestDocumentsBody,
  reconcileDocumentsBody,
  revokeSyncAttemptBody,
  setSyncStateBody,
  sourceSyncMetaBody,
  upsertWithCursorBody,
} from "../schemas/index.js";
import { toRecentDocumentDto, toListedDocumentDto } from "../dto/document-dto.js";
import { assertExternalDocumentWrite, isGatewayInternalSource } from "../../internal-sources.js";
import { documentsMetadataCodec, syncStateCursorCodec } from "../../data/json-columns.js";
import { getExtractedDatesForDocument } from "../../enrichment/dates/storage.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { decodePageCursor, encodePageCursor } from "../pagination-cursor.js";
import { documentsRateLimiter } from "../../rate-limit.js";
import { clientIp, isLoopbackRequest } from "./admin/internals.js";
import type { RouteApp } from "./types.js";
import type { DocumentService } from "../services/DocumentService.js";
import type { SourceService } from "../services/SourceService.js";
import type { WriteGate } from "../../write-gate.js";
import type { AnalyticsRecentCursor } from "../../analytics-db.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("gateway:http").child("routes:documents");

interface RecentDocumentCursor {
  sourceId: string;
  sourceCreatedAt: string;
  id: string;
}

function requireSourceId(value: string): string {
  const sourceId = trySourceId(value);
  if (!sourceId) throw new BadRequestError("Invalid source id");
  return sourceId;
}

function parseRecentDocumentCursor(
  raw: string | undefined,
  scopeName: string,
  sourceId: string,
): RecentDocumentCursor | null {
  return decodePageCursor(raw, scopeName, (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const value = payload as Record<string, unknown>;
    if (
      value.sourceId !== sourceId ||
      typeof value.sourceCreatedAt !== "string" ||
      typeof value.id !== "string"
    ) {
      return null;
    }
    return { sourceId, sourceCreatedAt: value.sourceCreatedAt, id: value.id };
  });
}

type SourceRecentCursor =
  | { kind: "documents"; sourceId: string; sourceCreatedAt: string; id: string }
  | {
      kind: "analytics";
      sourceId: string;
      table: string;
      after: AnalyticsRecentCursor;
    };

function parseSourceRecentCursor(
  raw: string | undefined,
  sourceId: string,
): SourceRecentCursor | null {
  return decodePageCursor(raw, "source-recent", (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const value = payload as Record<string, unknown>;
    if (value.sourceId !== sourceId) return null;
    if (
      value.kind === "documents" &&
      typeof value.sourceCreatedAt === "string" &&
      typeof value.id === "string"
    ) {
      return {
        kind: "documents",
        sourceId,
        sourceCreatedAt: value.sourceCreatedAt,
        id: value.id,
      };
    }
    if (
      value.kind === "analytics" &&
      typeof value.table === "string" &&
      (value.timeValue === null ||
        typeof value.timeValue === "string" ||
        typeof value.timeValue === "number" ||
        typeof value.timeValue === "boolean") &&
      Array.isArray(value.keyValues) &&
      value.keyValues.every(
        (item) =>
          item === null ||
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean",
      )
    ) {
      return {
        kind: "analytics",
        sourceId,
        table: value.table,
        after: {
          timeValue: value.timeValue,
          keyValues: value.keyValues,
        },
      };
    }
    return null;
  });
}

export interface DocumentRoutesDeps {
  db: Db;
  writeGate: WriteGate;
  documentService: DocumentService;
  sourceService: SourceService;
  /**
   * Read-only handle on the indexer DB. Used by
   * `POST /documents/content-hash-siblings`, which joins `indexed_documents`
   * back onto itself by `content_hash`. Omitted in test paths that don't
   * wire an index DB; the endpoint then degrades to "each input doc has
   * only itself as a sibling".
   */
  indexDb?: Db;
}

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `DELETE /documents/:id?tombstone=` — absent means the durable tombstone is written. */
function parseTombstoneFlag(raw: string | undefined): boolean {
  if (raw === undefined || raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new BadRequestError("tombstone must be 0, 1, true or false");
}

function summarizeCursor(cursor: SyncCursor): string {
  const parts: string[] = [];
  // A source that declares versioned state stores its bookmark inside an
  // envelope, so the interesting fields are a level down. Say which version
  // it is too: a log line that shows a source resuming is much more useful
  // when it also shows which shape it resumed from.
  const outer = cursor as Record<string, unknown>;
  const enveloped = outer.e === 1 && typeof outer.v === "number" && typeof outer.state === "object";
  if (enveloped) parts.push(`stateVersion=${String(outer.v)}`);
  const c = (enveloped ? outer.state : outer) as Record<string, unknown>;
  if (typeof c.phase === "string") parts.push(`phase=${c.phase}`);
  if (typeof c.cycleIndex === "number") parts.push(`cycle=${c.cycleIndex}`);
  if (typeof c.page === "number") parts.push(`page=${c.page}`);
  if (c.anchorsByIdentifier && typeof c.anchorsByIdentifier === "object") {
    parts.push(`anchors=${Object.keys(c.anchorsByIdentifier as object).length}`);
  }
  if (typeof c.lastCycleCompletedAt === "string") parts.push(`lastCycle=${c.lastCycleCompletedAt}`);
  return parts.length ? parts.join(" ") : `keys=${Object.keys(c).length}`;
}

/**
 * Document CRUD + per-source count/stats/recent. Registered before search +
 * /documents/list etc. Mirrors the original block at server.ts:2354-2538.
 */
export function mountDocumentCoreRoutes(app: RouteApp, deps: DocumentRoutesDeps): void {
  const { db, documentService, sourceService, indexDb } = deps;
  const ingestLimiter = documentsRateLimiter();

  app.post(
    "/documents",
    scope.writeAny(),
    ingestBodyLimit(DOCUMENTS_BODY_LIMIT_BYTES),
    validateJson(ingestDocumentsBody),
    async (c) => {
      // Per-IP rate limit. The ceiling is generous (the collector is a
      // legitimate high-volume ingest client) — it only catches a pathological
      // write loop, not normal batched bootstrap ingestion. Loopback is exempt
      // (a same-host ingest client already has full local access); the check
      // reads the raw socket so a forwarded IP can't spoof it.
      if (!isLoopbackRequest(c) && ingestLimiter.consume(clientIp(c))) {
        return c.json({ error: "Too many ingest requests — try again later" }, 429, {
          "Retry-After": "60",
        });
      }
      const { documents, writeEpochs } = c.req.valid("json");
      // The schema enforces "is an array of objects" at the boundary; the
      // per-document shape is validated and normalized inside DocumentService
      // (which is the source of truth for the DocumentInput contract).
      const docs = documents as unknown as DocumentInput[];
      const auth = c.get("auth");
      documentService.enforceWriteScope(auth.scopes, docs);
      // Reject documents for a removed (tombstoned) source from every writer,
      // and for a paused push source from scoped writers. Mixed batches are
      // partially accepted; the rejected sourceIds + reasons go back in the
      // response so the push client can stop and surface the right state.
      const { allowed, rejected } = sourceService.gatePush(
        docs.map((d) => d.sourceId),
        auth,
      );
      const accepted = rejected.length ? docs.filter((d) => allowed.has(d.sourceId)) : docs;
      // Generated day documents are read-only ledger mirrors — no route
      // client legitimately ingests them (the source-owned projection
      // writes below this layer). Refuse before any write.
      for (const doc of accepted) assertExternalDocumentWrite(doc.sourceId);
      // Push sources (browser extension, Apple Health) self-register their
      // `sources` row on first ingest so they surface in the sources list
      // without a manual "Add", and a second device joins a source whose type
      // hosts several — before the row lookup below, which refuses a hosting
      // device that is not yet a member. See SourceService.ensurePushSourcesRegistered.
      await sourceService.ensurePushSourcesRegistered(
        accepted.map((document) => document.sourceId),
        auth,
      );
      const broadWriter = scopeSatisfies(auth.scopes, SCOPE_WRITE_ALL);
      // Every write is fenced on the caller's own cursor row, so a member's
      // epoch never collides with a sibling member's claim on the same source.
      const cursorRows = Object.fromEntries(
        [...new Set(accepted.map((document) => document.sourceId))].map((sourceId) => [
          sourceId,
          sourceService.cursorRowFor(sourceId, auth),
        ]),
      );
      const streams = Object.fromEntries(
        Object.keys(cursorRows).map((sourceId) => [
          sourceId,
          sourceService.streamFor(sourceId, auth),
        ]),
      );
      const replicaVersionPolicies = Object.fromEntries(
        Object.keys(cursorRows)
          .map((sourceId) => [sourceId, sourceService.replicaVersionPolicy(sourceId)] as const)
          .filter(
            (entry): entry is readonly [string, "source-updated-at"] => entry[1] !== undefined,
          ),
      );
      const effectiveWriteEpochs = broadWriter
        ? writeEpochs
        : Object.fromEntries(
            Object.entries(cursorRows).map(([sourceId, cursorRow]) => [
              sourceId,
              documentService.getWipeEpoch(sourceId, cursorRow),
            ]),
          );
      const result = await documentService.ingest(
        accepted,
        effectiveWriteEpochs,
        true,
        cursorRows,
        streams,
        replicaVersionPolicies,
        sourceService.sourceWireAuthority(Object.keys(cursorRows), auth),
      );
      // `rejected` is omitted when empty so the common-path response stays
      // byte-identical; push clients treat an absent field as "no rejections".
      return c.json(rejected.length ? { ...result, rejected } : result);
    },
  );

  app.post("/documents/delete", scope.writeAny(), validateJson(deleteDocumentsBody), async (c) => {
    const { providerId, sourceId, externalIds, writeEpoch } = c.req.valid("json");
    const auth = c.get("auth");
    enforceWriteScopeForSource(auth.scopes, sourceId);
    // A deletion-only batch (no accompanying documents to ingest) has no
    // other call site that would surface a removed/paused rejection —
    // gate it here explicitly so a paused source's buffered deletions
    // don't apply while the source is paused (matches /documents' gate).
    const { rejected } = sourceService.gatePush([sourceId], auth);
    if (rejected.length > 0) {
      return c.json({ deleted: 0, rejected });
    }
    // Generated day documents are read-only ledger mirrors (see the
    // guard on DELETE /documents/:id) — a batch tombstone here would
    // suppress the day exactly the same way. Refuse before any write.
    assertExternalDocumentWrite(sourceId);
    // This compatibility endpoint cannot couple a delete to cursor
    // invalidation. Replicated sources must use /documents/with-cursor, whose
    // holder-only tombstones and sibling resets commit in one transaction.
    if (sourceService.isReplicated(sourceId)) {
      return c.json(
        { deleted: 0, rejected: true, reason: "replicated-deletion-requires-cursor" },
        409,
      );
    }
    const cursorRow = sourceService.cursorRowFor(sourceId, auth);
    const result = await documentService.deleteByIds(
      providerId,
      sourceId,
      externalIds,
      scopeSatisfies(auth.scopes, SCOPE_WRITE_ALL)
        ? writeEpoch
        : documentService.getWipeEpoch(sourceId, cursorRow),
      true,
      cursorRow,
      sourceService.streamFor(sourceId, auth),
      sourceService.sourceWireAuthority([sourceId], auth),
    );
    return c.json(result);
  });

  // User-initiated single-document privacy delete. Keyed by the
  // internal document id (which every client already holds from the doc
  // page or a recent-list row), so the caller doesn't need to know the
  // `(provider, source, external)` triple. Resolves the row, then removes
  // the document + its attachment children and cleans the index. By default
  // it also writes a durable tombstone so a re-sync / re-capture can't
  // resurrect the page; `?tombstone=0` deletes this copy only and lets the
  // source bring the page back. Accepts a full UUID or an unambiguous id
  // prefix, mirroring `GET /documents/:id`.
  app.delete("/documents/:id", scope.writeAny(), async (c) => {
    const id = c.req.param("id");
    const tombstone = parseTombstoneFlag(c.req.query("tombstone"));
    const cols = "id, provider_id, source_id, external_id, stream_id";
    let row:
      | {
          id: string;
          provider_id: string;
          source_id: string;
          external_id: string;
          stream_id: string;
        }
      | undefined;
    if (FULL_UUID.test(id)) {
      row = db.prepare(`SELECT ${cols} FROM documents WHERE id = ?`).get(id) as typeof row;
    } else {
      const rows = db
        .prepare(`SELECT ${cols} FROM documents WHERE id LIKE ? LIMIT 2`)
        .all(`${id}%`) as Array<{
        id: string;
        provider_id: string;
        source_id: string;
        external_id: string;
        stream_id: string;
      }>;
      if (rows.length > 1) {
        throw new BadRequestError("Ambiguous ID prefix, be more specific", {
          matches: rows.map((r) => r.id),
        });
      }
      row = rows[0];
    }
    if (!row) throw new NotFoundError("Document not found");
    enforceWriteScopeForSource(c.get("auth").scopes, row.source_id);
    // Generated day documents are read-only search mirrors of the
    // `note_entries` ledger — deleting one here (with or without a
    // tombstone) would hide its notes from search without deleting them,
    // and a tombstone would suppress later captures of the same day.
    // Refuse before any write, directing the caller to manage the
    // original notes instead. The source-owned projection cleanup (empty
    // day removal after the last note delete) runs below this route, so
    // it is unaffected.
    assertExternalDocumentWrite(row.source_id);
    const result = await documentService.deleteDocumentForUser(
      row.provider_id,
      row.source_id,
      row.external_id,
      row.stream_id,
      { tombstone },
    );
    return c.json(result);
  });

  app.post(
    "/documents/reconcile",
    scope.writeAny(),
    validateJson(reconcileDocumentsBody),
    async (c) => {
      const { providerId, sourceId, writeEpoch, observationId, ...claimed } = c.req.valid("json");
      const auth = c.get("auth");
      enforceWriteScopeForSource(auth.scopes, sourceId);
      // A snapshot reconcile omitting a day tombstones it — the same
      // suppression as a direct delete. Refuse before any write.
      assertExternalDocumentWrite(sourceId);
      const cursorRow = sourceService.cursorRowFor(sourceId, auth);
      const snapshot = normalizeSnapshot(claimed);
      const result = await documentService.reconcile(
        providerId,
        sourceId,
        snapshot.presentExternalIds ?? [],
        scopeSatisfies(auth.scopes, SCOPE_WRITE_ALL)
          ? writeEpoch
          : documentService.getWipeEpoch(sourceId, cursorRow),
        true,
        cursorRow,
        sourceService.streamFor(sourceId, auth),
        observationId,
        // A member's own row on a replicated source; the shared row is nobody's.
        cursorRow !== "" && sourceService.isReplicated(sourceId) ? cursorRow : undefined,
        snapshot.claimedPartitions,
        sourceService.sourceWireAuthority([sourceId], auth),
      );
      return c.json(result);
    },
  );

  /**
   * `POST /documents/with-cursor` — atomic per-page sync write. Bundles
   * every SQLite-side write the collector needs to commit at the end
   * of a sync page (upserts + tombstones + snapshot reconcile + cursor
   * advance) into one transaction so either every effect lands or
   * none of them do. Closes the at-least-once gap.
   *
   * Supersedes the prior four-step
   * `upsertDocuments → deleteDocuments → reconcileSnapshot →
   * setSyncState` sequence in the collector's `source-sync-runner.ts`.
   * The split endpoints (`POST /documents`, `POST /documents/delete`,
   * `POST /documents/reconcile`, `POST /sync-state/:sourceId`) stay
   * available for back-compat — see the issue body for the rollout.
   */
  app.post(
    "/documents/with-cursor",
    scope.writeAny(),
    validateJson(upsertWithCursorBody),
    async (c) => {
      // Per-IP rate limit. This is the collector's PRIMARY ingest path
      // (it supersedes the split `POST /documents` flow), so it shares the same
      // generous ingest ceiling — catches a pathological write loop on an
      // exposed gateway without throttling legitimate batched bootstrap.
      // Loopback is exempt (a same-host ingest client already has full local
      // access); the check reads the raw socket so a forwarded IP can't spoof it.
      if (!isLoopbackRequest(c) && ingestLimiter.consume(clientIp(c))) {
        return c.json({ error: "Too many ingest requests — try again later" }, 429, {
          "Retry-After": "60",
        });
      }
      const body = c.req.valid("json");
      const auth = c.get("auth");
      // Authorization first — the write scope and the membership behind the
      // cursor row — so the lease is only ever taken by a device allowed to
      // write the source.
      enforceWriteScopeForSource(auth.scopes, body.sourceId);
      // A page carrying upserts, tombstones or a snapshot reconcile would
      // overwrite or suppress the read-only day mirror. Refuse before the
      // lease or cursor row is touched.
      assertExternalDocumentWrite(body.sourceId);
      const cursorDeviceId = sourceService.cursorRowFor(body.sourceId, auth);
      // A handoff source takes pages from its lease holder only; a
      // replicated member without the lease commits documents but not the
      // snapshot reconcile. The holder's page renews the lease.
      const gate = await sourceService.pageLeaseGate(body.sourceId, auth);
      if (gate.rejected) {
        log.warn(
          `upsertWithCursor for ${body.sourceId}: rejected — the sync lease is held by device ${gate.holder}`,
        );
        return c.json({
          ingested: 0,
          // Mixed-version collectors still add this legacy field to their
          // per-sync deletion counter even though snapshot deletes are deferred.
          reconciledDeleted: 0,
          indexCleanedRows: 0,
          rejected: true,
          reason: "lease",
          holder: gate.holder,
        });
      }
      const result = await documentService.upsertWithCursor({
        pageWriteAuthority: sourceService.pageWriteAuthority(body.sourceId, auth),
        assertSourceWireAuthority: body.meta?.account
          ? sourceService.sourceAccountAuthority(body.sourceId, auth)
          : sourceService.sourceWireAuthority([body.sourceId], auth),
        callerScopes: auth.scopes,
        cursorDeviceId,
        reconcileAuthority: gate.reconcile,
        deletionAuthority: gate.reconcile,
        resetReplicaCursors: gate.resetReplicaCursors,
        replicaClaimDeviceId: gate.replicated ? cursorDeviceId : undefined,
        streamId: sourceService.streamFor(body.sourceId, auth),
        replicaVersionPolicy: sourceService.replicaVersionPolicy(body.sourceId),
        body,
      });
      return c.json(result);
    },
  );

  app.post("/documents/delete-all/source/:sourceId", scope.writeAny(), async (c) => {
    const sourceId = c.req.param("sourceId");
    const auth = c.get("auth");
    // Wiping a source also clears its privacy tombstones, so only an operator
    // identity or the collector may do it — never a source-scoped push token,
    // whose reach ends at the documents it can name.
    enforceBroadWriteScope(auth.scopes);
    // Wiping the read-only day mirror hides notes from search without
    // touching the ledger. Refuse before any write.
    assertExternalDocumentWrite(sourceId);
    // A contributing device must still be a compatible host; otherwise an old
    // collector could use this legacy endpoint to bypass the multi-device
    // cursor/lease boundary.
    sourceService.cursorRowFor(sourceId, auth);
    const result = await documentService.deleteAllBySource(
      sourceId,
      sourceService.sourceWireAuthority([sourceId], auth),
    );
    return c.json(result);
  });

  app.post("/documents/delete-all/provider/:providerId", scope.writeAny(), async (c) => {
    const providerId = c.req.param("providerId");
    enforceBroadWriteScope(c.get("auth").scopes);
    const result = await documentService.deleteAllByProvider(
      providerId,
      sourceService.sourceWireAuthority(null, c.get("auth")),
    );
    return c.json(result);
  });

  app.get("/documents/count/:sourceId", scope.read(), (c) => {
    const sourceId = c.req.param("sourceId");
    const count = documentService.count(sourceId);
    return c.json({ count });
  });

  app.get("/documents/stats/:sourceId", scope.read(), (c) => {
    const sourceId = c.req.param("sourceId");
    const stats = documentService.sourceStats(sourceId);
    return c.json(stats);
  });

  // Batch variant — `omnesis status` polls per-source stats every 5s and
  // used to fan out N+1 GETs against `/documents/stats/:id`. One round-trip
  // here pays off immediately on the watch path. Cap is enforced by the
  // schema; missing IDs come back as the same zero-shape `getSourceStats`
  // returns for sources without a row yet.
  app.post("/documents/stats", scope.read(), validateJson(documentsStatsBulkBody), (c) => {
    const { sourceIds } = c.req.valid("json");
    const stats = documentService.sourceStatsBulk(sourceIds);
    return c.json({ stats });
  });

  app.get("/documents/recent/:sourceId", scope.read(), (c) => {
    const sourceId = c.req.param("sourceId");
    const limit = clampLimit(c.req.query("limit"), { default: 10, max: 100 });
    const cursor = parseRecentDocumentCursor(c.req.query("cursor"), "documents-recent", sourceId);
    const probe = documentService.recent(sourceId, limit + 1, cursor ?? undefined);
    const hasMore = probe.length > limit;
    const documents = hasMore ? probe.slice(0, limit) : probe;
    const last = documents.at(-1);
    const nextCursor =
      hasMore && last
        ? encodePageCursor("documents-recent", {
            sourceId,
            sourceCreatedAt: last.source_created_at,
            id: last.id,
          })
        : undefined;
    return c.json({
      documents: documents.map(toRecentDocumentDto),
      pageInfo: buildPage([], { hasMore, limit, nextCursor }).pageInfo,
    });
  });

  // Unified "recent items" — documents else analytics fallback
  app.get("/sources/:sourceId/recent", scope.read(), async (c) => {
    const sourceId = c.req.param("sourceId");
    const limit = clampLimit(c.req.query("limit"), { default: 10, max: 100 });
    const cursor = parseSourceRecentCursor(c.req.query("cursor"), sourceId);

    try {
      const result = await documentService.recentPage(
        sourceId,
        limit,
        cursor
          ? cursor.kind === "documents"
            ? {
                kind: "documents",
                sourceCreatedAt: cursor.sourceCreatedAt,
                id: cursor.id,
              }
            : { kind: "analytics", table: cursor.table, after: cursor.after }
          : undefined,
      );
      if (result.kind === "documents") {
        const last = result.items.at(-1);
        const nextCursor =
          result.hasMore && last
            ? encodePageCursor("source-recent", {
                kind: "documents",
                sourceId,
                sourceCreatedAt: last.source_created_at,
                id: last.id,
              })
            : undefined;
        return c.json({
          kind: "documents",
          // Lets clients drop the meaningless "this copy / for good"
          // choice: internal sources have no sync that could bring a
          // document back, so deletion is a single action.
          internal: isGatewayInternalSource(sourceId),
          documents: result.items.map(toRecentDocumentDto),
          pageInfo: buildPage([], {
            hasMore: result.hasMore,
            limit,
            nextCursor,
          }).pageInfo,
        });
      }
      if (result.kind === "analytics") {
        const nextCursor =
          result.hasMore && result.next
            ? encodePageCursor("source-recent", {
                kind: "analytics",
                sourceId,
                table: result.table,
                timeValue: result.next.timeValue,
                keyValues: result.next.keyValues,
              })
            : undefined;
        return c.json({
          kind: "analytics",
          internal: isGatewayInternalSource(sourceId),
          table: result.table,
          displayName: result.displayName,
          columns: result.columns,
          columnDefs: result.columnDefs,
          rows: result.rows,
          pageInfo: buildPage([], {
            hasMore: result.hasMore,
            limit,
            nextCursor,
          }).pageInfo,
        });
      }
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      log.error(
        `Recent analytics fallback failed for ${sourceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return c.json({
      kind: "empty",
      internal: isGatewayInternalSource(sourceId),
      pageInfo: buildPage([], { hasMore: false, limit }).pageInfo,
    });
  });

  app.get("/documents/list", scope.readBulk(), (c) => {
    const updatedSince = c.req.query("updatedSince") || undefined;
    const excludeSourcesStr = c.req.query("excludeSources");
    const excludeSourceIds = excludeSourcesStr
      ? excludeSourcesStr.split(",").filter(Boolean)
      : undefined;
    const limit = clampLimit(c.req.query("limit"), { default: 100, max: 1000 });
    // `cursor` is the canonical pagination param. The cursor
    // is the last document id from the previous page (keyset).
    const cursor = c.req.query("cursor") || undefined;

    const result = documentService.list({
      updatedSince,
      excludeSourceIds,
      limit,
      afterId: cursor,
    });

    const items = result.documents.map(toListedDocumentDto);
    const nextCursor = result.hasMore && items.length > 0 ? items[items.length - 1].id : undefined;
    return c.json(buildPage(items, { hasMore: result.hasMore, limit, nextCursor }));
  });

  app.get("/documents/ids", scope.readBulk(), (c) => {
    const ids = documentService.listIds();
    return c.json({ ids });
  });

  app.post("/documents/exists", scope.read(), validateJson(documentsExistsBody), async (c) => {
    const { providerId, sourceId, externalIds } = c.req.valid("json");
    const existingIds = documentService.checkExistingExternalIds(
      providerId,
      sourceId,
      externalIds,
      sourceService.streamFor(sourceId, c.get("auth")),
    );
    return c.json({ existingIds });
  });

  // Resolve a batch of source URLs to documentIds. URLs are normalized
  // server-side (same `normalizeUrl` used at ingest). The response is
  // `{ matches: { <normalizedUrl>: documentId[] } }` — the value is a
  // list because multiple rows can legitimately share a source_url
  // (e.g. an email message and its attached PDF documents both carry
  // the parent message URL). The eval toolkit calls this from
  // `omnesis eval doctor` and once at the start of an `omnesis eval run`.
  app.post("/documents/by-url", scope.read(), validateJson(documentsByUrlBody), async (c) => {
    const { urls } = c.req.valid("json");
    const matches = documentService.lookupDocumentIdsBySourceUrl(urls);
    return c.json({ matches: Object.fromEntries(matches) });
  });

  // Resolve a batch of documentIds to the full set of docIds in the index
  // that share each one's `content_hash`. Each input docId always appears
  // in its own sibling list (regardless of whether it's been indexed yet);
  // unindexed inputs come back as `[<self>]`. Used by the eval resolver to
  // auto-expand expected docs so the eval mirrors the search pipeline's
  // `dedupeByContentHash` — if two documents are byte-identical, hitting
  // either counts as a hit.
  //
  // Implementation: one read of `indexed_documents` to fetch input hashes,
  // then one second read constrained to those hashes for the sibling join.
  // Uses the read-only index DB connection; the gateway DB is untouched.
  app.post(
    "/documents/content-hash-siblings",
    scope.read(),
    validateJson(documentsContentHashSiblingsBody),
    async (c) => {
      const { documentIds } = c.req.valid("json");
      const unique = Array.from(new Set(documentIds));
      // Default: each input is its own sibling. Any input that turns out
      // to share a content_hash with another row will get its list
      // extended below.
      const siblings: Record<string, string[]> = {};
      for (const id of unique) siblings[id] = [id];

      if (!indexDb || unique.length === 0) {
        return c.json({ siblings });
      }

      // Step 1: fetch the content_hash of every input docId.
      const placeholders = unique.map(() => "?").join(",");
      const inputRows = indexDb
        .prepare<
          string[],
          { document_id: string; content_hash: string }
        >(`SELECT document_id, content_hash FROM indexed_documents WHERE document_id IN (${placeholders})`)
        .all(...unique);
      if (inputRows.length === 0) return c.json({ siblings });

      const hashByInputId = new Map<string, string>(
        inputRows.map((r) => [r.document_id, r.content_hash]),
      );
      const uniqueHashes = Array.from(new Set(inputRows.map((r) => r.content_hash)));

      // Step 2: fetch every docId in the index sharing any of those
      // hashes (including the inputs themselves — we filter the input
      // back in below to preserve "self in own list" without
      // double-listing).
      const hashPlaceholders = uniqueHashes.map(() => "?").join(",");
      const allRows = indexDb
        .prepare<
          string[],
          { document_id: string; content_hash: string }
        >(`SELECT document_id, content_hash FROM indexed_documents WHERE content_hash IN (${hashPlaceholders})`)
        .all(...uniqueHashes);

      const idsByHash = new Map<string, string[]>();
      for (const r of allRows) {
        const arr = idsByHash.get(r.content_hash);
        if (arr) arr.push(r.document_id);
        else idsByHash.set(r.content_hash, [r.document_id]);
      }

      for (const id of unique) {
        const h = hashByInputId.get(id);
        if (!h) continue; // Not indexed yet — keep the default `[id]`.
        const group = idsByHash.get(h) ?? [];
        // Preserve "self first", then every distinct sibling.
        const seen = new Set<string>([id]);
        const list = [id];
        for (const otherId of group) {
          if (seen.has(otherId)) continue;
          seen.add(otherId);
          list.push(otherId);
        }
        siblings[id] = list;
      }

      return c.json({ siblings });
    },
  );

  // Bulk document fetch. By default this mirrors what `GET /documents/:id`
  // returns for each requested id (full row including content + metadata).
  // `summary: true` limits rows to display identity fields for linked-document
  // UI that must not transfer corpus bodies merely to render a title and icon.
  // returned as `{ docs: { [id]: row } }`. Missing IDs are simply absent
  // from the map; we don't 404 the whole call. Capped at 100 ids per
  // call by the schema. Replaces the N+1 round-trip pattern used by the
  // portal's PersonDetail page (~21 GETs per 20-doc page).
  app.post("/documents/bulk", scope.read(), validateJson(documentsBulkBody), async (c) => {
    const { ids, summary } = c.req.valid("json");
    if (ids.length === 0) return c.json({ docs: {} });
    // Dedupe so the IN-clause shrinks if the caller is sloppy.
    const unique = Array.from(new Set(ids));
    const placeholders = unique.map(() => "?").join(",");
    const columns = summary
      ? "id, provider_id, source_id, title"
      : `id, provider_id, source_id, external_id, title, content,
                content_hash, metadata, source_created_at, source_updated_at,
                ingested_at, updated_at`;
    const rows = db
      .prepare(
        `SELECT ${columns}
           FROM documents
          WHERE id IN (${placeholders})`,
      )
      .all(...unique) as Array<Record<string, unknown>>;
    const docs: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      docs[row.id as string] = row;
    }
    return c.json({ docs });
  });
}

/**
 * /documents/:id/refs + /links/stats — registered after search but before
 * the people routes in the original (server.ts:2707-2734).
 */
export function mountDocumentRefsRoute(
  app: RouteApp,
  deps: { db: Db; documentService: DocumentService },
): void {
  const { db, documentService } = deps;

  app.get("/documents/:id/refs", scope.read(), (c) => {
    const id = c.req.param("id");
    const row = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE id LIKE ? LIMIT 2")
      .all(`${id}%`);

    if (row.length === 0) {
      throw new NotFoundError("Document not found");
    }
    if (row.length > 1) {
      throw new BadRequestError("Ambiguous ID prefix", {
        matches: row.map((r) => r.id),
      });
    }

    const refs = documentService.getRefs(row[0].id);
    return c.json(refs);
  });

  for (const direction of ["inbound", "outbound"] as const) {
    app.get(`/documents/:id/refs/${direction}`, scope.read(), (c) => {
      const id = c.req.param("id");
      const matches = documentService.resolveIdPrefix(id);
      if (matches.length === 0) throw new NotFoundError("Document not found");
      if (matches.length > 1) {
        throw new BadRequestError("Ambiguous ID prefix", { matches });
      }
      const docId = matches[0]!;
      const limit = clampLimit(c.req.query("limit"), { default: 50, max: 200 });
      const cursor = decodePageCursor(c.req.query("cursor"), "document-refs", (payload) => {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
        const value = payload as Record<string, unknown>;
        if (
          value.docId !== docId ||
          value.direction !== direction ||
          typeof value.sortId !== "number" ||
          !Number.isSafeInteger(value.sortId) ||
          value.sortId < 0
        ) {
          return null;
        }
        return value.sortId;
      });
      const page = documentService.getRefsPage(docId, direction, {
        limit,
        ...(cursor !== null ? { afterSortId: cursor } : {}),
      });
      const nextCursor =
        page.hasMore && page.lastSortId !== undefined
          ? encodePageCursor("document-refs", {
              docId,
              direction,
              sortId: page.lastSortId,
            })
          : undefined;
      return c.json(buildPage(page.items, { hasMore: page.hasMore, limit, nextCursor }));
    });
  }

  /**
   * `GET /documents/:id/dates` — the Omnesis-derived dates extracted from a
   * document's text, each resolved against the document's emission date.
   * Distinct from source-provided metadata; clients render these as an
   * "enriched by Omnesis" section. Empty until the (experimental)
   * date-enrichment pass has processed the document.
   */
  app.get("/documents/:id/dates", scope.read(), (c) => {
    const id = c.req.param("id");
    const row = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE id LIKE ? LIMIT 2")
      .all(`${id}%`);

    if (row.length === 0) {
      throw new NotFoundError("Document not found");
    }
    if (row.length > 1) {
      throw new BadRequestError("Ambiguous ID prefix", {
        matches: row.map((r) => r.id),
      });
    }

    return c.json({ dates: getExtractedDatesForDocument(db, row[0].id) });
  });

  /**
   * `GET /documents/:id/annotations` — the agent's durable
   * LLM-derived observations about a document (`doc_annotations`), live
   * priors only (invalidated rows are never served). Like `/dates`, these
   * are Omnesis-derived, not source-provided; clients render them in the
   * "enriched by Omnesis" section. Empty until the agent has
   * annotated the document.
   */
  app.get("/documents/:id/annotations", scope.read(), (c) => {
    const id = c.req.param("id");
    const matches = documentService.resolveIdPrefix(id);
    if (matches.length === 0) throw new NotFoundError("Document not found");
    if (matches.length > 1) {
      throw new BadRequestError("Ambiguous ID prefix", { matches });
    }
    const docId = matches[0]!;
    const limit = clampLimit(c.req.query("limit"), { default: 20, max: 100 });
    const showDependents = experimentalVisible();
    const includeDependents = showDependents && c.req.query("includeDependents") !== "0";
    const cursor = decodePageCursor(c.req.query("cursor"), "document-annotations", (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const value = payload as Record<string, unknown>;
      if (
        value.docId !== docId ||
        typeof value.createdAt !== "number" ||
        !Number.isFinite(value.createdAt) ||
        typeof value.id !== "string"
      ) {
        return null;
      }
      return { createdAt: value.createdAt, id: value.id };
    });
    const page = documentService.listAnnotations(docId, {
      limit,
      includeDependents,
      ...(cursor ? { before: cursor } : {}),
    });
    const last = page.items.at(-1);
    const nextCursor =
      page.hasMore && last
        ? encodePageCursor("document-annotations", {
            docId,
            createdAt: last.sortCreatedAt,
            id: last.id,
          })
        : undefined;
    return c.json({
      annotations: page.items.map(({ sortCreatedAt: _sortCreatedAt, ...annotation }) =>
        showDependents ? annotation : { ...annotation, dependentCount: 0, dependents: [] },
      ),
      pageInfo: buildPage([], { hasMore: page.hasMore, limit, nextCursor }).pageInfo,
    });
  });

  /**
   * `GET /documents/:id/edges` — every edge incident to a document annotated
   * with its provenance (source-declared / content-derived / cross-source-
   * derived / llm-derived), plus the source-declared forward references still
   * parked in `pending_edges`. Backs `omnesis edges show <doc-id>`.
   */
  app.get("/documents/:id/edges", scope.read(), (c) => {
    const id = c.req.param("id");
    const row = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE id LIKE ? LIMIT 2")
      .all(`${id}%`);

    if (row.length === 0) {
      throw new NotFoundError("Document not found");
    }
    if (row.length > 1) {
      throw new BadRequestError("Ambiguous ID prefix", {
        matches: row.map((r) => r.id),
      });
    }

    return c.json(documentService.getEdges(row[0].id));
  });

  /**
   * List near-duplicate edges for a document. The edges are produced by
   * the near-dup background pipeline (see `gateway/src/near-dupes/`) —
   * a `near-duplicate` is a different document whose content overlaps
   * sufficiently to satisfy the production gate. Same-content
   * duplicates surface via `/documents/:id/refs` (the existing
   * exact-duplicate edge); the near-duplicate edge is the
   * partial-overlap relationship.
   *
   * Pagination is cursor-based on `(jaccard DESC, other_id ASC)`. An
   * empty result + null cursor means "no near-duplicates known under
   * the active algorithm version". Until the boot-time algo bump runs
   * and the drip task produces signatures for the corpus, this
   * endpoint returns an empty list for every doc.
   */
  app.get("/documents/:id/near-dupes", scope.read(), (c) => {
    const id = c.req.param("id");
    const matches = documentService.resolveIdPrefix(id);
    if (matches.length === 0) throw new NotFoundError("Document not found");
    if (matches.length > 1) {
      throw new BadRequestError("Ambiguous ID prefix", { matches });
    }

    const limitRaw = c.req.query("limit");
    const cursorRaw = c.req.query("after");
    const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
    const result = documentService.getNearDupes(matches[0]!, {
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: cursorRaw ?? null,
    });
    return c.json(result);
  });

  /**
   * List the extracted-attachment child documents of a parent doc. Children
   * follow the externalId convention `<parent.externalId>/att/<attachmentId>`
   * set by `buildAttachmentDocument` in `@omnesis/core/attachments.ts`.
   * Used by the portal's attachments panel to deep-link the parent's
   * attachment list to each child doc view.
   */
  app.get("/documents/:id/attachments", scope.read(), (c) => {
    const id = c.req.param("id");
    const parents = db
      .prepare<
        [string],
        {
          id: string;
          provider_id: string;
          source_id: string;
          external_id: string;
          stream_id: string;
        }
      >(
        "SELECT id, provider_id, source_id, external_id, stream_id FROM documents WHERE id LIKE ? LIMIT 2",
      )
      .all(`${id}%`);

    if (parents.length === 0) {
      throw new NotFoundError("Document not found");
    }
    if (parents.length > 1) {
      throw new BadRequestError("Ambiguous ID prefix", {
        matches: parents.map((r) => r.id),
      });
    }
    const parent = parents[0];

    const rows = db
      .prepare<
        [string, string, string, string],
        {
          id: string;
          external_id: string;
          title: string;
          metadata: string;
        }
      >(
        `SELECT id, external_id, title, metadata
           FROM documents
          WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id LIKE ?
          ORDER BY external_id`,
      )
      .all(parent.provider_id, parent.source_id, parent.stream_id, `${parent.external_id}/att/%`);

    const children = rows.map((r) => {
      const meta = documentsMetadataCodec.parseWithFallback(r.metadata, { rowId: r.id }) as {
        extra?: Record<string, unknown>;
        sourceUrl?: string;
        appUrl?: string;
      };
      const extra = meta.extra ?? {};
      return {
        id: r.id,
        externalId: r.external_id,
        title: r.title,
        attachmentId: r.external_id.slice(parent.external_id.length + 5),
        mimeType: extra.mimeType ?? null,
        sizeBytes: extra.sizeBytes ?? null,
        pages: extra.pages ?? null,
        truncated: extra.truncated ?? false,
        sourceUrl: meta.sourceUrl ?? null,
        appUrl: meta.appUrl ?? null,
      };
    });

    return c.json({ attachments: children });
  });

  app.get("/links/stats", scope.read(), (c) => {
    const stats = documentService.getLinkStats();
    return c.json(stats);
  });
}

/**
 * The `/documents/:id` greedy GET. MUST be registered AFTER /documents/list,
 * /documents/ids, /documents/search, and the people routes (the original
 * places this at server.ts:3007, after every other documents/* GET).
 */
export function mountDocumentByIdRoute(app: RouteApp, deps: { db: Db }): void {
  // The /documents/:id GET deliberately stays db-direct: it fetches a
  // single row by id with two SELECT shape variants (FULL_UUID exact or
  // prefix match). Wrapping in DocumentService would add no cross-cutting
  // value — this is the read-by-pk hot path with no enrichment.
  const { db } = deps;

  app.get("/documents/:id", scope.read(), (c) => {
    const id = c.req.param("id");
    const columns = `document.id, document.provider_id, document.source_id,
                     document.external_id, document.stream_id, origin_device.name AS device_name,
                     document.title, document.content, document.content_hash, document.metadata,
                     document.source_created_at, document.source_updated_at,
                     document.ingested_at, document.updated_at`;
    const from = `FROM documents AS document
                  LEFT JOIN devices AS origin_device ON origin_device.id = document.stream_id`;

    // Flags gateway-internal sources (a dataset the gateway hosts itself) so clients
    // collapse the delete prompt to a single action: no sync exists that
    // could bring the document back.
    const withInternalFlag = (row: Record<string, unknown>) => ({
      ...row,
      internal: isGatewayInternalSource(typeof row.source_id === "string" ? row.source_id : ""),
    });
    if (FULL_UUID.test(id)) {
      const row = db.prepare(`SELECT ${columns} ${from} WHERE document.id = ?`).get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new NotFoundError("Document not found");
      return c.json(withInternalFlag(row));
    }

    const rows = db
      .prepare(`SELECT ${columns} ${from} WHERE document.id LIKE ? LIMIT 2`)
      .all(`${id}%`) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      throw new NotFoundError("Document not found");
    }
    if (rows.length > 1) {
      throw new BadRequestError("Ambiguous ID prefix, be more specific", {
        matches: rows.map((r) => r.id),
      });
    }
    return c.json(withInternalFlag(rows[0]));
  });
}

/**
 * /sync-state/:sourceId GET + POST, plus POST /begin for write-epoch claims. Registered after the
 * documents catch-all in the original (server.ts:3037-3063).
 */
export function mountSyncStateRoutes(
  app: RouteApp,
  deps: { documentService: DocumentService; sourceService: SourceService },
): void {
  const { documentService, sourceService } = deps;

  app.post("/sync-state/:sourceId/begin", scope.writeAny(), async (c) => {
    const sourceId = requireSourceId(c.req.param("sourceId"));
    enforceWriteScopeForSource(c.get("auth").scopes, sourceId);
    // The claim lands on the caller's own cursor row, so two members of a
    // replicated source hold independent write authority.
    const cursorRow = sourceService.cursorRowFor(sourceId, c.get("auth"));
    const parsed = beginSyncAttemptBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new BadRequestError("Invalid sync attempt");
    await sourceService.adoptSourceWireContract(sourceId, c.get("auth"));
    const wipeEpoch = await documentService.beginSyncAttempt(
      sourceId,
      parsed.data.attemptId,
      cursorRow,
      sourceService.sourceWireAuthority([sourceId], c.get("auth")),
    );
    return c.json({ wipeEpoch });
  });

  app.post(
    "/sync-state/:sourceId/revoke",
    scope.writeAny(),
    validateJson(revokeSyncAttemptBody),
    async (c) => {
      const sourceId = requireSourceId(c.req.param("sourceId"));
      enforceWriteScopeForSource(c.get("auth").scopes, sourceId);
      const row = sourceService.cursorRowFor(sourceId, c.get("auth"));
      const { writeEpoch, attemptId } = c.req.valid("json");
      const revoked = await documentService.revokeSyncAttempt(
        sourceId,
        writeEpoch,
        attemptId,
        row,
        sourceService.sourceWireAuthority([sourceId], c.get("auth")),
      );
      return c.json({ revoked });
    },
  );

  // The sync lease of a handoff or replicated source: one device syncs a
  // handoff source at a time and one member reconciles a replicated one.
  // A collector claims before its tick and releases when it stops.
  app.get("/sync-state/:sourceId/pending-page", scope.writeAny(), (c) => {
    const sourceId = requireSourceId(c.req.param("sourceId"));
    enforceWriteScopeForSource(c.get("auth").scopes, sourceId);
    return c.json(sourceService.pendingStructuredPage(sourceId, c.get("auth")));
  });
  app.post(
    "/sync-state/:sourceId/pending-page",
    scope.writeAny(),
    ingestBodyLimit(DOCUMENTS_BODY_LIMIT_BYTES),
    validateJson(prepareStructuredPageBody),
    async (c) => {
      const sourceId = requireSourceId(c.req.param("sourceId"));
      enforceWriteScopeForSource(c.get("auth").scopes, sourceId);
      const { id, writeEpoch, ...payload } = c.req.valid("json");
      return c.json(
        await sourceService.prepareStructuredPage(
          sourceId,
          { id, writeEpoch, payload },
          c.get("auth"),
        ),
      );
    },
  );
  app.delete(
    "/sync-state/:sourceId/pending-page",
    scope.writeAny(),
    validateJson(acknowledgeStructuredPageBody),
    async (c) => {
      const sourceId = requireSourceId(c.req.param("sourceId"));
      enforceWriteScopeForSource(c.get("auth").scopes, sourceId);
      return c.json(
        await sourceService.acknowledgeStructuredPage(sourceId, c.req.valid("json"), c.get("auth")),
      );
    },
  );

  app.post("/sync-state/:sourceId/lease", scope.writeAny(), async (c) => {
    const sourceId = requireSourceId(c.req.param("sourceId"));
    enforceWriteScopeForSource(c.get("auth").scopes, sourceId);
    await sourceService.adoptSourceWireContract(sourceId, c.get("auth"));
    return c.json(await sourceService.claimLease(sourceId, c.get("auth")));
  });

  app.delete("/sync-state/:sourceId/lease", scope.writeAny(), async (c) => {
    const sourceId = requireSourceId(c.req.param("sourceId"));
    enforceWriteScopeForSource(c.get("auth").scopes, sourceId);
    return c.json({ released: await sourceService.releaseLease(sourceId, c.get("auth")) });
  });

  app.post(
    "/sync-state/:sourceId/meta",
    scope.writeAny(),
    validateJson(sourceSyncMetaBody),
    async (c) => {
      const sourceId = requireSourceId(c.req.param("sourceId"));
      enforceWriteScopeForSource(c.get("auth").scopes, sourceId);
      sourceService.cursorRowFor(sourceId, c.get("auth"));
      await documentService.setSourceMeta(
        sourceId,
        c.req.valid("json"),
        c.req.valid("json").account
          ? sourceService.sourceAccountAuthority(sourceId, c.get("auth"))
          : sourceService.sourceWireAuthority([sourceId], c.get("auth")),
      );
      return c.json({ ok: true });
    },
  );

  app.get("/sync-state/:sourceId", scope.read(), (c) => {
    const sourceId = requireSourceId(c.req.param("sourceId"));
    const row = sourceService.cursorRowFor(sourceId, c.get("auth"));
    // Read the legacy wipeEpoch field alongside the cursor for collectors
    // that predate per-attempt claims. New collectors use POST /begin.
    const wipeEpoch = documentService.getWipeEpoch(sourceId, row);
    // A member's first read of its own row adopts the shared row: the
    // bookmark the source had before it became replicated is a valid
    // starting point for every replica. A row that exists but never
    // completed a sync — seeded by an error, by metadata, or by a resync
    // that reset the member — holds no cursor: the caller bootstraps rather
    // than resuming from the placeholder or falling back to the shared row.
    const state =
      documentService.getSyncState(sourceId, row) ??
      (row ? documentService.getSyncState(sourceId, "") : null);
    if (!state || state.last_synced_at === null) {
      return c.json({ cursor: null, lastSyncedAt: null, wipeEpoch });
    }
    return c.json({
      cursor: syncStateCursorCodec.parseWithFallback(state.cursor, { rowId: sourceId }),
      lastSyncedAt: state.last_synced_at,
      hasMeta: !!(state.icon || state.label),
      wipeEpoch,
    });
  });

  app.post("/sync-state/:sourceId", scope.writeAny(), validateJson(setSyncStateBody), async (c) => {
    const sourceId = requireSourceId(c.req.param("sourceId"));
    const auth = c.get("auth");
    enforceWriteScopeForSource(auth.scopes, sourceId);
    const row = sourceService.cursorRowFor(sourceId, auth);
    // Everything that is not the cursor or the fence is display metadata, and
    // it crosses as a whole. Listing the fields here made this hop a second
    // place to remember, and a field added to the schema and to the store
    // reached neither until someone remembered to add it a third time.
    const { cursor, writeEpoch, ...meta } = c.req.valid("json");
    const written = await documentService.setLegacySyncState(
      sourceId,
      cursor as SyncCursor,
      meta,
      // A scoped writer — a phone holding `write:<source-type>` — does not
      // take part in the attempt protocol and posts a bare cursor, so the
      // gateway supplies the row's current epoch on its behalf. Quoting an
      // absent epoch back at the fence would refuse every cursor write the
      // phone makes after anything advanced it.
      scopeSatisfies(auth.scopes, SCOPE_WRITE_ALL)
        ? writeEpoch
        : documentService.getWipeEpoch(sourceId, row),
      row,
      meta.account
        ? sourceService.sourceAccountAuthority(sourceId, auth)
        : sourceService.sourceWireAuthority([sourceId], auth),
    );
    if (written) {
      log.debug(`Updated sync state for ${sourceId}: ${summarizeCursor(cursor as SyncCursor)}`);
    }
    return c.json(written ? { ok: true } : { ok: false, rejected: true });
  });
}
