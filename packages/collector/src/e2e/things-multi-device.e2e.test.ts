// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { GatewayWsClient, HttpGatewayClient } from "@omnesis/gateway-client";
import thingsDefinition from "@omnesis/provider-things";
import { AccountId, SourceType, type DeviceCapability } from "@omnesis/types";
import { extractDescriptors } from "../source-descriptors.js";
import { SourceManager } from "../source-manager.js";
import { createSourceWsHandlers } from "../source-ws-handlers.js";
import { SyncEngine } from "../sync-engine.js";
import { createCommandDispatch } from "../ws-command-dispatch.js";
import { MultiCollectorHarness, waitForCondition } from "./multi-collector-harness.js";
import type { CollectorInternalConfig } from "../internal-config.js";

const SOURCE_ID = "things:local";
const SOURCE_TYPE = "things";

interface RealCollector {
  deviceId: string;
  token: string;
  gateway: HttpGatewayClient;
  engine: SyncEngine;
  manager: SourceManager;
  ws: GatewayWsClient;
}

interface ReplicaTask {
  uuid: string;
  title: string;
  modified: number;
}

function createThingsReplica(path: string, tasks: readonly ReplicaTask[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE TMTask (
      uuid TEXT PRIMARY KEY,
      title TEXT,
      notes TEXT,
      type INTEGER DEFAULT 0,
      status INTEGER DEFAULT 0,
      trashed INTEGER DEFAULT 0,
      creationDate REAL,
      userModificationDate REAL,
      startDate INTEGER,
      deadline INTEGER,
      stopDate REAL,
      start INTEGER DEFAULT 1,
      project TEXT,
      area TEXT,
      heading TEXT
    );
    CREATE TABLE TMChecklistItem (
      uuid TEXT PRIMARY KEY,
      title TEXT,
      status INTEGER DEFAULT 0,
      task TEXT,
      "index" INTEGER
    );
    CREATE TABLE TMArea (uuid TEXT PRIMARY KEY, title TEXT);
  `);
  const insert = db.prepare(`
    INSERT INTO TMTask
      (uuid, title, notes, type, status, trashed, creationDate, userModificationDate,
       startDate, deadline, stopDate, start, project, area, heading)
    VALUES (?, ?, '', 0, 0, 0, 790000000, ?, NULL, NULL, NULL, 1, NULL, NULL, NULL)
  `);
  for (const task of tasks) insert.run(task.uuid, task.title, task.modified);
  db.close();
}

function deleteReplicaTask(path: string, uuid: string): void {
  const db = new Database(path);
  try {
    db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(uuid);
  } finally {
    db.close();
  }
}

function trashReplicaTask(path: string, uuid: string, modified: number): void {
  const db = new Database(path);
  try {
    db.prepare("UPDATE TMTask SET trashed = 1, userModificationDate = ? WHERE uuid = ?").run(
      modified,
      uuid,
    );
  } finally {
    db.close();
  }
}

describe("Things replicas across real collectors", () => {
  let harness: MultiCollectorHarness;
  let tempRoot: string;
  let ownerDbPath: string;
  let memberDbPath: string;
  let owner: RealCollector;
  let member: RealCollector;

  const admin = <T>(path: string, init?: RequestInit) => harness.json<T>(path, init);
  const capabilities = (name: string): DeviceCapability => ({
    hostname: `${name}.example.com`,
    platform: "darwin",
    hostableSourceTypes: [SourceType(SOURCE_TYPE)],
    syncLease: true,
    multiDeviceModes: { [SOURCE_TYPE]: "replicated" },
    replicaVersionPolicies: { [SOURCE_TYPE]: "source-updated-at" },
    memberScopedParams: { [SOURCE_TYPE]: ["dbPath"] },
  });
  const documentRows = () => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<
          [string],
          { external_id: string; stream_id: string; title: string; source_updated_at: string }
        >("SELECT external_id, stream_id, title, source_updated_at FROM documents WHERE source_id = ? ORDER BY external_id")
        .all(SOURCE_ID);
    } finally {
      db.close();
    }
  };
  const cursorStamp = (deviceId: string): string | null => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return (
        db
          .prepare<
            [string, string],
            { last_synced_at: string | null }
          >("SELECT last_synced_at FROM sync_state WHERE source_id = ? AND device_id = ?")
          .get(SOURCE_ID, deviceId)?.last_synced_at ?? null
      );
    } finally {
      db.close();
    }
  };
  const syncAndWait = async (collector: RealCollector): Promise<void> => {
    const before = cursorStamp(collector.deviceId);
    const triggered = collector.engine.triggerSync(SOURCE_ID);
    expect(triggered.error).toBeUndefined();
    await waitForCondition(
      () => Promise.resolve(cursorStamp(collector.deviceId) !== before),
      30_000,
      `${collector.deviceId} completed a Things sync`,
    );
  };
  const syncAndExpectDeferred = async (collector: RealCollector): Promise<void> => {
    const before = cursorStamp(collector.deviceId);
    const events: string[] = [];
    collector.engine.onStatusChange((change) => {
      if (change.sourceId === SOURCE_ID) events.push(change.event);
    });
    const triggered = collector.engine.triggerSync(SOURCE_ID);
    expect(triggered.error).toBeUndefined();
    await waitForCondition(
      () => Promise.resolve(events.includes("sync.deferred")),
      30_000,
      `${collector.deviceId} observed the deferred Things deletion`,
    );
    expect(cursorStamp(collector.deviceId)).toBe(before);
    expect(events).not.toContain("sync.error");
  };
  const runAbsenceSweep = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The periodic alternates document and analytics planes. Two kicks are
    // one complete cycle regardless of which plane the background scheduler
    // most recently visited.
    for (let phase = 0; phase < 2; phase++) {
      await admin("/admin/background/run/absence.sweep", { method: "POST" });
    }
  };
  const giveOwnerDeletionAuthority = async (): Promise<void> => {
    await member.gateway.releaseSyncLease(SOURCE_ID as never);
    expect(await owner.gateway.claimSyncLease(SOURCE_ID as never)).toMatchObject({
      granted: true,
    });
  };
  const giveMemberDeletionAuthority = async (): Promise<void> => {
    await owner.gateway.releaseSyncLease(SOURCE_ID as never);
    expect(await member.gateway.claimSyncLease(SOURCE_ID as never)).toMatchObject({
      granted: true,
    });
  };
  const cursorDevices = () => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<[string], { device_id: string }>(
          "SELECT device_id FROM sync_state WHERE source_id = ? AND last_synced_at IS NOT NULL ORDER BY device_id",
        )
        .all(SOURCE_ID)
        .map((row) => row.device_id);
    } finally {
      db.close();
    }
  };
  const connect = (
    name: string,
    token: string,
    gateway: HttpGatewayClient,
    manager: SourceManager,
    engine: SyncEngine,
  ) => {
    const ws = new GatewayWsClient(harness.gatewayUrl, token, {
      capabilities: capabilities(name),
    });
    const sourceHandlers = createSourceWsHandlers({
      sourceManager: manager,
      gateway,
      emitEvent: (type, payload) => ws.emitEvent(type, payload),
    });
    const commands = createCommandDispatch();
    commands.register("sources.snapshot", async ({ sources }) => {
      await manager.applySourcesSnapshot(sources);
      return { ok: true, applied: sources.length };
    });
    commands.register("source.added", async ({ source }) => {
      if (source) await manager.applySourcesSnapshot([source], { merge: true });
      return { ok: true, applied: Boolean(source) };
    });
    commands.register("source.updated", async ({ source }) => {
      if (source) await manager.applySourcesSnapshot([source], { merge: true });
      return { ok: true, applied: Boolean(source) };
    });
    commands.register("source.removed", async ({ sourceId }) => {
      await manager.removeSources([sourceId]);
      return { ok: true, applied: true };
    });
    commands.register("source.sync", ({ sourceId }) => {
      const result = engine.triggerSync(sourceId);
      return {
        ok: !result.error,
        triggered: result.triggered.length,
        skipped: result.skipped.length,
        disabled: result.disabled.length,
      };
    });
    ws.onCommand(async (command) => {
      const handled = sourceHandlers.handle(command);
      if (handled !== undefined) return handled;
      const byEngine = commands.handle(command);
      if (byEngine !== undefined) return byEngine;
      throw new Error(`Unhandled real collector command ${command.type}`);
    });
    ws.connect();
    return ws;
  };
  const startCollector = async (
    name: string,
    dbPath: string,
    createLegacySource: boolean,
  ): Promise<RealCollector> => {
    const paired = await admin<{ device: { id: string }; token: string }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name,
        kind: "collector",
        scopes: ["read", "write:*", "admin"],
        capabilities: createLegacySource
          ? {
              hostname: `${name}.example.com`,
              platform: "darwin",
              hostableSourceTypes: [SOURCE_TYPE],
            }
          : capabilities(name),
      }),
    });
    const gateway = new HttpGatewayClient(harness.gatewayUrl, paired.token);
    if (createLegacySource) {
      const result = await gateway.bulkUpsertSources([
        {
          type: SourceType(SOURCE_TYPE),
          accountId: AccountId("local"),
          config: { params: { dbPath } },
          enabled: true,
        },
      ]);
      expect(result.errors).toEqual([]);
    }
    const engine = new SyncEngine(gateway);
    const manager = new SourceManager(
      engine,
      gateway,
      { sources: {}, defaultSyncInterval: "999999s" } satisfies CollectorInternalConfig,
      {
        definitions: [thingsDefinition],
        descriptors: extractDescriptors(thingsDefinition),
        configDir: join(tempRoot, `${name}-config`),
      },
    );
    const ws = connect(name, paired.token, gateway, manager, engine);
    return { deviceId: paired.device.id, token: paired.token, gateway, engine, manager, ws };
  };

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
      extraGatewayEnv: { OMNESIS_SYNTHETIC: "1" },
      gatewayConfig: {
        gateway: {
          snapshotAbsence: {
            minObservations: 1,
            minAge: "1ms",
            deletionGrace: "1ms",
          },
        },
      },
    });
    await harness.start();
    tempRoot = mkdtempSync(join(tmpdir(), "omnesis-things-replicas-"));
    ownerDbPath = join(tempRoot, "owner", "main.sqlite");
    memberDbPath = join(tempRoot, "member", "main.sqlite");
    createThingsReplica(ownerDbPath, [
      { uuid: "task-stable-a", title: "Newest title from owner", modified: 790000020 },
      { uuid: "task-stable-b", title: "Earlier title from owner", modified: 790000010 },
    ]);
    createThingsReplica(memberDbPath, [
      { uuid: "task-stable-a", title: "Earlier title from member", modified: 790000010 },
      { uuid: "task-stable-b", title: "Newest title from member", modified: 790000020 },
    ]);
    owner = await startCollector("things-owner", ownerDbPath, true);
    member = await startCollector("things-member", memberDbPath, false);
  }, 120_000);

  afterAll(async () => {
    for (const collector of [owner, member].filter(Boolean)) {
      collector.ws.disconnect();
      collector.engine.stopSyncLoop();
    }
    await harness.destroy();
    rmSync(tempRoot, { recursive: true, force: true });
  }, 30_000);

  test("adopts, converges, repairs snapshot and tombstone deletions, then detaches safely", async () => {
    await vi.waitFor(() => expect(documentRows()).toHaveLength(2), {
      timeout: 30_000,
      interval: 100,
    });
    expect(documentRows()).toEqual([
      {
        external_id: "task-stable-a",
        stream_id: "",
        title: "Newest title from owner",
        source_updated_at: "1995-01-13T12:27:00.000Z",
      },
      {
        external_id: "task-stable-b",
        stream_id: "",
        title: "Earlier title from owner",
        source_updated_at: "1995-01-13T12:26:50.000Z",
      },
    ]);

    await admin(`/admin/sources/${encodeURIComponent(SOURCE_ID)}`, {
      method: "PATCH",
      body: JSON.stringify({ multiDeviceMode: "replicated" }),
    });
    const joined = await member.gateway.bulkUpsertSources([
      {
        type: SourceType(SOURCE_TYPE),
        accountId: AccountId("local"),
        memberConfig: { params: { dbPath: memberDbPath } },
        enabled: true,
      },
    ]);
    expect(joined.errors).toEqual([]);
    expect(joined.sources[0]?.memberConfigApplied).toBe(true);

    await waitForCondition(
      () => Promise.resolve(cursorDevices().length === 2),
      30_000,
      "both Things replicas committed independent cursors",
    );
    expect(cursorDevices()).toEqual([owner.deviceId, member.deviceId].sort());
    expect(documentRows().map(({ external_id, title }) => ({ external_id, title }))).toEqual([
      { external_id: "task-stable-a", title: "Newest title from owner" },
      { external_id: "task-stable-b", title: "Newest title from member" },
    ]);
    expect(owner.engine.getSourcesById(SOURCE_ID)[0]?.instance.watchPaths).toContain(ownerDbPath);
    expect(member.engine.getSourcesById(SOURCE_ID)[0]?.instance.watchPaths).toContain(memberDbPath);
    // The acceptance sequence controls every subsequent attempt explicitly.
    // Real filesystem watchers proved the wiring above; stop them now so a
    // database mutation cannot race the lease handoff being exercised.
    owner.engine.stopSyncLoop();
    member.engine.stopSyncLoop();

    // The owner's incomplete copy omits task B, whose winning version came
    // from the member. Absence grace prevents immediate loss; the cursor reset
    // then forces the healthy member to bootstrap and restore its newer row.
    await giveOwnerDeletionAuthority();
    deleteReplicaTask(ownerDbPath, "task-stable-b");
    await syncAndWait(owner);
    expect(documentRows()).toHaveLength(2);

    await runAbsenceSweep();
    await waitForCondition(
      () => Promise.resolve(documentRows().length === 1),
      30_000,
      "the corroborated Things absence was swept",
    );
    expect(cursorStamp(member.deviceId)).toBeNull();

    await syncAndWait(member);
    expect(documentRows().find((row) => row.external_id === "task-stable-b")).toMatchObject({
      title: "Newest title from member",
      source_updated_at: "1995-01-13T12:27:00.000Z",
    });

    // Task B is now disputed: the owner's sweep deleted it and the member's
    // bootstrap restored it. The owner omitting it again changes nothing —
    // the sweep leaves a disputed item alone — until the member's own
    // snapshots stop naming it. Once they do, corroborated under the same
    // policy, the member's verdict settles it with no reset of anyone.
    await giveOwnerDeletionAuthority();
    await syncAndWait(owner);
    await runAbsenceSweep();
    expect(
      documentRows()
        .map((row) => row.external_id)
        .sort(),
    ).toEqual(["task-stable-a", "task-stable-b"]);
    const disputed = await admin<{ items: Array<{ id: string; disputedDeletions: number }> }>(
      "/admin/sources",
    );
    expect(disputed.items.find((source) => source.id === SOURCE_ID)?.disputedDeletions).toBe(1);

    deleteReplicaTask(memberDbPath, "task-stable-b");
    const memberStampBefore = cursorStamp(member.deviceId);
    await syncAndWait(member);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await syncAndWait(member);
    await waitForCondition(
      () => Promise.resolve(documentRows().length === 1),
      30_000,
      "the Things deletion shared by both replicas settled through the member's own snapshots",
    );
    expect(documentRows().map((row) => row.external_id)).toEqual(["task-stable-a"]);
    expect(cursorStamp(member.deviceId)).not.toBeNull();
    expect(cursorStamp(member.deviceId)).not.toBe(memberStampBefore);
    await runAbsenceSweep();
    expect(documentRows().map((row) => row.external_id)).toEqual(["task-stable-a"]);

    // Provider-emitted tombstones obey the same lease authority. A non-holder
    // cannot delete the healthy owner's row and retains its cursor. Once the
    // holder independently processes the same deletion, the non-holder's
    // retry acknowledges the now-resolved tombstone and advances while both
    // collectors remain online; it cannot be pinned behind that page forever.
    trashReplicaTask(memberDbPath, "task-stable-a", 790000030);
    await syncAndExpectDeferred(member);
    expect(documentRows().map((row) => row.external_id)).toEqual(["task-stable-a"]);

    trashReplicaTask(ownerDbPath, "task-stable-a", 790000050);
    await syncAndWait(owner);
    expect(documentRows()).toHaveLength(0);
    expect(cursorStamp(member.deviceId)).toBeNull();
    await syncAndWait(member);
    expect(documentRows()).toHaveLength(0);

    await admin(`/admin/sources/${encodeURIComponent(SOURCE_ID)}/members/${member.deviceId}`, {
      method: "DELETE",
    });
    await waitForCondition(
      () => Promise.resolve(member.engine.getSourcesById(SOURCE_ID).length === 0),
      30_000,
      "the detached collector removed its Things instance",
    );
    expect(documentRows()).toHaveLength(0);
    const { items } = await admin<{ items: Array<{ id: string; members: string[] }> }>(
      "/admin/sources",
    );
    expect(items.find((source) => source.id === SOURCE_ID)?.members).toEqual([owner.deviceId]);
  }, 240_000);
});
