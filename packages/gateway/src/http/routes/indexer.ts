// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { computeIndexStats } from "../../indexer/stats.js";
import { scope } from "../scope.js";
import { ServiceUnavailableError, BadRequestError } from "../errors.js";
import type { EmbedSwapMode, IndexerModelInfo } from "../../indexer/indexer-lifecycle.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { ConfigStore } from "../../config-store.js";
import type { RouteApp } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("gateway:http").child("routes:indexer");

export interface IndexerRoutesDeps {
  db: Db;
  indexDb?: Db;
  configStore?: ConfigStore;
  config?: OmnesisConfig;
  indexerModel?: IndexerModelInfo;
  indexerControl?: {
    reindexMissing: () => Promise<{ indexed: number; errors: number }>;
    rebuild?: (mode?: EmbedSwapMode) => Promise<void>;
    wake?: () => void;
    /** Latest docs/sec indexing throughput, or null when unknown. */
    getIndexRate?: () => number | null;
  };
  /** Provides the indexer worker's readiness state for the portal's
   *  boot-phase UX. When the worker is still spawning or loading the
   *  model, `/index/stats` surfaces `state: "spawning"` so the portal
   *  can show a "starting" pill instead of a misleading 0%. */
  indexerReadiness?: () => { status: string; message?: string; reason?: string };
}

/**
 * /index/stats GET + /admin/index/reindex-missing POST + /admin/index/rebuild
 * POST. Mirrors server.ts:3066-3209.
 */
export function mountIndexerRoutes(app: RouteApp, deps: IndexerRoutesDeps): void {
  const { db, indexDb, configStore, config, indexerModel, indexerControl, indexerReadiness } = deps;

  app.get("/index/stats", scope.read(), (c) => {
    return c.json(
      computeIndexStats({
        db,
        indexDb,
        configStore,
        config,
        indexerModel,
        indexerReadiness,
        getIndexRate: indexerControl?.getIndexRate,
      }),
    );
  });

  app.post("/admin/index/reindex-missing", scope.admin(), async (c) => {
    if (!indexerControl) {
      throw new ServiceUnavailableError("indexer control not available");
    }
    try {
      const r = await indexerControl.reindexMissing();
      return c.json({ ok: true, indexed: r.indexed, errors: r.errors });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Manual reindex-missing failed: ${message}`);
      throw err;
    }
  });

  app.post("/admin/index/rebuild", scope.admin(), async (c) => {
    if (!indexerControl?.rebuild) {
      throw new ServiceUnavailableError("indexer control not available");
    }
    // Optional swap mode. `graceful` (default) keeps vector search live
    // on the current model while the new index rebuilds in the background, then
    // atomically flips; `hard` is the deliberate immediate cutover — stop using
    // the old model now and accept BM25-only search until the rebuild finishes.
    // An unknown value is rejected rather than silently treated as graceful.
    const body = await c.req.json<{ mode?: string }>().catch(() => ({}) as { mode?: string });
    const mode = body.mode ?? "graceful";
    if (mode !== "graceful" && mode !== "hard") {
      throw new BadRequestError(`invalid mode "${mode}" — expected "graceful" or "hard"`);
    }
    try {
      await indexerControl.rebuild(mode);
      return c.json({ ok: true, mode });
    } catch (err) {
      // A rebuild arriving while one is already in flight is not rejected —
      // it abandons the in-flight build and starts a fresh one for the newest
      // model (newest-wins/bounded-to-two). Any genuine failure
      // falls through to the sanitized 500 in app.onError.
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Manual index rebuild failed: ${message}`);
      throw err;
    }
  });
}
