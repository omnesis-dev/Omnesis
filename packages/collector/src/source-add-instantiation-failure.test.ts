// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A source whose provider cannot be instantiated on this host.
 *
 * The whole reported symptom in one place, driven through the real
 * `SourceManager` + `SyncEngine` rather than mocks of them, because the defect
 * was in what those two believe about each other: the manager reported an add
 * as successful without ever asking the engine whether anything had registered.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { defineProvider, defineSource } from "@omnesis/source-sdk";
import { AccountId, ProviderType, SourceType, SyncError } from "@omnesis/types";
import { SyncEngine } from "./sync-engine.js";
import { SourceManager } from "./source-manager.js";
import type {
  GatewayClient,
  SourceDescriptor,
  SourceOrProviderDefinition,
} from "@omnesis/source-sdk";
import type { SyncRemediation } from "@omnesis/types";
import type { StatusChangeEvent } from "./sync-engine.js";

const PROVIDER = "vault";
const NOTES = "vault-notes";
const TASKS = "vault-tasks";
const ACCOUNT = "operator";

const noopSync = async () => ({
  documents: [],
  deletedExternalIds: [],
  cursor: {},
  hasMore: false,
});

function descriptor(id: string): SourceDescriptor {
  return {
    id: SourceType(id),
    name: id,
    description: id,
    provider: { id: ProviderType(PROVIDER), name: "Vault" },
    authType: "local",
  };
}

const descriptors = [descriptor(NOTES), descriptor(TASKS)];

/**
 * A gateway that accepts every upsert, the way the real one does for a source
 * the operator is entitled to add. The add path's own rejection route is
 * covered elsewhere; what matters here is that the gateway says yes and the
 * local instantiation still fails.
 */
function createGateway() {
  const upserted: string[] = [];
  const gateway = {
    async bulkUpsertSources(sources: Array<{ type: string; accountId: string; id?: string }>) {
      const ids = sources.map((s) => s.id ?? `${s.type}:${s.accountId}`);
      upserted.push(...ids);
      return { count: ids.length, sources: ids.map((id) => ({ id, updated: false })), errors: [] };
    },
    async setKnownUrlPatterns() {},
    async setWidgetRenderers() {},
    async setDocumentEventProfiles() {},
    async setLinkDeclarations() {},
    async setSourcePriorDefaults() {},
    async setUrlGraphRoles() {},
    async declareSelfIdentitySources() {},
    async setAnalyticsSchema() {},
    async updateSourceMeta() {},
  } as unknown as GatewayClient;
  return { gateway, upserted };
}

/**
 * Two sources under one provider whose shared context is built from a local
 * resource. `contextError` stands in for whatever makes that resource
 * unreadable — a permission the host has not granted, a database another
 * process holds. `sourceErrors` fails one source's own factory while leaving
 * the shared context intact.
 */
function createDefinitions(gate: {
  contextError?: string;
  /** Raise `contextError` as a typed permission failure carrying this remedy. */
  contextRemediation?: SyncRemediation;
  sourceErrors?: Set<string>;
  accountErrors?: Set<string>;
}) {
  return [
    defineProvider({
      provider: { id: PROVIDER, name: "Vault" },
      authType: "local",
      discover: async () => [AccountId(ACCOUNT), AccountId("locked")],
      createContext: async (options) => {
        if (gate.contextError && gate.contextRemediation) {
          throw new SyncError("permission", gate.contextError, {
            remediation: gate.contextRemediation,
          });
        }
        if (gate.contextError) throw new Error(gate.contextError);
        if (gate.accountErrors?.has(String(options.accountId))) {
          throw new Error(`${options.accountId} is not readable`);
        }
        return {};
      },
      sources: [NOTES, TASKS].map((id) => ({
        id,
        name: id,
        description: id,
        create: async () => {
          if (gate.sourceErrors?.has(id)) throw new Error(`${id} cannot be opened`);
          return { sync: noopSync };
        },
      })),
    }),
  ];
}

