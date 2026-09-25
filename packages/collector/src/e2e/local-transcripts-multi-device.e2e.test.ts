// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { GatewayWsClient, HttpGatewayClient } from "@omnesis/gateway-client";
import { AccountId, SourceType, type DeviceCapability } from "@omnesis/types";
import { SyncEngine } from "../sync-engine.js";
import { SourceManager } from "../source-manager.js";
import { createSourceWsHandlers } from "../source-ws-handlers.js";
import { createCommandDispatch } from "../ws-command-dispatch.js";
import { allDefinitions, allDescriptors } from "../source-descriptors.js";
import { MultiCollectorHarness, waitForCondition } from "./multi-collector-harness.js";
import type { CollectorInternalConfig } from "../internal-config.js";

const SOURCE_IDS = ["claude-code:local", "codex:local", "pi:local"] as const;
const TYPES = ["claude-code", "codex", "pi"] as const;

interface RealCollector {
  name: string;
  deviceId: string;
  token: string;
  gateway: HttpGatewayClient;
  engine: SyncEngine;
  manager: SourceManager;
  ws: GatewayWsClient;
}

function writeClaudeStore(root: string, marker: string): string {
  const path = join(root, "project", "shared-session.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  const at = "2026-01-08T09:00:00.000Z";
  const base = (type: string, uuid: string, parentUuid: string | null) => ({
    type,
    uuid,
    parentUuid,
    sessionId: "shared-session",
    timestamp: at,
    cwd: "/work/example-project",
    gitBranch: "main",
    isSidechain: false,
  });
  writeFileSync(
    path,
    [
      {
        ...base("user", "user-1", null),
        userType: "external",
        message: { role: "user", content: `Review ${marker}` },
      },
      {
        ...base("assistant", "assistant-1", "user-1"),
        message: {
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: `${marker} is ready.` }],
        },
      },
      { type: "last-prompt", sessionId: "shared-session", leafUuid: "assistant-1" },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  return path;
}

function writeCodexStore(root: string, marker: string): string {
  const path = join(root, "sessions", "2026", "01", "08", "shared-session.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  const line = (type: string, payload: Record<string, unknown>) => ({
    type,
    timestamp: "2026-01-08T09:00:00.000Z",
    payload,
  });
  writeFileSync(
    path,
    [
      line("session_meta", {
        id: "shared-session",
        session_id: "shared-session",
        cwd: "/work/example-project",
        source: "cli",
      }),
      line("event_msg", { type: "user_message", message: `Review ${marker}` }),
      line("response_item", {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: `${marker} is ready.` }],
      }),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  return path;
}

