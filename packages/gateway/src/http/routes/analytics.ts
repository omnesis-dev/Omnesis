// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { createLogger, describeSqlGrantRefusal } from "@omnesis/core";
import { scopeSatisfies, SCOPE_WRITE_ALL } from "@omnesis/types";
import { analyticsSchemaUsesDynamicColumns, type AnalyticsTableSchema } from "@omnesis/source-sdk";
import {
  getSqliteCatalog,
  getSqliteTableInfo,
  getSqliteTableActivity,
  runSqliteQuery,
} from "../../sqlite-catalog.js";
import { enforceBroadWriteScope, enforceWriteScopeForSource, scope } from "../scope.js";
import { ANALYTICS_INGEST_BODY_LIMIT_BYTES, ingestBodyLimit } from "../body-limits.js";
import { ScopedSqlDeniedError } from "../../analytics/sandbox-tables.js";
import { validateJson } from "../validate.js";
import { analyticsIngestBody, sqlBody } from "../schemas/index.js";
import { BadRequestError, NotFoundError, ServiceUnavailableError } from "../errors.js";
import type { RouteApp } from "./types.js";
import type { AnalyticsService } from "../services/AnalyticsService.js";
import type { SourceService } from "../services/SourceService.js";

type Db = Database.Database;

const log = createLogger("gateway:http").child("routes:analytics");

export interface AnalyticsRoutesDeps {
  db: Db;
  analyticsService: AnalyticsService | null;
  /** Authoritative push gate — rejects ingest for a removed/paused source. */
  sourceService: SourceService;
}

/**
 * /sql + /analytics/* + /sqlite/* + /analytics/activity/:table.
 * Mirrors the original block at server.ts:3213-3421.
 */
