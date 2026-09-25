// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { statSync } from "node:fs";
import {
  DEFAULT_CONFIG_DIR,
  SOURCE_CONTRACT_WIRE_RANGE,
  cleanupConfigSecretMaterialization,
  createLogger,
  devModeEnabled,
  experimentalVisible,
  materializeConfigSecrets,
  type ConfigHealth,
  type ConfigSecretMaterialization,
} from "@omnesis/core";
import { applyMergePatch, describeConfigSchema, type OmnesisConfig } from "@omnesis/config";
import { resolveViewingTtlMs } from "../../agent/conversation-read-state-service.js";
import { type LatestActivity } from "../../db.js";
import {
  getIndexedDocumentCount,
  getChunkCount,
  getWatermark,
  getIndexGenerationStatus,
} from "../../indexer/db.js";
import { resolveSearchSettings } from "../../search/search-config.js";
import { scope } from "../scope.js";
import { GATEWAY_VERSION } from "../../version.js";
import { GATEWAY_COMPAT } from "../../compat.js";
import { BadRequestError, ValidationError } from "../errors.js";
import type { ReleaseCheckSnapshot } from "@omnesis/core/release-check";
import type { DiskUsageSnapshot } from "@omnesis/core/doctor";
import type { BriefsFeatureStatus } from "../../brain/index.js";
import type { DeviceService } from "../services/DeviceService.js";
import type { ConfigStore } from "../../config-store.js";
import type { StatusCache } from "../services/StatusCache.js";
import type { RouteApp } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("gateway:http").child("routes:status");

export interface StatusRoutesDeps {
  db: Db;
  dbPath?: string;
  config?: OmnesisConfig;
  configStore?: ConfigStore;
  configDir?: string;
  indexDb?: Db;
  statusCache: StatusCache;
  deviceService: DeviceService;
  /**
   * Inference config-health getter — degraded (typo'd / dangling) role
   * assignments. When omitted (e.g. a test gateway with no inference
   * registry), `/status` reports a healthy `configHealth`.
   */
  getConfigHealth?: () => ConfigHealth;
  /** Last successful install-aware release check, or null before one succeeds. */
  getReleaseCheck?: () => ReleaseCheckSnapshot | null;
  /**
   * Briefs feature-gate getter (experimental). When omitted (e.g. a test
   * gateway with no inference registry), `/status` advertises the feature
   * as visible-per-experimental-mode but with no model assigned — i.e.
   * inactive.
   */
  getBriefsStatus?: () => BriefsFeatureStatus;
  /**
   * The gateway's whole on-disk footprint, by store. When omitted, `/status`
   * reports `diskUsage: null` and clients fall back to `dbSizeBytes`.
   */
  getDiskUsage?: () => DiskUsageSnapshot | null;
}

/**
 * Health/config/status/db-size routes. Mirrors the original blocks at
 * server.ts:702-1161 and 1275-1283 (excluding the Portal block in between).
 */
