// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  buildPage,
  SourceId,
  tryAccountId,
  tryDeviceId,
  trySourceType,
  type DeviceId,
  type DeviceRecord,
} from "@omnesis/types";
import { enforceWriteScopeForSourceType, scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { PairingService } from "../../services/PairingService.js";
import {
  BadGatewayError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../errors.js";
import {
  bulkUpsertSourcesBody,
  bulkUpsertLegacySourcesBody,
  createSourceBody,
  importHistoryBody,
  patchSourceBody,
  setCredentialsBody,
  sourceAddBody,
  sourceDiscoverBody,
  sourceResolveAccountBody,
  sourceReauthFinalizeBody,
  sourceValidateParamBody,
  sourceMemberBody,
  sourceMemberConfigBody,
  sourceResyncBody,
} from "../../schemas/index.js";
import { normalizeIcon } from "../../../icon-normalizer.js";
import { gatewayHostedDescriptors } from "../../../internal-source-descriptors.js";
import { assertMutableSource, listInternalSources } from "../../../internal-sources.js";
import { log, wsProxy, type AdminRoutesDeps } from "./internals.js";
import type { Context } from "hono";
import type { AppEnv, RouteApp } from "../types.js";

/**
 * Block 1.11 + 1.12 — source CRUD, descriptor proxies, sync/status.
 *
 *   GET    /admin/sources/descriptors
 *   GET    /admin/source-descriptors
 *   GET    /admin/credentials
 *   POST   /admin/credentials/:fileKey
 *   DELETE /admin/credentials/:fileKey
 *   GET    /admin/sources/snapshot
 *   POST   /admin/sources/discover
 *   POST   /admin/sources/resolve-account
 *   POST   /admin/sources/validate-param
 *   POST   /admin/sources/add
 *   POST   /admin/sources/reauth-finalize
 *   GET    /admin/sources
 *   GET    /admin/sources/:id
 *   POST   /admin/sources
 *   POST   /devices/sources/bulk-upsert
 *   PATCH  /admin/sources/:id
 *   DELETE /admin/sources/:id
 *   POST   /admin/sources/:id/sync
 *   POST   /admin/sources/:id/resync
 *   GET    /admin/sources/:id/debug
 *   GET    /admin/sync/status
 *   GET    /admin/sync/status/:id
 */
export function mountSourceRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  const {
    sourceService,
    deviceService,
    wsServer,
    resolveCollectorDeviceId,
    resolveCollectorDeviceIdForType,
    resolveCollectorDeviceIdForReauth,
    deviceForSource,
    importFlows,
  } = deps;
  const pairingGenerationFence = (c: Context<AppEnv>) =>
    deps.pairingService.pairingGenerationFence(
      c.req.header("omnesis-pairing-generation"),
      c.get("auth"),
    );
  const runGenerationFenced = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      return PairingService.translateStaleGeneration(error);
    }
  };

  // ── Block 1.11: sources core ──

  app.get("/admin/sources/descriptors", scope.admin(), async (c) => {
    return wsProxy(
      c,
      c.req.query("deviceId"),
      resolveCollectorDeviceId,
      wsServer,
      async (deviceId) => {
        const result = await wsServer!.sendCommand(deviceId, "source.descriptors", {}, 15_000);
        // Descriptors are a small (~30) capped list — wrap as Page<T> for
        // shape consistency while keeping `collectorHostname` as a sibling
        // (it's response metadata, not pagination metadata). `deviceId` is
        // injected by wsProxy and lives at the top level the same way.
        //
        // Inline + rasterise hosted icon URLs so the portal's strict CSP
        // (`img-src 'self' data: blob:`) doesn't block them. SVG urls go
        // through the icon-rasterise worker → PNG data URI; raster urls
        // are wrapped as data URIs. `normalizeIcon` is memoised, so this
        // is one fetch per source per deploy. Failed fetches return null
        // and we drop the icon entirely — the portal then renders the
        // Lucide-derived `sourceIcon(d.id)` fallback.
        const items = await Promise.all(
          (result.descriptors as Array<Record<string, unknown>>).map(async (d) => {
            const icon = (d.icon ?? {}) as Record<string, unknown>;
            const url = typeof icon.url === "string" ? icon.url : undefined;
            const embedded = typeof icon.imageDataUri === "string" ? icon.imageDataUri : undefined;
            if (!url && !embedded) return d;
            const { url: _dropUrl, imageDataUri: _dropEmbedded, ...rest } = icon;
            const dataUri = await normalizeIcon(url ?? embedded);
            return dataUri
              ? { ...d, icon: { ...rest, imageDataUri: dataUri } }
              : { ...d, icon: rest };
          }),
        );
        return {
          ...buildPage(items, { hasMore: false, limit: items.length }),
          collectorHostname: result.hostname,
        };
      },
    );
  });

  /**
   * Union of source descriptors across all online collectors. Each
   * descriptor entry carries the list of devices that advertise it as
   * `devices: [{id, name}]`. Powers the multi-collector "Add Source"
   * UX in CLI + portal — pick the source first, pick the device second
   * (only when ambiguous).
   *
   * Descriptors with identical `id` from different collectors are merged
   * — first descriptor wins for the visible payload (display name, icon,
   * params), and every device hosting that id is appended to `devices`.
   * Diverging descriptor shapes across collectors is rare in practice
   * (same package version installed on each), so first-wins is fine.
   * A future enhancement could surface per-device descriptor differences
   * explicitly if needed.
   */
  app.get("/admin/source-descriptors", scope.admin(), async (c) => {
    type Aggregate = {
      descriptor: Record<string, unknown>;
      devices: Array<{ id: string; name: string }>;
    };
    const byDescriptorId = new Map<string, Aggregate>();

    // Gateway-hosted sources (e.g. the unified Web Pages dataset) are owned and
    // advertised by the gateway itself — seed them first so they're present even
    // with no collector connected. Collectors exclude `gatewayHosted`
    // descriptors from what they advertise, so the merge below never collides.
    for (const descriptor of gatewayHostedDescriptors()) {
      byDescriptorId.set(descriptor.id, {
        descriptor: descriptor as unknown as Record<string, unknown>,
        devices: [],
      });
    }

    const ws = wsServer;
    const onlineCollectors = ws
      ? deviceService
          .listDevices()
          .filter((d): d is DeviceRecord => d.kind === "collector" && ws.isConnected(d.id))
      : [];
    // 3s per-collector timeout — descriptors are an in-memory map on the
    // collector and should respond in <100ms. A higher cap would let one
    // hung collector stall the entire Add Source modal opening; one
    // failure is logged and the union proceeds without it.
    await Promise.all(
      onlineCollectors.map(async (dev) => {
        try {
          // `ws` is defined whenever `onlineCollectors` is non-empty.
          const result = await ws!.sendCommand(dev.id, "source.descriptors", {}, 3_000);
          for (const raw of result.descriptors as Array<Record<string, unknown>>) {
            const id = typeof raw.id === "string" ? raw.id : null;
            if (!id) continue;
            const entry = byDescriptorId.get(id);
            if (entry) {
              entry.devices.push({ id: dev.id, name: dev.name });
            } else {
              byDescriptorId.set(id, {
                descriptor: raw,
                devices: [{ id: dev.id, name: dev.name }],
              });
            }
          }
        } catch (err) {
          log.warn(
            `/admin/source-descriptors: skipping device ${dev.name} (${dev.id}) — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
    // Apply icon normalisation once per merged descriptor (memoised by
    // url inside normalizeIcon, so re-rasterising across collectors that
    // advertise the same icon is free).
    const items = await Promise.all(
      Array.from(byDescriptorId.values()).map(async ({ descriptor, devices }) => {
        const icon = (descriptor.icon ?? {}) as Record<string, unknown>;
        const url = typeof icon.url === "string" ? icon.url : undefined;
        const embedded = typeof icon.imageDataUri === "string" ? icon.imageDataUri : undefined;
        if (!url && !embedded) return { ...descriptor, devices };
        const { url: _dropUrl, imageDataUri: _dropEmbedded, ...rest } = icon;
        const dataUri = await normalizeIcon(url ?? embedded);
        const iconOut = dataUri ? { ...rest, imageDataUri: dataUri } : rest;
        return { ...descriptor, icon: iconOut, devices };
      }),
    );
    return c.json(buildPage(items, { hasMore: false, limit: items.length }));
  });

  app.get("/admin/credentials", scope.admin(), async (c) => {
    return wsProxy(
      c,
      c.req.query("deviceId"),
      resolveCollectorDeviceId,
      wsServer,
      async (deviceId) => {
        const result = await wsServer!.sendCommand(deviceId, "credentials.status", {}, 10_000);
        // Credentials list is one row per provider — small and capped.
        // Wrap entries as Page<T>; keep `hostname` as sibling metadata.
        return {
          ...buildPage(result.entries, { hasMore: false, limit: result.entries.length }),
          hostname: result.hostname,
        };
      },
    );
  });

  app.post(
    "/admin/credentials/:fileKey",
    scope.admin(),
    validateJson(setCredentialsBody),
    async (c) => {
      const fileKey = c.req.param("fileKey");
      const { deviceId: requested, fields } = c.req.valid("json");
      return wsProxy(c, requested, resolveCollectorDeviceId, wsServer, (deviceId) =>
        wsServer!.sendCommand(deviceId, "credentials.set", { fileKey, fields }, 10_000),
      );
    },
  );

  app.delete("/admin/credentials/:fileKey", scope.admin(), async (c) => {
    const fileKey = c.req.param("fileKey");
    return wsProxy(c, c.req.query("deviceId"), resolveCollectorDeviceId, wsServer, (deviceId) =>
      wsServer!.sendCommand(deviceId, "credentials.clear", { fileKey }, 10_000),
    );
  });

  app.get("/admin/sources/snapshot", scope.admin(), async (c) => {
    return wsProxy(c, c.req.query("deviceId"), resolveCollectorDeviceId, wsServer, (deviceId) =>
      wsServer!.sendCommand(deviceId, "sources.snapshot.request", {}, 15_000),
    );
  });

  // Per http-conventions.md "Param placement and naming": POST is
  // action-bearing → params (including descriptorId) live in the body,
  // path is the bare verb at the collection level.
  app.post(
    "/admin/sources/discover",
    scope.admin(),
    validateJson(sourceDiscoverBody),
    async (c) => {
      const { descriptorId, deviceId: requested } = c.req.valid("json");
      return wsProxy(c, requested, resolveCollectorDeviceId, wsServer, async (deviceId) => {
        const result = await wsServer!.sendCommand(
          deviceId,
          "source.discover",
          { descriptorId },
          30_000,
        );
        return { accounts: result.accounts };
      });
    },
  );

  app.post(
    "/admin/sources/validate-param",
    scope.admin(),
    validateJson(sourceValidateParamBody),
    async (c) => {
      const body = c.req.valid("json");
      const deviceId = await resolveCollectorDeviceId(body.deviceId);
      if (typeof deviceId !== "string") return deviceId;
      if (!wsServer) throw new ServiceUnavailableError("no WS server");
      try {
        const result = await wsServer.sendCommand(
          deviceId,
          "source.validate-param",
          { descriptorId: body.descriptorId, paramName: body.paramName, value: body.value },
          10_000,
        );
        return c.json(result);
      } catch (err) {
        throw new BadGatewayError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  app.post(
    "/admin/sources/resolve-account",
    scope.admin(),
    validateJson(sourceResolveAccountBody),
    async (c) => {
      const body = c.req.valid("json");
      return wsProxy(
        c,
        body.deviceId,
        (requested) => resolveCollectorDeviceIdForType(requested, body.descriptorId),
        wsServer,
        (deviceId) =>
          wsServer!.sendCommand(
            deviceId,
            "source.resolve-account",
            { descriptorId: body.descriptorId, params: body.params },
            10_000,
          ),
      );
    },
  );

  app.post("/admin/sources/add", scope.admin(), validateJson(sourceAddBody), async (c) => {
    const body = c.req.valid("json");
    // descriptorId is the source type — used to filter candidate collectors
    // by capability so the user isn't asked to pick between devices that
    // can't host the source.
    return wsProxy(
      c,
      body.deviceId,
      (requested) => resolveCollectorDeviceIdForType(requested, body.descriptorId),
      wsServer,
      (deviceId) =>
        wsServer!.sendCommand(
          deviceId,
          "source.add",
          {
            descriptorId: body.descriptorId,
            accountIds: body.accountIds,
            params: body.params,
          },
          60_000,
        ),
    );
  });

  // Sub-resource action verbs are kebab-case (http-conventions.md), so
  // the verb segment joins as `reauth-finalize`.
  app.post(
    "/admin/sources/reauth-finalize",
    scope.admin(),
    validateJson(sourceReauthFinalizeBody),
    async (c) => {
      const body = c.req.valid("json");
      // Dispatch to the device that already hosts source(s) for this
      // accountId — gateway looks up the device_id from existing rows.
      return wsProxy(
        c,
        body.deviceId,
        (requested) =>
          resolveCollectorDeviceIdForReauth(requested, body.accountId, body.sourceType),
        wsServer,
        (deviceId) =>
          wsServer!.sendCommand(
            deviceId,
            "source.reauth-finalize",
            { providerType: body.providerType, accountId: body.accountId },
            30_000,
          ),
      );
    },
  );

  app.get("/admin/sources", scope.admin(), (c) => {
    const raw = c.req.query("deviceId");
    const deviceId = raw === undefined ? undefined : tryDeviceId(raw);
    if (raw !== undefined && !deviceId) return c.json({ sources: [] });
    const enriched = sourceService.listSourcesForAdmin({ deviceId: deviceId ?? undefined });
    // Sources being removed have no row left to enrich, so they ride alongside
    // the page rather than in it — a client that ignores the field sees exactly
    // what it saw before, and one that reads it can keep the source on screen
    // until its data has finished draining.
    return c.json({
      ...buildPage(enriched, { hasMore: false, limit: enriched.length }),
      pendingRemovals: sourceService.listPendingRemovals(),
      removedSourceIds: sourceService.listRemovedSourceIds(),
      // Gateway-internal sources (a dataset the gateway hosts itself) have no
      // `sources`-table row, so they ride alongside the page like pending
      // removals do — a client that ignores the field sees exactly what it
      // saw before, and one that reads it renders a read-only row with
      // counters and recent documents.
      internalSources: listInternalSources(),
    });
  });

  app.get("/admin/sources/:id", scope.admin(), (c) => {
    const id = SourceId(c.req.param("id"));
    assertMutableSource(id);
    const source = sourceService.getById(id);
    if (!source) throw new NotFoundError("source not found");
    return c.json({ source });
  });

  app.post("/admin/sources", scope.admin(), validateJson(createSourceBody), async (c) => {
    const pairingFence = pairingGenerationFence(c);
    const body = c.req.valid("json");
    const did = tryDeviceId(body.deviceId);
    if (!did) throw new NotFoundError("device not found");
    if (!deviceService.getById(did)) throw new NotFoundError("device not found");
    const type = trySourceType(body.type);
    if (!type) throw new BadRequestError(`invalid source type: ${body.type}`);
    const accountId = tryAccountId(body.accountId);
    if (!accountId) throw new BadRequestError("invalid account id");

    // Service failures are typed HttpErrors (409 SOURCE_ALREADY_HOSTED,
    // 400 DEVICE_CANNOT_HOST_TYPE, …) and writer backpressure has its own
    // 503 mapping — the error middleware renders them all.
    const source = await runGenerationFenced(() =>
      sourceService.createSource({
        type,
        accountId,
        deviceId: did,
        config: body.config,
        enabled: body.enabled,
        pairingFence,
      }),
    );
    return c.json({ source });
  });

  app.post(
    "/devices/sources/bulk-upsert",
    scope.writeAny(),
    validateJson(bulkUpsertLegacySourcesBody),
    async (c) => {
      const pairingFence = pairingGenerationFence(c);
      const { sources } = c.req.valid("json");
      const auth = c.get("auth");
      if (!auth.deviceId) throw new ForbiddenError("device-token required (no session)");
      const deviceId = auth.deviceId;
      for (const source of sources) {
        enforceWriteScopeForSourceType(auth.scopes, source.type);
      }

      const result = await runGenerationFenced(() =>
        sourceService.bulkUpsertForDevice(deviceId, sources, pairingFence),
      );
      return c.json(result);
    },
  );

  // Member-local config uses a distinct endpoint so an older gateway fails
  // before mutation with 404 instead of silently dropping the overlay.
  app.post(
    "/devices/sources/bulk-upsert-member-config",
    scope.writeAny(),
    validateJson(bulkUpsertSourcesBody),
    async (c) => {
      const pairingFence = pairingGenerationFence(c);
      const { sources } = c.req.valid("json");
      const auth = c.get("auth");
      if (!auth.deviceId) throw new ForbiddenError("device-token required (no session)");
      const deviceId = auth.deviceId;
      for (const source of sources) {
        enforceWriteScopeForSourceType(auth.scopes, source.type);
      }
      const result = await runGenerationFenced(() =>
        sourceService.bulkUpsertForDevice(deviceId, sources, pairingFence),
      );
      return c.json(result);
    },
  );

  app.patch("/admin/sources/:id", scope.admin(), validateJson(patchSourceBody), async (c) => {
    const pairingFence = pairingGenerationFence(c);
    const id = SourceId(c.req.param("id"));
    assertMutableSource(id);
    const body = c.req.valid("json");
    let did: DeviceId | undefined;
    if (body.deviceId !== undefined) {
      const parsed = tryDeviceId(body.deviceId);
      if (!parsed) return c.json({ error: "device not found" }, 404);
      did = parsed;
    }
    const updated = await runGenerationFenced(() =>
      sourceService.updateSource(id, {
        config: body.config,
        enabled: body.enabled,
        deviceId: did,
        multiDeviceMode: body.multiDeviceMode,
        pairingFence,
      }),
    );
    if (!updated) throw new NotFoundError("source not found");
    return c.json({ source: updated });
  });

  app.post(
    "/admin/sources/:id/members",
    scope.admin(),
    validateJson(sourceMemberBody),
    async (c) => {
      const pairingFence = pairingGenerationFence(c);
      const id = SourceId(c.req.param("id"));
      assertMutableSource(id);
      const body = c.req.valid("json");
      const did = tryDeviceId(body.deviceId);
      if (!did) throw new BadRequestError("invalid device id");
      const source = await runGenerationFenced(() =>
        sourceService.joinSourceFromAdmin(id, did, body.memberConfig, pairingFence),
      );
      return c.json({ source, members: sourceService.membersOf(source) });
    },
  );

  app.patch(
    "/admin/sources/:id/members/:deviceId",
    scope.admin(),
    validateJson(sourceMemberConfigBody),
    async (c) => {
      const pairingFence = pairingGenerationFence(c);
      const id = SourceId(c.req.param("id"));
      assertMutableSource(id);
      const did = tryDeviceId(c.req.param("deviceId"));
      if (!did) throw new BadRequestError("invalid device id");
      const source = await runGenerationFenced(() =>
        sourceService.updateMemberConfig(id, did, c.req.valid("json").configOverride, pairingFence),
      );
      return c.json({ source });
    },
  );

  app.delete("/admin/sources/:id/members/:deviceId", scope.admin(), async (c) => {
    const pairingFence = pairingGenerationFence(c);
    const id = SourceId(c.req.param("id"));
    assertMutableSource(id);
    const did = tryDeviceId(c.req.param("deviceId"));
    if (!did) throw new BadRequestError("invalid device id");
    const result = await runGenerationFenced(() =>
      sourceService.detachSource(id, did, pairingFence),
    );
    if (!result) throw new NotFoundError("source not found");
    return c.json(result);
  });

  app.delete("/admin/sources/:id", scope.admin(), async (c) => {
    const pairingFence = pairingGenerationFence(c);
    const id = SourceId(c.req.param("id"));
    assertMutableSource(id);
    const result = await runGenerationFenced(() => sourceService.deleteSource(id, pairingFence));
    if (!result) throw new NotFoundError("source not found");
    // The source is gone — stopped syncing, stopped accepting pushes — but
    // purging what it ingested continues after this returns. `removing` is the
    // caller's cue that the id will keep appearing in `pendingRemovals` until
    // that finishes.
    return c.json({ ok: true, state: "removing" });
  });

  app.post("/admin/sources/:id/sync", scope.admin(), async (c) => {
    const id = SourceId(c.req.param("id"));
    assertMutableSource(id);
    if (!wsServer) throw new ServiceUnavailableError("no WS server");
    // A source every member syncs on its own cursor is triggered on every
    // member; a shared-cursor source on the device that syncs it.
    const targets = sourceService.syncTargets(id);
    if (targets.length > 1) {
      const online = targets.filter((d) => wsServer.isConnected(d));
      log.info(`Sync triggered: ${id} → ${online.length}/${targets.length} member device(s)`);
      const results = await Promise.all(
        online.map(async (deviceId) => {
          try {
            const result = await wsServer.sendCommand(deviceId, "source.sync", { sourceId: id });
            return { deviceId, ...result };
          } catch (err) {
            return { deviceId, ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      if (!results.some((r) => r.ok)) {
        throw new BadGatewayError(
          results
            .map((r) => r.error)
            .filter(Boolean)
            .join("; ") || "no member is online",
        );
      }
      return c.json({ ok: true, results });
    }
    const deviceId = targets[0] ?? deviceForSource(id);
    if (!deviceId) throw new NotFoundError("source not found");
    log.info(`Sync triggered: ${id} → device ${deviceId}`);
    try {
      const result = await wsServer.sendCommand(deviceId, "source.sync", { sourceId: id });
      if (!result.ok) {
        throw new Error(result.error ?? "collector rejected source sync");
      }
      return c.json({ ok: true, result, deviceId });
    } catch (err) {
      log.warn(
        `Sync dispatch failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadGatewayError(err instanceof Error ? err.message : String(err));
    }
  });

  app.post(
    "/admin/sources/:id/resync",
    scope.admin(),
    validateJson(sourceResyncBody),
    async (c) => {
      const id = SourceId(c.req.param("id"));
      assertMutableSource(id);
      const { deviceId } = c.req.valid("json");
      const result = await sourceService.resync(id, deviceId);
      return c.json({ ok: true, ...result });
    },
  );

  app.get("/admin/sources/:id/debug", scope.admin(), async (c) => {
    const id = SourceId(c.req.param("id"));
    assertMutableSource(id);
    if (!wsServer) throw new ServiceUnavailableError("no WS server");
    const deviceId = deviceForSource(id);
    if (!deviceId) throw new NotFoundError("source not found");
    try {
      const result = await wsServer.sendCommand(deviceId, "source.debug", { sourceId: id });
      return c.json(result);
    } catch (err) {
      throw new BadGatewayError(err instanceof Error ? err.message : String(err));
    }
  });

  // ── History import (#588) — one-time bulk import from a local artifact ──
  // Runs source.importHistory() in the collector; progress streams back as
  // import.progress/import.complete events, surfaced via SSE below.
  app.post(
    "/admin/sources/:id/import-history",
    scope.admin(),
    validateJson(importHistoryBody),
    async (c) => {
      const id = SourceId(c.req.param("id"));
      assertMutableSource(id);
      if (!wsServer) throw new ServiceUnavailableError("no WS server");
      if (!importFlows) throw new ServiceUnavailableError("import orchestration unavailable");
      const deviceId = deviceForSource(id);
      if (!deviceId) throw new NotFoundError("source not found");
      const { values } = c.req.valid("json");
      const flow = importFlows.start({ sourceId: id, deviceId });
      log.info(`Import started: ${id} → device ${deviceId} (flow ${flow.id})`);
      try {
        await wsServer.sendCommand(
          deviceId,
          "import.begin",
          { flowId: flow.id, sourceId: id, values },
          30_000,
        );
        return c.json({ flowId: flow.id, deviceId });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        importFlows.ingestEvent(flow.id, { type: "complete", ok: false, error: detail });
        throw new BadGatewayError(detail);
      }
    },
  );

  // :id is unused here (flowId-scoped) — deliberately no assertMutableSource.
  app.get("/admin/sources/:id/import-history/events", scope.admin(), (c) => {
    if (!importFlows) return c.text("import orchestration unavailable", 500);
    const flowId = c.req.query("flowId");
    if (!flowId) return c.text("flowId query param required", 400);
    const flow = importFlows.get(flowId);
    if (!flow) return c.text("flow not found", 404);

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const writeEvent = (eventName: string, data: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch (err) {
            log.debug(`SSE import ${flowId} write failed: ${String(err)}`);
          }
        };

        writeEvent("snapshot", flow);
        if (flow.state === "completed") {
          writeEvent("import", {
            type: "complete",
            ok: true,
            imported: flow.imported,
            merged: flow.merged,
            skipped: flow.skipped,
          });
        } else if (flow.state === "error") {
          writeEvent("import", { type: "complete", ok: false, error: flow.errorMessage });
        }

        const unsubscribe = importFlows.subscribe(flowId, (event) => {
          writeEvent("import", event);
          if (event.type === "complete") {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        });

        c.req.raw.signal?.addEventListener("abort", () => {
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  // :id is unused here (flowId-scoped) — deliberately no assertMutableSource.
  app.post("/admin/sources/:id/import-history/cancel", scope.admin(), async (c) => {
    if (!importFlows || !wsServer) {
      throw new ServiceUnavailableError("import orchestration unavailable");
    }
    const flowId = c.req.query("flowId");
    if (!flowId) throw new BadRequestError("flowId query param required");
    const flow = importFlows.get(flowId);
    if (!flow) throw new NotFoundError("flow not found");
    try {
      await wsServer.sendCommand(flow.deviceId, "import.cancel", { flowId }, 5_000);
    } catch {
      /* collector may already be gone */
    }
    // Mark the record without fanning out — the collector's import.complete is
    // the single terminal event, so a cancel never double-completes (L5).
    importFlows.update(flowId, { state: "error", errorMessage: "cancelled" });
    return c.json({ ok: true });
  });

  // ── Block 1.12: sync/status ──

  app.get("/admin/sync/status", scope.admin(), (c) => {
    const statuses = sourceService.listSyncStatuses();
    return c.json(buildPage(statuses, { hasMore: false, limit: statuses.length }));
  });

  app.get("/admin/sync/status/:id", scope.admin(), (c) => {
    const id = SourceId(c.req.param("id"));
    assertMutableSource(id);
    const status = sourceService.syncStatusFor(id);
    if (!status) throw new NotFoundError("not found");
    return c.json(status);
  });
}