export function mountAnalyticsRoutes(app: RouteApp, deps: AnalyticsRoutesDeps): void {
  const { db, analyticsService, sourceService } = deps;

  // Dedicated read-only handle for the /sql endpoint. better-sqlite3
  // enforces no writes at the engine level when `readonly: true`, so
  // we no longer need a keyword block-list to filter the SQL — any
  // INSERT / UPDATE / DELETE / DROP / ALTER / CREATE / TRUNCATE
  // (including ones smuggled through CTEs, leading comments,
  // multi-statement scripts, or PRAGMA writes) fails with
  // "attempt to write a readonly database". Defence in depth: the
  // production main-thread `db` is already read-only post-#192, but
  // a separate handle here means the test harness's writable test DB
  // can't accidentally accept a write through /sql either.
  const readonlyDb: Db = db.readonly
    ? db
    : new Database(db.name, { readonly: true, fileMustExist: true });
  if (readonlyDb !== db) {
    readonlyDb.exec("PRAGMA busy_timeout = 5000");
    readonlyDb.exec("PRAGMA mmap_size = 0");
  }

  // SQLite raw query — `validateJson(sqlBody)` enforces shape (sql:
  // required string, limit: optional number) and surfaces the
  // uniform validation envelope. The read-only handle is the
  // engine-level gate that makes the keyword block-list unnecessary.
  // The actual prepare/columns/all reshape lives in
  // `sqlite-catalog.ts:runSqliteQuery` next to its peer-pattern read
  // helper `getSqliteCatalog`; this handler is a thin transport layer
  // that maps engine errors → 400.
  app.post("/sql", scope.admin(), validateJson(sqlBody), async (c) => {
    const body = c.req.valid("json");
    try {
      return c.json(runSqliteQuery(readonlyDb, body));
    } catch (err) {
      throw new BadRequestError(err instanceof Error ? err.message : String(err));
    }
  });

  app.post(
    "/analytics/ingest",
    scope.writeAny(),
    ingestBodyLimit(ANALYTICS_INGEST_BODY_LIMIT_BYTES),
    validateJson(analyticsIngestBody),
    async (c) => {
      const body = c.req.valid("json") as {
        tableName: string;
        records: Record<string, unknown>[];
        schema?: AnalyticsTableSchema;
        sourceId?: string;
        deletedIds?: string[];
        deletedKeys?: Record<string, unknown>[];
        deleteKeyColumn?: string;
        presentIds?: string[];
        presentKeys?: Record<string, unknown>[];
        writeEpoch?: number;
        observationId?: string;
        pendingPageId?: string;
        writeOrdinal?: number;
      };

      const auth = c.get("auth");
      if (body.sourceId) enforceWriteScopeForSource(auth.scopes, body.sourceId);
      else enforceBroadWriteScope(auth.scopes);
      const broadWriter = scopeSatisfies(auth.scopes, SCOPE_WRITE_ALL);
      if (body.schema && analyticsSchemaUsesDynamicColumns(body.schema) && !broadWriter) {
        throw new BadRequestError("Dynamic analytics schemas require write:* scope");
      }

      // Reject records for a removed (tombstoned) or paused push source before
      // anything else — the rejection is the actionable signal that tells the
      // client to stop, so it must fire even when analytics is unavailable.
      // Health (Apple Health, Health Connect) and the browser extension's
      // page_visits all land here, one source per call. Broad collector tokens
      // bypass pause checks but not durable removal tombstones.
      if (body.sourceId) {
        const { rejected } = sourceService.gatePush([body.sourceId], auth);
        if (rejected.length) {
          return c.json({ ingested: 0, deleted: 0, rejected });
        }
      }

      if (!analyticsService) {
        throw new ServiceUnavailableError("Analytics DB not available");
      }

      try {
        // A scoped writer's epoch is read from its own cursor row, so its write
        // is fenced by the claim it holds and not by a sibling member's.
        const cursorRow = body.sourceId ? sourceService.cursorRowFor(body.sourceId, auth) : "";
        // A handoff source accepts no part of a page from a non-holder. Records,
        // schema evolution and explicit tombstones are just as authoritative as
        // its snapshot, so reject before anything reaches DuckDB.
        const gate = body.sourceId ? await sourceService.pageLeaseGate(body.sourceId, auth) : null;
        if (gate?.rejected) {
          log.warn(
            `Analytics ingest for ${body.sourceId}: rejected — the sync lease is held by device ${gate.holder}`,
          );
          return c.json({
            ingested: 0,
            deleted: 0,
            rejected: true,
            reason: "lease",
            holder: gate.holder,
          });
        }
        // A hosting member of a replicated source keeps its deletion channels:
        // the replica deletion ledger judges its tombstones and its snapshot
        // against the other members' verdicts. Any other identity on a
        // replicated source — an operator or legacy token that hosts nothing —
        // fails closed: its rows remain useful, but neither an explicit
        // tombstone nor a snapshot of theirs may remove shared data.
        const member = !!gate?.replicated && !!auth.deviceId ? auth.deviceId : undefined;
        const replicatedWithoutDeletionAuthority =
          !!body.sourceId && sourceService.isReplicated(body.sourceId) && member === undefined;
        // Both spellings are set aside together: a member without deletion
        // authority makes no claim about what is gone, whichever shape it
        // made it in.
        const presentIds = replicatedWithoutDeletionAuthority ? undefined : body.presentIds;
        const presentKeys = replicatedWithoutDeletionAuthority ? undefined : body.presentKeys;
        const deletionDeferred =
          replicatedWithoutDeletionAuthority &&
          ((body.deletedIds?.length ?? 0) > 0 || (body.deletedKeys?.length ?? 0) > 0);
        const deletedIds = deletionDeferred ? undefined : body.deletedIds;
        const deletedKeys = deletionDeferred ? undefined : body.deletedKeys;
        const replica =
          member !== undefined
            ? { replicaClaimDeviceId: member, deletionAuthority: !!gate?.resetReplicaCursors }
            : {};
        const streamId = body.sourceId ? sourceService.streamFor(body.sourceId, auth) : "";
        const ingestBody =
          body.sourceId && !broadWriter
            ? {
                ...body,
                presentIds,
                presentKeys,
                deletedIds,
                deletedKeys,
                streamId,
                cursorRow,
                ...replica,
                // Preserve an attempt epoch supplied by a collector. Replacing a
                // stale value with the live one would let a page fetched before
                // a wipe write into the new generation. Legacy push clients
                // omit the field and inherit the current epoch as before.
                writeEpoch:
                  body.writeEpoch ?? sourceService.getWriteEpoch(body.sourceId, cursorRow),
              }
            : {
                ...body,
                presentIds,
                presentKeys,
                deletedIds,
                deletedKeys,
                streamId,
                cursorRow,
                ...replica,
              };
        const result = await analyticsService.ingest(
          ingestBody,
          () => {
            if (body.writeOrdinal !== undefined && !body.pendingPageId)
              throw new BadRequestError("A write ordinal requires its pending page identity");
            sourceService.sourceWireAuthority(body.sourceId ? [body.sourceId] : null, auth)();
            if (body.pendingPageId) {
              if (!body.sourceId || body.writeOrdinal === undefined)
                throw new BadRequestError(
                  "A pending analytics page requires its source and write ordinal",
                );
              sourceService.assertPendingStructuredPage(body.sourceId, body.pendingPageId, auth);
            }
          },
          body.sourceId ? sourceService.pageWriteAuthority(body.sourceId, auth) : undefined,
        );
        // `rejected` omitted on the success path (none); see the reject branch
        // above. Push clients treat an absent field as "no rejections".
        return c.json({ ...result, ...(deletionDeferred ? { deletionDeferred: true } : {}) });
      } catch (err) {
        log.error(
          `Analytics ingest failed for ${body.tableName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    },
  );

  app.post("/analytics/sql", scope.read(), validateJson(sqlBody), async (c) => {
    if (!analyticsService) {
      throw new ServiceUnavailableError("Analytics DB not available");
    }

    const body = c.req.valid("json");

    try {
      const result = await analyticsService.sql(body.sql, body.limit, body.sourceId);
      return c.json(result);
    } catch (err) {
      // A scope denial says what it refused, per category, so the source that
      // asked can drop those names rather than re-guess which of the ones it
      // wrote was outside its grant. The names ride along as fields too: the
      // caller here is a program, and a sentence is the weaker of the two.
      if (err instanceof ScopedSqlDeniedError) {
        const message = describeSqlGrantRefusal(err);
        log.error(`Analytics query failed: ${message}`);
        throw new BadRequestError(message, {
          tables: err.tables,
          tableFunctions: err.tableFunctions,
          shows: err.shows,
          macros: err.macros,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Analytics query failed: ${message}`);
      throw new BadRequestError(message);
    }
  });

  app.get("/analytics/catalog", scope.read(), async (c) => {
    if (!analyticsService) {
      return c.json({ tables: [] });
    }

    try {
      return c.json(await analyticsService.catalog());
    } catch (err) {
      log.error(`Analytics catalog failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  });

  app.get("/analytics/catalog/:table", scope.read(), async (c) => {
    if (!analyticsService) {
      throw new ServiceUnavailableError("Analytics DB not available");
    }

    const table = c.req.param("table");
    try {
      const info = await analyticsService.tableInfo(table);
      if (!info) {
        throw new NotFoundError("Table not found");
      }
      return c.json(info);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      log.error(`Analytics table info failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  });

  // SQLite catalog endpoints (document store discoverability)
  app.get("/sqlite/catalog", scope.read(), (c) => {
    try {
      return c.json({ tables: getSqliteCatalog(db) });
    } catch (err) {
      log.error(`SQLite catalog failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  });

  app.get("/sqlite/catalog/:table", scope.read(), (c) => {
    const table = c.req.param("table");
    try {
      const info = getSqliteTableInfo(db, table);
      if (!info) throw new NotFoundError("Table not found");
      return c.json(info);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      log.error(`SQLite table info failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  });

  app.get("/sqlite/activity/:table", scope.readBulk(), (c) => {
    const table = c.req.param("table");
    const days = Math.max(1, Math.min(Number(c.req.query("days") ?? 14), 90));
    try {
      return c.json({ days, points: getSqliteTableActivity(db, table, days) });
    } catch (err) {
      log.error(`SQLite activity failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  });

  // Analytics activity (row-creation sparkline).
  app.get("/analytics/activity/:table", scope.readBulk(), async (c) => {
    if (!analyticsService) {
      return c.json({ days: 0, points: [] });
    }
    const table = c.req.param("table");
    const days = Math.max(1, Math.min(Number(c.req.query("days") ?? 14), 90));
    try {
      const points = await analyticsService.tableActivity(table, days);
      return c.json({ days, points });
    } catch (err) {
      log.error(`Analytics activity failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  });
}
