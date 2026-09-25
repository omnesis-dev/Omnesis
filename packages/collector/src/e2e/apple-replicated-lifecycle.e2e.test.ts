// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Collector-lifecycle acceptance for a replicated hybrid Apple source.
 * Unlike the roster harness, these collectors hold real WebSocket sessions
 * and apply gateway source commands through SourceManager, so join, reconnect
 * restoration and detach exercise the production collector control plane.
 */
import "./synth-env.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  parseRequestPayload,
  type WsCommand,
  type WsCommandType,
  type WsRequestPayload,
} from "@omnesis/core";
import { GatewayWsClient, HttpGatewayClient } from "@omnesis/gateway-client";
import { AccountId, SourceType, type DeviceCapability } from "@omnesis/types";
import { SyncEngine } from "../sync-engine.js";
import { SourceManager } from "../source-manager.js";
import { createSourceWsHandlers } from "../source-ws-handlers.js";
import { allDefinitions, allDescriptors } from "../source-descriptors.js";
import { MultiCollectorHarness, waitForCondition } from "./multi-collector-harness.js";
import type { CollectorInternalConfig } from "../internal-config.js";

const SOURCE_TYPE = "apple-call-log";
const ACCOUNT_ID = "john.smith@icloud.example";
const SOURCE_ID = `${SOURCE_TYPE}:${ACCOUNT_ID}`;

interface RealCollector {
  name: string;
  deviceId: string;
  token: string;
  gateway: HttpGatewayClient;
  engine: SyncEngine;
  manager: SourceManager;
  ws: GatewayWsClient;
}

function commandPayload<K extends WsCommandType>(type: K, raw: unknown): WsRequestPayload<K> {
  const parsed = parseRequestPayload(type, raw);
  if (!parsed.ok) throw new Error(`Invalid ${type} payload: ${parsed.error}`);
  return parsed.value;
}