function writePiStore(root: string, marker: string): string {
  const path = join(root, "shared-session.jsonl");
  mkdirSync(root, { recursive: true });
  const at = "2026-01-08T09:00:00.000Z";
  writeFileSync(
    path,
    [
      {
        type: "session",
        version: 3,
        id: "shared-session",
        timestamp: at,
        cwd: "/work/example-project",
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: at,
        message: { role: "user", content: [{ type: "text", text: `Review ${marker}` }] },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: at,
        message: {
          role: "assistant",
          provider: "fictional",
          model: "code-model",
          stopReason: "stop",
          content: [{ type: "text", text: `${marker} is ready.` }],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  return path;
}

describe("partitioned local transcript sources across real collectors", () => {
  let harness: MultiCollectorHarness;
  let tempRoot: string;
  let owner: RealCollector;
  let member: RealCollector;
  let ownerClaude: string;
  let ownerCodex: string;
  let ownerPi: string;
  let memberClaude: string;
  let memberCodex: string;
  let memberPi: string;
  let memberClaudeFile: string;
  let memberCodexFile: string;
  let memberPiFile: string;

  const admin = <T>(path: string, init?: RequestInit) => harness.json<T>(path, init);
  const rows = (sourceId: string) => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<
          [string],
          { external_id: string; stream_id: string; content: string }
        >("SELECT external_id, stream_id, content FROM documents WHERE source_id = ? ORDER BY stream_id")
        .all(sourceId);
    } finally {
      db.close();
    }
  };
  const startCollector = async (
    name: string,
    paths: { sessionsPath: string; codexHome: string; piSessionsPath: string },
    legacyPair: boolean,
  ): Promise<RealCollector> => {
    const paired = await admin<{ device: { id: string }; token: string }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name,
        kind: "collector",
        scopes: ["read", "write:*", "admin"],
        capabilities: legacyPair
          ? { hostname: `${name}.example.com`, platform: "linux", hostableSourceTypes: TYPES }
          : capabilities(name),
      }),
    });
    const gateway = new HttpGatewayClient(harness.gatewayUrl, paired.token);
    if (legacyPair) {
      for (const [type, param, value] of [
        ["claude-code", "sessionsPath", paths.sessionsPath],
        ["codex", "codexHome", paths.codexHome],
        ["pi", "sessionsPath", paths.piSessionsPath],
      ] as const) {
        const result = await gateway.bulkUpsertSources([
          {
            type: SourceType(type),
            accountId: AccountId("local"),
            config: { params: { [param]: value } },
            enabled: true,
          },
        ]);
        expect(result.errors).toEqual([]);
      }
    }
    const engine = new SyncEngine(gateway);
    const definitions = allDefinitions.filter(
      (definition) =>
        definition.type === "source" && TYPES.includes(definition.id as (typeof TYPES)[number]),
    );
    const descriptors = allDescriptors.filter((descriptor) =>
      TYPES.includes(String(descriptor.id) as (typeof TYPES)[number]),
    );
    const config: CollectorInternalConfig = { sources: {}, defaultSyncInterval: "999999s" };
    const manager = new SourceManager(engine, gateway, config, {
      definitions,
      descriptors,
      configDir: join(tempRoot, `${name}-config`),
    });
    const ws = connectCollectorWs(name, paired.token, gateway, manager, engine);
    ws.connect();
    const collector = {
      name,
      deviceId: paired.device.id,
      token: paired.token,
      gateway,
      engine,
      manager,
      ws,
    };
    return collector;
  };
  const capabilities = (name: string): DeviceCapability => ({
    hostname: `${name}.example.com`,
    platform: "linux",
    hostableSourceTypes: TYPES.map(SourceType),
    syncLease: true,
    multiDeviceModes: Object.fromEntries(TYPES.map((type) => [type, "partitioned"])),
    memberScopedParams: {
      "claude-code": ["sessionsPath"],
      codex: ["codexHome"],
      pi: ["sessionsPath"],
    },
  });
  const connectCollectorWs = (
    name: string,
    token: string,
    gateway: HttpGatewayClient,
    manager: SourceManager,
    engine: SyncEngine,
  ): GatewayWsClient => {
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
    commands.register("source.sync", ({ sourceId, restart }) => {
      const result = engine.triggerSync(sourceId, { restart: restart === true });
      return {
        ok: !result.error,
        triggered: result.triggered.length,
        skipped: result.skipped.length,
        disabled: result.disabled.length,
        restarting: result.restarting.length,
        ...(result.error ? { error: result.error } : {}),
      };
    });
    ws.onCommand(async (command) => {
      const handled = sourceHandlers.handle(command);
      if (handled !== undefined) return handled;
      const byEngine = commands.handle(command);
      if (byEngine !== undefined) return byEngine;
      throw new Error(`Unhandled real collector command ${command.type}`);
    });
    return ws;
  };
  const waitForStreams = async (count: number) => {
    await vi.waitFor(
      () => {
        for (const id of SOURCE_IDS) expect(rows(id)).toHaveLength(count);
      },
      { timeout: 30_000, interval: 100 },
    );
  };

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
      gatewayConfig: { gateway: { snapshotAbsence: { minObservations: 1, minAge: "1ms" } } },
    });
    await harness.start();
    tempRoot = mkdtempSync(join(tmpdir(), "omnesis-local-transcript-e2e-"));
    ownerClaude = join(tempRoot, "owner-claude");
    ownerCodex = join(tempRoot, "owner-codex");
    ownerPi = join(tempRoot, "owner-pi");
    memberClaude = join(tempRoot, "member-claude");
    memberCodex = join(tempRoot, "member-codex");
    memberPi = join(tempRoot, "member-pi");
    writeClaudeStore(ownerClaude, "owner transcript");
    writeCodexStore(ownerCodex, "owner transcript");
    writePiStore(ownerPi, "owner transcript");
    memberClaudeFile = writeClaudeStore(memberClaude, "member transcript");
    memberCodexFile = writeCodexStore(memberCodex, "member transcript");
    memberPiFile = writePiStore(memberPi, "member transcript");
    owner = await startCollector(
      "collector-owner",
      { sessionsPath: ownerClaude, codexHome: ownerCodex, piSessionsPath: ownerPi },
      true,
    );
    member = await startCollector(
      "collector-member",
      { sessionsPath: memberClaude, codexHome: memberCodex, piSessionsPath: memberPi },
      false,
    );
    await waitForStreams(1);
  }, 120_000);

  afterAll(async () => {
    for (const collector of [owner, member].filter(Boolean)) {
      collector.ws.disconnect();
      collector.engine.stopSyncLoop();
    }
    await harness.destroy();
    rmSync(tempRoot, { recursive: true, force: true });
  }, 30_000);

  test("migrates, isolates member paths and streams, resyncs one member, then detaches it", async () => {
    for (const id of SOURCE_IDS) {
      expect(rows(id)).toMatchObject([{ stream_id: "" }]);
      await admin(`/admin/sources/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ multiDeviceMode: "partitioned" }),
      });
      expect(rows(id)).toMatchObject([{ stream_id: owner.deviceId }]);
    }

    for (const [type, memberConfig] of [
      ["claude-code", { params: { sessionsPath: memberClaude } }],
      ["codex", { params: { codexHome: memberCodex } }],
      ["pi", { params: { sessionsPath: memberPi } }],
    ] as const) {
      const joined = await member.gateway.bulkUpsertSources([
        { type: SourceType(type), accountId: AccountId("local"), memberConfig, enabled: true },
      ]);
      expect(joined.errors).toEqual([]);
      expect(joined.sources[0]?.memberConfigApplied).toBe(true);
    }
    await waitForStreams(2);
    expect(owner.engine.getSourcesById(SOURCE_IDS[0])[0]?.instance.watchPaths).toEqual([
      ownerClaude,
    ]);
    expect(member.engine.getSourcesById(SOURCE_IDS[0])[0]?.instance.watchPaths).toEqual([
      memberClaude,
    ]);
    expect(owner.engine.getSourcesById(SOURCE_IDS[1])[0]?.instance.watchPaths).toContain(
      join(ownerCodex, "sessions"),
    );
    expect(member.engine.getSourcesById(SOURCE_IDS[1])[0]?.instance.watchPaths).toContain(
      join(memberCodex, "sessions"),
    );
    expect(owner.engine.getSourcesById(SOURCE_IDS[2])[0]?.instance.watchPaths).toEqual([ownerPi]);
    expect(member.engine.getSourcesById(SOURCE_IDS[2])[0]?.instance.watchPaths).toEqual([memberPi]);
    for (const id of SOURCE_IDS) {
      const docs = rows(id);
      expect(new Set(docs.map((row) => row.external_id))).toHaveLength(1);
      expect(new Set(docs.map((row) => row.stream_id))).toEqual(
        new Set([owner.deviceId, member.deviceId]),
      );
      expect(docs.some((row) => row.content.includes("owner transcript"))).toBe(true);
      expect(docs.some((row) => row.content.includes("member transcript"))).toBe(true);
    }

    unlinkSync(memberClaudeFile);
    unlinkSync(memberCodexFile);
    unlinkSync(memberPiFile);
    for (const id of SOURCE_IDS) member.engine.triggerSync(id);
    await vi.waitFor(
      () => {
        const db = new Database(harness.getDbPath(), { readonly: true });
        try {
          for (const id of SOURCE_IDS) {
            expect(
              db
                .prepare<
                  [string],
                  { stream_id: string }
                >("SELECT DISTINCT stream_id FROM document_absences WHERE source_id = ?")
                .all(id),
            ).toEqual([{ stream_id: member.deviceId }]);
          }
        } finally {
          db.close();
        }
      },
      { timeout: 30_000, interval: 100 },
    );

    member.ws.disconnect();
    await waitForCondition(
      async () => {
        const { items } = await admin<{ items: Array<{ id: string; online: boolean }> }>(
          "/admin/devices",
        );
        return items.find((device) => device.id === member.deviceId)?.online === false;
      },
      10_000,
      "member collector offline",
    );
    // Clear the in-process registry to model lost volatile state, then prove
    // a WS reconnect snapshot restores the gateway-persisted member overlay.
    await member.manager.applySourcesSnapshot([]);
    for (const id of SOURCE_IDS) expect(member.engine.getSourcesById(id)).toEqual([]);
    writeClaudeStore(memberClaude, "member transcript rebuilt");
    writeCodexStore(memberCodex, "member transcript rebuilt");
    writePiStore(memberPi, "member transcript rebuilt");
    member.ws = connectCollectorWs(
      member.name,
      member.token,
      member.gateway,
      member.manager,
      member.engine,
    );
    member.ws.connect();
    await waitForCondition(
      async () => {
        const { items } = await admin<{ items: Array<{ id: string; online: boolean }> }>(
          "/admin/devices",
        );
        return items.find((device) => device.id === member.deviceId)?.online === true;
      },
      10_000,
      "member collector reconnected",
    );
    await vi.waitFor(
      () => {
        expect(member.engine.getSourcesById(SOURCE_IDS[0])).toHaveLength(1);
        expect(member.engine.getSourcesById(SOURCE_IDS[1])).toHaveLength(1);
        expect(member.engine.getSourcesById(SOURCE_IDS[2])).toHaveLength(1);
      },
      { timeout: 30_000, interval: 100 },
    );
    expect(member.engine.getSourcesById(SOURCE_IDS[0])[0]?.instance.watchPaths).toEqual([
      memberClaude,
    ]);
    expect(member.engine.getSourcesById(SOURCE_IDS[1])[0]?.instance.watchPaths).toContain(
      join(memberCodex, "sessions"),
    );
    expect(member.engine.getSourcesById(SOURCE_IDS[2])[0]?.instance.watchPaths).toEqual([memberPi]);
    // Hold member writes until every deletion is observed: a fast rebootstrap
    // can otherwise repopulate its stream before the resync HTTP response arrives.
    let releaseWrites!: () => void;
    const writesAllowed = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const upsertWithCursor = member.gateway.upsertWithCursor.bind(member.gateway);
    const memberWrites = vi
      .spyOn(member.gateway, "upsertWithCursor")
      .mockImplementation(async (args) => {
        await writesAllowed;
        return upsertWithCursor(args);
      });
    const triggerSync = vi.spyOn(member.engine, "triggerSync");
    try {
      for (const id of SOURCE_IDS) {
        await admin(`/admin/sources/${encodeURIComponent(id)}/resync`, {
          method: "POST",
          body: JSON.stringify({ deviceId: member.deviceId }),
        });
        // Reconnect can still be syncing when resync fences its write epoch.
        // The WS command must request a restart, not skip that in-flight run.
        expect(triggerSync).toHaveBeenCalledWith(id, { restart: true });
        expect(rows(id).map((row) => row.stream_id)).toEqual([owner.deviceId]);
      }
    } finally {
      releaseWrites();
      memberWrites.mockRestore();
      triggerSync.mockRestore();
    }
    // The public resync action must dispatch source.sync to the addressed
    // collector. Do not trigger the engine directly: that would hide a broken
    // gateway-to-collector command path.
    await waitForStreams(2);
    member.engine.stopSyncLoop();

    for (const id of SOURCE_IDS) {
      await admin(`/admin/sources/${encodeURIComponent(id)}/members/${member.deviceId}`, {
        method: "DELETE",
      });
      expect(rows(id).map((row) => row.stream_id)).toEqual([owner.deviceId]);
    }
    const { items } = await admin<{ items: Array<{ id: string; members: string[] }> }>(
      "/admin/sources",
    );
    for (const id of SOURCE_IDS) {
      expect(items.find((source) => source.id === id)?.members).toEqual([owner.deviceId]);
    }
  }, 180_000);
});