export function mountStatusRoutes(app: RouteApp, deps: StatusRoutesDeps): void {
  const {
    db,
    dbPath,
    config,
    configStore,
    configDir = DEFAULT_CONFIG_DIR,
    indexDb,
    statusCache,
    deviceService,
    getConfigHealth,
    getReleaseCheck,
    getBriefsStatus,
    getDiskUsage,
  } = deps;
  // Health check + version. Public so liveness probes and clients can
  // reconcile versions without a token (the CLI's `--version` compares
  // itself against this). The `compat` subset lets a client check the wire
  // protocols and main-DB schema head without a token; the full manifest is
  // at /admin/compat. `experimental` lets a not-yet-paired external agent
  // verify that its integration is enabled before redeeming a one-time code;
  // authenticated clients continue to receive the same flag on `/status`.
  // Additive — existing consumers read only `status` + `version`.
  //
  // `capabilities` names the optional halves of a feature a client must decide
  // about before it builds anything. `subscriptions` is the one an external
  // agent harness needs: `omnesis connect` reads it to decide whether to write
  // the Watch-management tools into the generated skill, and the installed
  // plugin reads it to decide whether to register them. It is public for the
  // same reason `experimental` is — a harness asks before it holds a token.
  app.get("/health", scope.public(), (c) => {
    return c.json({
      status: "ok",
      version: GATEWAY_VERSION,
      experimental: experimentalVisible(),
      capabilities: {
        sourceContract: SOURCE_CONTRACT_WIRE_RANGE,
        // Watch management and Watch-reaction delivery sit on the Watch
        // runtime, which is still experimental. The rest of the agent
        // integration — transcript ingestion and Answer through /mcp — is
        // generally available, so this is the seam that keeps a default
        // gateway's integration honest instead of half-installed.
        subscriptions: experimentalVisible(),
      },
      compat: {
        schema: GATEWAY_COMPAT.stores.mainDb.version,
        ws: GATEWAY_COMPAT.protocols.ws,
        pairing: GATEWAY_COMPAT.protocols.pairing,
        watchPrivacyPolicy: 1,
      },
    });
  });

  // Full compatibility manifest — what product version this is, how each
  // persisted store is versioned and recovered, and which wire protocols it
  // speaks. Admin-scoped: it is an operational/diagnostic surface, the
  // machine-readable companion to the "Versioning and compatibility" docs.
  app.get("/admin/compat", scope.admin(), (c) => {
    return c.json(GATEWAY_COMPAT);
  });

  // Identity of the calling token. Read-scoped so any token can call it —
  // lets `omnesis whoami` show users + agents which scopes their token has
  // before they try a command. Returns the tokenId (UUID), the deviceId, the
  // device name (when known), and the scope list. A portal cookie session
  // carries a null deviceId on the auth context (the hot path in server.ts
  // doesn't resolve it), so fall back to the session token's device — this is
  // what lets the portal pin its "This device" card.
  app.get("/whoami", scope.read(), (c) => {
    return c.json(deviceService.resolveWhoAmI(c.get("auth")));
  });

  // Read-only config view (writes live at /admin/config).
  //
  // `config` is the operator's OVERRIDES — what `omnesis.json` actually says,
  // so an untouched knob is simply absent. `resolvedSearch` is what the search
  // pipeline runs with once those overrides are layered onto the defaults
  // (`resolveSearchSettings`, the same call `pipeline.ts` makes). A caller
  // recording the settings behind a measurement — a bench snapshot — needs the
  // resolved values: overrides alone read identically across two versions
  // whose defaults differ.
  app.get("/config", scope.read(), (c) => {
    if (!configStore) {
      return c.json({
        config: { dataRetention: config?.dataRetention ?? {} },
        version: 0,
        resolvedSearch: resolveSearchSettings(config?.search),
      });
    }
    const stored = configStore.get();
    return c.json({
      config: stored,
      version: configStore.getStatus().version,
      resolvedSearch: resolveSearchSettings(stored.search),
    });
  });

  // /admin/config read/write (admin scope) — only mounted when a configStore
  // is wired in. Mirrors the conditional block at server.ts:739-793.
  if (configStore) {
    const store = configStore;

    app.get("/admin/config", scope.admin(), (c) => {
      return c.json({
        config: store.get(),
        version: store.getStatus().version,
      });
    });

    app.get("/admin/config/raw", scope.admin(), (c) => {
      return new Response(store.getRaw(), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    });

    app.get("/admin/config/status", scope.admin(), (c) => {
      return c.json(store.getStatus());
    });

    app.get("/admin/config/events", scope.admin(), (c) => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          let closed = false;
          let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

          const send = (data: unknown): void => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            } catch {
              teardown();
            }
          };

          const heartbeat = (): void => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(": hb\n\n"));
            } catch {
              teardown();
            }
          };

          const unsubscribe = store.onChange((_before, _after, changedPaths) => {
            send({ changedPaths, version: store.getStatus().version });
          });

          const teardown = (): void => {
            if (closed) return;
            closed = true;
            unsubscribe();
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };

          heartbeat();
          heartbeatTimer = setInterval(heartbeat, 30_000);

          const signal = c.req.raw.signal;
          if (signal?.aborted) teardown();
          else signal?.addEventListener("abort", teardown, { once: true });
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    });

    // Schema descriptor that drives the portal's structured config form. The
    // form is *generated* from this tree (see `@omnesis/config` describe), so
    // every knob in `omnesisConfigSchema` surfaces automatically — minus the
    // subtrees declared as owned by another portal page. Static (schema-
    // derived), so compute once. Mounted with the rest of `/admin/config*` so
    // the family appears or 404s as a unit — the form is only useful when a
    // store backs the PUT/PATCH it drives.
    const configSchemaDescriptor = describeConfigSchema();
    app.get("/admin/config/schema", scope.admin(), (c) => {
      return c.json(configSchemaDescriptor);
    });

    app.put("/admin/config", scope.admin(), async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new BadRequestError("Invalid JSON body");
      }
      let materialized: ConfigSecretMaterialization | null = null;
      const res = await putConfigWithSecretCleanup(
        () =>
          store.update((current) => {
            materialized = materializeConfigSecrets(body, current, configDir, "put");
            return materialized.body;
          }),
        () => materialized,
        configDir,
      );
      if (!res.ok) throw new ValidationError("Validation failed", res.errors);
      return c.json({
        ok: true,
        version: res.version,
        changedPaths: res.changedPaths,
        config: res.config,
      });
    });

    app.patch("/admin/config", scope.admin(), async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new BadRequestError("Invalid JSON body");
      }
      let materialized: ConfigSecretMaterialization | null = null;
      const res = await putConfigWithSecretCleanup(
        () =>
          store.update((current) => {
            materialized = materializeConfigSecrets(body, current, configDir, "patch");
            return applyMergePatch(current, materialized.body);
          }),
        () => materialized,
        configDir,
      );
      if (!res.ok) throw new ValidationError("Validation failed", res.errors);
      return c.json({
        ok: true,
        version: res.version,
        changedPaths: res.changedPaths,
        config: res.config,
      });
    });
  }

  // Gateway status endpoint — high-frequency poll target. Most heavy reads
  // are served from the StatusCache (refreshed every 2s); a few (source_stats
  // SELECTs) run inline.
  app.get("/status", scope.read(), async (c) => {
    const tStart = Date.now();
    const tSegments: Record<string, number> = {};
    const seg = <T>(name: string, fn: () => T): T => {
      const s = Date.now();
      const r = fn();
      tSegments[name] = Date.now() - s;
      return r;
    };

    let sourceRows = seg("sourceStats", () =>
      db
        .prepare<
          [],
          { source_id: string; count: number; totalUnits: number | null }
        >("SELECT source_id, doc_count AS count, total_units AS totalUnits FROM source_stats")
        .all(),
    );
    if (sourceRows.length === 0) {
      sourceRows = seg("sourceStatsFallback", () =>
        db
          .prepare<[], { source_id: string; count: number; totalUnits: number | null }>(
            `SELECT source_id,
                  COUNT(*) as count,
                  SUM(COALESCE(
                    json_extract(metadata, '$.extra.unitCount'),
                    json_extract(metadata, '$.extra.messageCount')
                  )) as totalUnits
           FROM documents GROUP BY source_id`,
          )
          .all(),
      );
    }
    const bySource: Record<string, number> = {};
    const unitCountBySource: Record<string, number | null> = {};
    let total = 0;
    for (const row of sourceRows) {
      bySource[row.source_id] = row.count;
      unitCountBySource[row.source_id] = row.totalUnits;
      total += row.count;
    }

    const analyticsCountByType = statusCache.analyticsByType;
    tSegments["analyticsCatalog"] = 0;

    let index: Record<string, unknown> = { enabled: false };
    if (indexDb) {
      const totalIndexed = seg("idx.totalIndexed", () => getIndexedDocumentCount(indexDb));
      const totalChunks = seg("idx.totalChunks", () => getChunkCount(indexDb));
      const watermark = seg("idx.watermark", () => getWatermark(indexDb, "last_updated_at"));
      // Active + building generations (epic #1011) as first-class fields, so a
      // graceful embedder swap surfaces as an upgrade-in-flight rather than the
      // existing index regressing. Computed in the gateway; clients render the
      // neutral payload with no inference.
      const indexVersions = seg("idx.versions", () => getIndexGenerationStatus(indexDb));
      index = { enabled: true, totalIndexed, totalChunks, watermark, indexVersions };
    }

    let dbSizeBytes: number | null = null;
    if (dbPath) {
      try {
        dbSizeBytes = seg("dbSize", () => statSync(dbPath).size);
      } catch {
        /* ignore */
      }
    }

    const latestActivityBySource: Record<string, LatestActivity> = {
      ...statusCache.latestActivity,
    };
    for (const src of statusCache.listSources) {
      if (latestActivityBySource[src.id]) continue;
      const analytics =
        statusCache.latestAnalyticsActivity[src.id] ??
        statusCache.latestAnalyticsActivity[src.type];
      if (!analytics) continue;
      latestActivityBySource[src.id] = {
        kind: "analytics",
        latestActivityAt: analytics.latestActivityAt,
        tableName: analytics.tableName,
        tableDisplayName: analytics.tableDisplayName,
      };
    }
    tSegments["latestActivity"] = 0;

    const tookMs = Date.now() - tStart;
    if (tookMs > 2000) {
      const breakdown = Object.entries(tSegments)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}ms`)
        .join(" ");
      log.warn(`slow /status in ${tookMs}ms — ${breakdown}`);
    }

    // Config-health: degraded (typo'd / dangling) inference role assignments.
    // A healthy default when no registry is wired keeps the field's shape
    // stable for clients regardless of how the gateway was constructed.
    const configHealth: ConfigHealth = getConfigHealth
      ? getConfigHealth()
      : { degradedRoles: [], lastConfigError: null };

    const brainGate = getBriefsStatus
      ? getBriefsStatus()
      : {
          visible: experimentalVisible(),
          enabled: false,
          modelAssigned: false,
          active: false,
        };
    return c.json({
      documents: { total, bySource, unitCountBySource },
      analyticsCountByType,
      latestActivityBySource,
      index,
      // The main database file alone, kept for clients that predate
      // `diskUsage`, which is the whole footprint with its breakdown.
      dbSizeBytes,
      diskUsage: getDiskUsage?.() ?? null,
      uptime: Math.floor(process.uptime()),
      configHealth,
      release: getReleaseCheck?.() ?? null,
      // Gateway-wide experimental mode. Clients (portal / iOS / Android / CLI)
      // read this to decide whether to surface experimental features —
      // experimental sources, Watches, Briefs, and other gated tools. Off by default.
      experimental: experimentalVisible(),
      // Gateway-wide developer mode (OMNESIS_DEV_MODE). Separate from
      // experimental. Clients read this to reveal the "developer annotations"
      // capture affordance (portal ⚑ button, mobile shake-to-annotate). Off by
      // default, so the channel stays hidden even with experimental on.
      developer: devModeEnabled(),
      // The Omnesis Brain feature gate (experimental): whether its surfaces may
      // show, whether the operator switched it on, whether a background-agent
      // model is assigned, and whether the engine is active — so a client never
      // renders a dead screen, and only flags a missing model on an install
      // that asked for the feature. Inactive unless the composition root wires
      // the gate in.
      //
      // Emitted under BOTH names during the rename. `brain` is the field to
      // read: the subsystem is the Brain, and `briefs` there meant the whole of
      // it rather than the one artifact type that word names elsewhere. The old
      // key stays because the mobile clients ship independently, so removing it
      // would break an installed app rather than an unreleased one; it goes
      // once iOS and Android read `brain`.
      brain: brainGate,
      briefs: brainGate,
      // How long the gateway believes a client's "I am showing this
      // conversation" mark without a refresh. Clients pace their own refresh
      // off this rather than hardcoding a second number that has to stay
      // under it — a config change then propagates without a client release.
      conversationViewingTtlMs: resolveViewingTtlMs(configStore?.get() ?? config),
    });
  });
}

async function putConfigWithSecretCleanup<T extends { ok: boolean; config?: OmnesisConfig }>(
  write: () => Promise<T>,
  materialized: () => ConfigSecretMaterialization | null,
  configDir: string,
): Promise<T> {
  try {
    const res = await write();
    cleanupConfigSecretMaterialization(materialized(), res.ok, configDir, res.config);
    return res;
  } catch (err) {
    cleanupConfigSecretMaterialization(materialized(), false, configDir);
    throw err;
  }
}

/**
 * /db-size GET — registered after the portal block in the original
 * (server.ts:1275-1284). Kept separate from mountStatusRoutes so the
 * portal block can sit between them, preserving registration order.
 */
export function mountDbSizeRoute(app: RouteApp, deps: { dbPath?: string }): void {
  const { dbPath } = deps;
  app.get("/db-size", scope.read(), (c) => {
    if (!dbPath) {
      return c.json({ sizeBytes: null });
    }
    try {
      return c.json({ sizeBytes: statSync(dbPath).size });
    } catch {
      return c.json({ sizeBytes: null });
    }
  });
}