describe("replicated Apple source across real collector lifecycles", () => {
  let harness: MultiCollectorHarness;
  let tempRoot: string;
  let owner: RealCollector;
  let member: RealCollector;

  const admin = <T>(path: string, init?: RequestInit) => harness.json<T>(path, init);
  const capabilities = (name: string): DeviceCapability => ({
    hostname: `${name}.example.com`,
    platform: "darwin",
    hostableSourceTypes: [SourceType(SOURCE_TYPE)],
    syncLease: true,
    multiDeviceModes: { [SOURCE_TYPE]: "replicated" },
    memberScopedParams: { [SOURCE_TYPE]: [] },
  });
  const documentCount = (): number => {
    const db = new SqliteDatabase(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<
          [string],
          { count: number }
        >("SELECT COUNT(*) AS count FROM documents WHERE source_id = ?")
        .get(SOURCE_ID)!.count;
    } finally {
      db.close();
    }
  };
  const cursorSynced = (deviceId: string): boolean => {
    const db = new SqliteDatabase(harness.getDbPath(), { readonly: true });
    try {
      return (
        db
          .prepare<
            [string, string],
            { last_synced_at: string | null }
          >("SELECT last_synced_at FROM sync_state WHERE source_id = ? AND device_id = ?")
          .get(SOURCE_ID, deviceId)?.last_synced_at != null
      );
    } finally {
      db.close();
    }
  };
  const analyticsCount = async (): Promise<number> => {
    const { rows } = await admin<{ rows: unknown[][] }>("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT COUNT(*) FROM apple_call_log" }),
    });
    return Number(rows[0]?.[0] ?? 0);
  };
  const connectCollectorWs = (collector: Omit<RealCollector, "ws">): GatewayWsClient => {
    const ws = new GatewayWsClient(harness.gatewayUrl, collector.token, {
      capabilities: capabilities(collector.name),
    });
    const sourceHandlers = createSourceWsHandlers({
      sourceManager: collector.manager,
      gateway: collector.gateway,
      emitEvent: (type, payload) => ws.emitEvent(type, payload),
    });
    ws.onCommand(async (command) => {
      const handled = sourceHandlers.handle(command as WsCommand);
      if (handled !== undefined) return handled;
      switch (command.type) {
        case "sources.snapshot": {
          const payload = commandPayload("sources.snapshot", command.payload);
          await collector.manager.applySourcesSnapshot(payload.sources);
          return { ok: true, applied: payload.sources.length };
        }
        case "source.added":
        case "source.updated": {
          const payload = commandPayload(command.type, command.payload);
          if (payload.source) {
            await collector.manager.applySourcesSnapshot([payload.source], { merge: true });
          }
          return { ok: true, applied: Boolean(payload.source) };
        }
        case "source.removed": {
          const payload = commandPayload("source.removed", command.payload);
          await collector.manager.removeSources([payload.sourceId]);
          return { ok: true, applied: true };
        }
        case "source.sync": {
          const payload = commandPayload("source.sync", command.payload);
          const result = collector.engine.triggerSync(payload.sourceId);
          return {
            ok: !result.error,
            triggered: result.triggered.length,
            skipped: result.skipped.length,
            disabled: result.disabled.length,
          };
        }
        default:
          throw new Error(`Unhandled real collector command ${command.type}`);
      }
    });
    return ws;
  };
  const startCollector = async (name: string, legacyOwner: boolean): Promise<RealCollector> => {
    const paired = await admin<{ device: { id: string }; token: string }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name,
        kind: "collector",
        scopes: ["read", "write:*", "admin"],
        capabilities: legacyOwner
          ? {
              hostname: `${name}.example.com`,
              platform: "darwin",
              hostableSourceTypes: [SOURCE_TYPE],
            }
          : capabilities(name),
      }),
    });
    const gateway = new HttpGatewayClient(harness.gatewayUrl, paired.token);
    if (legacyOwner) {
      const registered = await gateway.bulkUpsertSources([
        {
          type: SourceType(SOURCE_TYPE),
          accountId: AccountId(ACCOUNT_ID),
          enabled: true,
        },
      ]);
      expect(registered.errors).toEqual([]);
    }
    const engine = new SyncEngine(gateway);
    const definitions = allDefinitions.filter(
      (definition) => definition.type === "provider" && definition.provider.id === "apple",
    );
    const descriptors = allDescriptors.filter(
      (descriptor) => String(descriptor.id) === SOURCE_TYPE,
    );
    const config: CollectorInternalConfig = { sources: {}, defaultSyncInterval: "999999s" };
    const manager = new SourceManager(engine, gateway, config, {
      definitions,
      descriptors,
      configDir: join(tempRoot, `${name}-config`),
    });
    const partial = {
      name,
      deviceId: paired.device.id,
      token: paired.token,
      gateway,
      engine,
      manager,
    };
    const collector: RealCollector = { ...partial, ws: connectCollectorWs(partial) };
    collector.ws.connect();
    return collector;
  };

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    tempRoot = mkdtempSync(join(tmpdir(), "omnesis-apple-replica-e2e-"));
    owner = await startCollector("apple-owner", true);
    await vi.waitFor(() => expect(owner.engine.getSourcesById(SOURCE_ID)).toHaveLength(1), {
      timeout: 30_000,
      interval: 100,
    });
  }, 120_000);

  afterAll(async () => {
    for (const collector of [owner, member].filter(Boolean)) {
      collector.ws.disconnect();
      collector.engine.stopSyncLoop();
    }
    await harness.destroy();
    rmSync(tempRoot, { recursive: true, force: true });
  }, 30_000);

  test("transitions, joins, restores on reconnect, syncs and detaches through source commands", async () => {
    expect(
      (
        await admin<{ items: Array<{ id: string; multiDeviceMode: string }> }>("/admin/sources")
      ).items.find((source) => source.id === SOURCE_ID)?.multiDeviceMode,
    ).toBe("exclusive");

    await vi.waitFor(() => expect(documentCount()).toBeGreaterThan(0), {
      timeout: 30_000,
      interval: 100,
    });
    const documents = documentCount();
    const analytics = await analyticsCount();
    expect(analytics).toBeGreaterThan(0);

    await admin(`/admin/sources/${encodeURIComponent(SOURCE_ID)}`, {
      method: "PATCH",
      body: JSON.stringify({ multiDeviceMode: "replicated" }),
    });
    member = await startCollector("apple-member", false);
    expect(member.engine.getSourcesById(SOURCE_ID)).toEqual([]);
    const joined = await member.gateway.bulkUpsertSources([
      {
        type: SourceType(SOURCE_TYPE),
        accountId: AccountId(ACCOUNT_ID),
        enabled: true,
      },
    ]);
    expect(joined.errors).toEqual([]);
    await vi.waitFor(() => expect(member.engine.getSourcesById(SOURCE_ID)).toHaveLength(1), {
      timeout: 30_000,
      interval: 100,
    });

    expect(member.engine.triggerSync(SOURCE_ID).triggered).toEqual([SOURCE_ID]);
    await vi.waitFor(() => expect(cursorSynced(member.deviceId)).toBe(true), {
      timeout: 30_000,
      interval: 100,
    });
    expect(documentCount()).toBe(documents);
    expect(await analyticsCount()).toBe(analytics);

    member.ws.disconnect();
    await waitForCondition(
      async () => {
        const { items } = await admin<{ items: Array<{ id: string; online: boolean }> }>(
          "/admin/devices",
        );
        return items.find((device) => device.id === member.deviceId)?.online === false;
      },
      10_000,
      "Apple replica collector offline",
    );
    await member.manager.applySourcesSnapshot([]);
    expect(member.engine.getSourcesById(SOURCE_ID)).toEqual([]);
    member.ws = connectCollectorWs(member);
    member.ws.connect();
    await vi.waitFor(() => expect(member.engine.getSourcesById(SOURCE_ID)).toHaveLength(1), {
      timeout: 30_000,
      interval: 100,
    });

    await admin(`/admin/sources/${encodeURIComponent(SOURCE_ID)}/members/${member.deviceId}`, {
      method: "DELETE",
    });
    await vi.waitFor(() => expect(member.engine.getSourcesById(SOURCE_ID)).toEqual([]), {
      timeout: 30_000,
      interval: 100,
    });
    expect(member.engine.triggerSync(SOURCE_ID).error).toMatch(/No sources match/);
    expect(documentCount()).toBe(documents);
    expect(await analyticsCount()).toBe(analytics);
  }, 180_000);
});