describe("a source add whose provider fails to instantiate", () => {
  let tmpDir: string;
  let engine: SyncEngine;
  let events: StatusChangeEvent[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-instantiation-"));
    events = [];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createManager(gate: {
    contextError?: string;
    contextRemediation?: SyncRemediation;
    sourceErrors?: Set<string>;
    accountErrors?: Set<string>;
  }) {
    const { gateway, upserted } = createGateway();
    engine = new SyncEngine(gateway);
    engine.onStatusChange((change) => events.push(change));
    const manager = new SourceManager(
      engine,
      gateway,
      {},
      {
        definitions: createDefinitions(gate),
        descriptors,
        configPath: join(tmpDir, "collector.json"),
        configDir: tmpDir,
      },
    );
    return { manager, upserted };
  }

  test.each(
    [
      { execution: "external" as const, gatewayHosted: true },
      { execution: "external" as const },
      { pushBased: true },
    ].flatMap((execution) => [true, false].map((visible) => ({ execution, visible }))),
  )("external sources need no collector instance: %j", async ({ execution, visible }) => {
    const { gateway } = createGateway();
    engine = new SyncEngine(gateway);
    engine.onStatusChange((change) => events.push(change));
    const id = "external-feed:local";
    const manager = new SourceManager(
      engine,
      gateway,
      {},
      {
        definitions: [
          {
            ...defineSource({
              id: "external-feed",
              name: "External feed",
              description: "Externally ingested records",
              authType: "local",
              execution: "external",
            }),
            ...execution,
            execution: "execution" in execution ? execution.execution : undefined,
          } as SourceOrProviderDefinition,
        ],
        descriptors: visible
          ? [
              {
                ...descriptor("external-feed"),
                provider: { id: ProviderType("external-feed"), name: "External feed" },
                ...execution,
              },
            ]
          : [],
        configPath: join(tmpDir, "collector.json"),
        configDir: tmpDir,
      },
    );
    engine.markUnhosted(id, "external-feed:local", "the provider registered no instance for it");
    events.length = 0;

    await manager.applySourcesSnapshot([{ id, enabled: true }]);
    await manager.applySourcesSnapshot([{ id, enabled: true }]);

    expect(engine.unhostedEntries()).toEqual([]);
    expect(events).toEqual([]);
    expect(engine.getStatuses()).toEqual([]);
    expect(manager.getConfig().sources?.[id]?.enabled).toBe(true);
  });

  test("a hidden external provider entry is not a missing local instance", async () => {
    const { gateway } = createGateway();
    engine = new SyncEngine(gateway);
    engine.onStatusChange((change) => events.push(change));
    const manager = new SourceManager(
      engine,
      gateway,
      {},
      {
        definitions: [
          defineProvider({
            provider: { id: "external-provider", name: "External provider" },
            authType: "local",
            sources: [
              {
                id: "external-feed",
                name: "External feed",
                description: "Externally ingested records",
                execution: "external",
              },
            ],
          }),
        ],
        descriptors: [],
        configPath: join(tmpDir, "collector.json"),
        configDir: tmpDir,
      },
    );
    await manager.applySourcesSnapshot([{ id: "external-feed:local", enabled: true }]);
    expect(engine.unhostedEntries()).toEqual([]);
    expect(events).toEqual([]);
  });

  test("an unknown source declaration still reports a missing instance", async () => {
    const { gateway } = createGateway();
    engine = new SyncEngine(gateway);
    const manager = new SourceManager(
      engine,
      gateway,
      {},
      {
        definitions: [],
        descriptors: [],
        configPath: join(tmpDir, "collector.json"),
        configDir: tmpDir,
      },
    );
    await manager.applySourcesSnapshot([{ id: "unknown-feed:local", enabled: true }]);
    expect(engine.unhostedEntries()).toEqual([
      expect.objectContaining({
        sourceId: "unknown-feed:local",
        error: "the provider registered no instance for it",
      }),
    ]);
  });

  test.each([{}, { gatewayHosted: true }, { execution: "pull" as const, pushBased: true }])(
    "a host-driven source without a factory is still a failure: %j",
    async (execution) => {
      const { gateway } = createGateway();
      engine = new SyncEngine(gateway);
      const id = "missing-factory:local";
      // Deliberately malformed plugin: a pull declaration without its required factory.
      const definition = {
        type: "source",
        id: "missing-factory",
        name: "Missing factory",
        description: "Malformed fixture",
        authType: "local",
        ...execution,
      } as SourceOrProviderDefinition;
      const manager = new SourceManager(
        engine,
        gateway,
        {},
        {
          definitions: [definition],
          descriptors: [
            {
              ...descriptor("missing-factory"),
              provider: { id: ProviderType("missing-factory"), name: "Missing factory" },
              ...execution,
            },
          ],
          configPath: join(tmpDir, "collector.json"),
          configDir: tmpDir,
        },
      );
      await manager.applySourcesSnapshot([{ id, enabled: true }]);
      expect(engine.unhostedEntries()).toEqual([
        expect.objectContaining({
          sourceId: id,
          error: "the provider registered no instance for it",
        }),
      ]);
    },
  );

  test("is not reported as added, and the error names the cause", async () => {
    const gate = { contextError: "vault database is not readable by this host" };
    const { manager, upserted } = createManager(gate);

    await expect(
      manager.addSources({ descriptorId: NOTES, accountIds: [ACCOUNT] }),
    ).rejects.toThrow(/vault database is not readable by this host/);

    // The gateway row is live — that half of the add did land, and it is what
    // a later reconcile retries from.
    expect(upserted).toEqual([`${NOTES}:${ACCOUNT}`]);
    // Nothing registered, which is the whole point.
    expect(engine.getStatuses()).toEqual([]);
  });

  test("does not present as idle: the collector reports the failure upstream", async () => {
    const gate = { contextError: "vault database is not readable by this host" };
    const { manager } = createManager(gate);

    await expect(
      manager.addSources({ descriptorId: NOTES, accountIds: [ACCOUNT] }),
    ).rejects.toThrow();

    const reported = events.filter((e) => e.event === "sync.error");
    expect(reported.map((e) => e.sourceId)).toEqual([`${NOTES}:${ACCOUNT}`]);
    expect(reported[0].status.state).toBe("error");
    expect(reported[0].status.lastError).toMatch(/vault database is not readable by this host/);
  });

  test("reports the remedy beside the cause when the failure names one", async () => {
    const remediation: SyncRemediation = {
      summary: "Vault access is required",
      steps: ["Grant the collector access to the vault."],
      executable: "/opt/example/bin/node",
      restartRequired: true,
    };
    const gate = {
      contextError: "vault database is not readable by this host",
      contextRemediation: remediation,
    };
    const { manager } = createManager(gate);

    await expect(
      manager.addSources({ descriptorId: NOTES, accountIds: [ACCOUNT] }),
    ).rejects.toThrow();

    const reported = events.filter((e) => e.event === "sync.error");
    expect(reported).toHaveLength(1);
    expect(reported[0].status.lastError).toMatch(/vault database is not readable by this host/);
    expect(reported[0].status.remediation).toEqual(remediation);
  });

  test("reports no remedy when the failure carries none", async () => {
    const gate = { contextError: "vault database is not readable by this host" };
    const { manager } = createManager(gate);

    await expect(
      manager.addSources({ descriptorId: NOTES, accountIds: [ACCOUNT] }),
    ).rejects.toThrow();

    const reported = events.filter((e) => e.event === "sync.error");
    expect(reported).toHaveLength(1);
    expect(reported[0].status.remediation).toBeUndefined();
  });

  test("asking it to sync names the cause instead of claiming no source matches", async () => {
    const gate = { contextError: "vault database is not readable by this host" };
    const { manager } = createManager(gate);

    await expect(
      manager.addSources({ descriptorId: NOTES, accountIds: [ACCOUNT] }),
    ).rejects.toThrow();

    const result = engine.triggerSync(`${NOTES}:${ACCOUNT}`);
    expect(result.triggered).toEqual([]);
    expect(result.error).not.toMatch(/No sources match/);
    expect(result.error).toMatch(/vault database is not readable by this host/);
    expect(result.unhosted).toEqual([
      { sourceId: `${NOTES}:${ACCOUNT}`, error: expect.stringContaining("not readable") },
    ]);
  });

  test("the key is not latched: a later snapshot retries it and it comes up", async () => {
    const gate: { contextError?: string } = {
      contextError: "vault database is not readable by this host",
    };
    const { manager } = createManager(gate);

    await expect(
      manager.addSources({ descriptorId: NOTES, accountIds: [ACCOUNT] }),
    ).rejects.toThrow();
    expect(engine.getStatuses()).toEqual([]);

    // A snapshot arriving while the cause is still there must retry and fail
    // again — not decide the source is already registered and skip it forever.
    await manager.applySourcesSnapshot([{ id: `${NOTES}:${ACCOUNT}`, enabled: true }]);
    expect(engine.getStatuses()).toEqual([]);

    // The operator grants the permission; the next snapshot brings it up with
    // no re-add and no collector restart.
    gate.contextError = undefined;
    await manager.applySourcesSnapshot([{ id: `${NOTES}:${ACCOUNT}`, enabled: true }]);
    expect(engine.getStatuses().map((s) => s.sourceId)).toEqual([`${NOTES}:${ACCOUNT}`]);
    expect(engine.triggerSync(`${NOTES}:${ACCOUNT}`).triggered).toEqual([`${NOTES}:${ACCOUNT}`]);
  });

  test("removing the source forgets the failure: a later sync-all does not name it", async () => {
    const gate = { contextError: "vault database is not readable by this host" };
    const { manager } = createManager(gate);

    await expect(
      manager.addSources({ descriptorId: NOTES, accountIds: [ACCOUNT] }),
    ).rejects.toThrow();
    expect(engine.triggerSync("all").unhosted).toHaveLength(1);

    await manager.removeSources([`${NOTES}:${ACCOUNT}`]);

    const result = engine.triggerSync("all");
    expect(result.unhosted).toEqual([]);
    expect(result.error).toBe("No sources match: all");
  });

  test("a partially-failing provider still reports the sources that did instantiate", async () => {
    const gate = { sourceErrors: new Set([TASKS]) };
    const { manager } = createManager(gate);

    await expect(
      manager.addSources({ descriptorId: NOTES, accountIds: [ACCOUNT] }),
    ).resolves.toEqual({ sourceIds: [`${NOTES}:${ACCOUNT}`] });
    expect(engine.getStatuses().map((s) => s.sourceId)).toEqual([`${NOTES}:${ACCOUNT}`]);

    await expect(
      manager.addSources({ descriptorId: TASKS, accountIds: [ACCOUNT] }),
    ).rejects.toThrow(/vault-tasks cannot be opened/);
    // The sibling that came up first is untouched by its neighbour's failure.
    expect(engine.getStatuses().map((s) => s.sourceId)).toEqual([`${NOTES}:${ACCOUNT}`]);
  });

  test("one add covering two accounts keeps the one that built and names the one that did not", async () => {
    const gate = { accountErrors: new Set(["locked"]) };
    const { manager } = createManager(gate);

    await expect(
      manager.addSources({ descriptorId: NOTES, accountIds: [ACCOUNT, "locked"] }),
    ).rejects.toThrow(
      new RegExp(
        `Registered ${NOTES}:${ACCOUNT}, but rejected: \\[${NOTES}:locked\\].*locked is not readable`,
      ),
    );
    expect(engine.getStatuses().map((s) => s.sourceId)).toEqual([`${NOTES}:${ACCOUNT}`]);
    // The account that did build syncs; only the other one is reported unhosted.
    expect(engine.triggerSync("all").unhosted).toEqual([
      { sourceId: `${NOTES}:locked`, error: expect.stringContaining("locked is not readable") },
    ]);
  });

  test("a paused source in a snapshot is not diagnosed as a failed instantiation", async () => {
    const { manager } = createManager({});

    // A snapshot re-states every source the gateway holds for this device,
    // paused ones included, and a fresh collector has none of them latched.
    await manager.applySourcesSnapshot([{ id: `${NOTES}:${ACCOUNT}`, enabled: false }]);

    expect(events.filter((e) => e.event === "sync.error")).toEqual([]);
    expect(engine.triggerSync("all").unhosted).toEqual([]);
  });

  test("pausing a source that failed to instantiate stops it being reported", async () => {
    const gate: { contextError?: string } = { contextError: "vault database is not readable" };
    const { manager } = createManager(gate);

    await manager.applySourcesSnapshot([{ id: `${NOTES}:${ACCOUNT}`, enabled: true }]);
    expect(engine.triggerSync("all").unhosted).toHaveLength(1);

    await manager.applySourcesSnapshot([{ id: `${NOTES}:${ACCOUNT}`, enabled: false }]);
    expect(engine.triggerSync("all").unhosted).toEqual([]);
  });

  test("resuming a source whose cause is still there reports it again", async () => {
    const gate = { contextError: "vault database is not readable" };
    const { manager } = createManager(gate);

    await manager.applySourcesSnapshot([{ id: `${NOTES}:${ACCOUNT}`, enabled: true }]);
    expect(engine.triggerSync("all").unhosted).toHaveLength(1);

    // Paused, so it stops being reported...
    await manager.applySourcesSnapshot([{ id: `${NOTES}:${ACCOUNT}`, enabled: false }]);
    expect(engine.triggerSync("all").unhosted).toEqual([]);

    // ...and resumed, so it is diagnosed afresh rather than quietly returning
    // to a green dot on the strength of having been paused.
    await manager.applySourcesSnapshot([{ id: `${NOTES}:${ACCOUNT}`, enabled: true }]);
    expect(engine.triggerSync("all").error).toMatch(/is not running here: vault database/);
  });

  test("a snapshot that drops the source sweeps its failure record and its config", async () => {
    const gate = { contextError: "vault database is not readable" };
    const { manager } = createManager(gate);

    await manager.applySourcesSnapshot([{ id: `${NOTES}:${ACCOUNT}`, enabled: true }]);
    expect(engine.triggerSync("all").unhosted).toHaveLength(1);

    // The gateway reassigned the source to another device, so it is gone from
    // this device's snapshot. An un-latched key is invisible to the usual
    // removal diff, and this is what keeps it from outliving the source.
    await manager.applySourcesSnapshot([]);
    expect(engine.triggerSync("all").unhosted).toEqual([]);
    expect(manager.getConfig().sources?.[`${NOTES}:${ACCOUNT}`]).toBeUndefined();
  });
});
