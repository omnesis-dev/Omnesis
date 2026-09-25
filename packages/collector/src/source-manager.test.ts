// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { defineSource } from "@omnesis/source-sdk";
import { ProviderId, SourceType, ProviderType } from "@omnesis/types";
import { SourceManager } from "./source-manager.js";
import type { SourceManagerOptions } from "./source-manager.js";
import type { SyncEngine, RegisteredSource, RegisteredProvider } from "./sync-engine.js";
import type { SourceConfig } from "@omnesis/core";
import type {
  DocumentEventProfile,
  GatewayClient,
  SourceDescriptor,
  SyncState,
  SyncCursor,
  SourceStats,
  IndexStats,
  SourceOrProviderDefinition,
} from "@omnesis/source-sdk";
import type { SourceId } from "@omnesis/types";
import type { CollectorInternalConfig } from "./internal-config.js";

/**
 * Seed the manager with sources the way the gateway would (via
 * sources.snapshot WS command). Replaces the deleted `setupInitialSources`
 * path — tests need a way to get sources registered in the engine without
 * going through addSources/OAuth plumbing.
 */
async function seedFromConfig(
  manager: SourceManager,
  config: CollectorInternalConfig,
): Promise<void> {
  const records = Object.entries(config.sources ?? {}).map(([id, cfg]) => {
    const colon = id.indexOf(":");
    return {
      id,
      type: colon >= 0 ? id.slice(0, colon) : id,
      accountId: colon >= 0 ? id.slice(colon + 1) : "local",
      config: cfg,
      enabled: cfg.enabled !== false,
    };
  });
  await manager.applySourcesSnapshot(records);
}

// ---------------------------------------------------------------------------
// Mock SyncEngine
// ---------------------------------------------------------------------------

interface MockEngineCall {
  method: string;
  args: unknown[];
}

function createMockEngine(): SyncEngine & { calls: MockEngineCall[]; statuses: any[] } {
  const calls: MockEngineCall[] = [];
  const statuses: any[] = [];

  return {
    calls,
    statuses,
    registerProvider(provider: RegisteredProvider) {
      calls.push({ method: "registerProvider", args: [provider] });
      for (const p of provider.sources) {
        statuses.push({
          sourceId: p.id,
          providerId: p.providerId,
          sourceName: p.name,
          state: "idle",
        });
      }
    },
    getStatuses() {
      return statuses;
    },
    triggerSync(pattern: string) {
      calls.push({ method: "triggerSync", args: [pattern] });
      return { triggered: [pattern], skipped: [] };
    },
    disableSource(id: string) {
      calls.push({ method: "disableSource", args: [id] });
      const s = statuses.find((s: any) => s.sourceId === id);
      if (s) s.state = "disabled";
    },
    enableSource(id: string, config?: any) {
      calls.push({ method: "enableSource", args: [id, config] });
      const s = statuses.find((s: any) => s.sourceId === id);
      if (s) s.state = "idle";
      return Promise.resolve(true);
    },
    unregisterSource(id: string) {
      calls.push({ method: "unregisterSource", args: [id] });
      const idx = statuses.findIndex((s: any) => s.sourceId === id);
      if (idx !== -1) statuses.splice(idx, 1);
    },
    async startSourceSyncLoops(sources: any[], config?: any) {
      calls.push({ method: "startSourceSyncLoops", args: [sources, config] });
    },
    getSourcesById(id: string) {
      calls.push({ method: "getSourcesById", args: [id] });
      // Return mock source instances for sources that exist in statuses
      const matching = statuses.filter((s: any) => s.sourceId === id);
      return matching.map((s: any) => ({
        id: s.sourceId,
        name: s.sourceName,
        providerId: s.providerId,
        instance: {
          sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
        },
      }));
    },
    updateSyncIntervals(config: CollectorInternalConfig) {
      calls.push({ method: "updateSyncIntervals", args: [config] });
    },
    onStatusChange() {},
    registerDisabledPlaceholder() {},
    markUnhosted(sourceId: string, providerId: string, error: string) {
      calls.push({ method: "markUnhosted", args: [sourceId, providerId, error] });
    },
    forgetUnhosted(sourceId: string) {
      calls.push({ method: "forgetUnhosted", args: [sourceId] });
    },
    unhostedEntries() {
      return [];
    },
  } as unknown as SyncEngine & { calls: MockEngineCall[]; statuses: any[] };
}

// ---------------------------------------------------------------------------
// Mock GatewayClient
// ---------------------------------------------------------------------------

function createMockGateway(): GatewayClient & {
  deletedSources: string[];
  deleteAllBySourceResult: number;
  bulkUpsertCalls: Array<
    Array<{
      id?: string;
      type: string;
      accountId: string;
      config?: Record<string, unknown>;
      memberConfig?: Record<string, unknown>;
      enabled?: boolean;
    }>
  >;
  knownUrlPatternsCalls: Array<Array<{ regex: string }>>;
  widgetRenderersCalls: Array<Array<{ kind: string; modulePath: string }>>;
  documentEventProfileCalls: Array<Array<{ sourceType: string; profile: DocumentEventProfile }>>;
} {
  const deletedSources: string[] = [];
  const bulkUpsertCalls: Array<
    Array<{
      id?: string;
      type: string;
      accountId: string;
      config?: Record<string, unknown>;
      memberConfig?: Record<string, unknown>;
      enabled?: boolean;
    }>
  > = [];
  const knownUrlPatternsCalls: Array<Array<{ regex: string }>> = [];
  const widgetRenderersCalls: Array<Array<{ kind: string; modulePath: string }>> = [];
  const documentEventProfileCalls: Array<
    Array<{ sourceType: string; profile: DocumentEventProfile }>
  > = [];
  return {
    deletedSources,
    bulkUpsertCalls,
    knownUrlPatternsCalls,
    widgetRenderersCalls,
    documentEventProfileCalls,
    async setKnownUrlPatterns(patterns: Array<{ regex: string }>) {
      knownUrlPatternsCalls.push(patterns);
    },
    async setWidgetRenderers(renderers: Array<{ kind: string; modulePath: string }>) {
      widgetRenderersCalls.push(renderers);
    },
    async setDocumentEventProfiles(
      entries: Array<{ sourceType: string; profile: DocumentEventProfile }>,
    ) {
      documentEventProfileCalls.push(entries);
    },
    deleteAllBySourceResult: 5,
    async upsertDocuments() {},
    async deleteDocuments() {},
    async reconcileSnapshot() {
      return 0;
    },
    async getDocumentCount() {
      return 0;
    },
    async getSyncState(): Promise<SyncState | null> {
      return null;
    },
    async setSyncState() {},
    async ping() {
      return true;
    },
    async getSourceStats(): Promise<SourceStats> {
      return {
        documentCount: 0,
        earliestSourceDate: null,
        latestSourceDate: null,
        totalUnitCount: null,
        dataSizeBytes: 0,
      };
    },
    async getDbSize() {
      return 0;
    },
    async getIndexStats(): Promise<IndexStats | null> {
      return null;
    },
    async listDocuments() {
      return { documents: [], hasMore: false };
    },
    async checkExistingExternalIds() {
      return [];
    },
    async deleteAllBySource(sourceId: SourceId) {
      deletedSources.push(sourceId);
      return (this as any).deleteAllBySourceResult;
    },
    async deleteAllByProvider() {
      return 0;
    },
    async listDocumentIds() {
      return [];
    },
    async getConfig() {
      return {};
    },
    async bulkUpsertSources(sources) {
      bulkUpsertCalls.push(sources);
      return {
        count: sources.length,
        sources: sources.map((s) => ({
          id: s.id ?? `${s.type}:${s.accountId}`,
          updated: false,
        })),
        errors: [],
      };
    },
  } as unknown as GatewayClient & {
    deletedSources: string[];
    deleteAllBySourceResult: number;
    bulkUpsertCalls: Array<
      Array<{
        id?: string;
        type: string;
        accountId: string;
        config?: Record<string, unknown>;
        memberConfig?: Record<string, unknown>;
        enabled?: boolean;
      }>
    >;
    knownUrlPatternsCalls: Array<Array<{ regex: string }>>;
    widgetRenderersCalls: Array<Array<{ kind: string; modulePath: string }>>;
    documentEventProfileCalls: Array<Array<{ sourceType: string; profile: DocumentEventProfile }>>;
  };
}

// ---------------------------------------------------------------------------
// Test definitions and descriptors
// ---------------------------------------------------------------------------

let cleanupCalls: string[] = [];
let cleanupContextCalls: Array<{ accountId: string; configDir?: string }> = [];

const testDescriptors: SourceDescriptor[] = [
  {
    id: SourceType("test-source"),
    name: "Test Source",
    description: "A test data source",
    provider: { id: ProviderType("test-provider"), name: "Test Provider" },
    authType: "local",
    cleanupCredentials: async (accountId: string, ctx) => {
      cleanupCalls.push(accountId);
      cleanupContextCalls.push({ accountId, configDir: ctx?.configDir });
    },
  },
  {
    id: SourceType("other-source"),
    name: "Other Source",
    description: "Another test source",
    provider: { id: ProviderType("other-provider"), name: "Other Provider" },
    authType: "local",
  },
  {
    id: SourceType("path-source"),
    name: "Path Source",
    description: "A path-input source (mirrors obsidian-notes)",
    provider: { id: ProviderType("path-provider"), name: "Path Provider" },
    authType: "local",
    params: [{ name: "vaultPath", label: "Vault path", type: "path", required: true }],
  },
  {
    id: SourceType("single-source"),
    name: "Synthetic singleton",
    description: "One account per collector",
    provider: { id: ProviderType("single-provider"), name: "Synthetic provider" },
    authType: "local",
    singleInstance: true,
  },
  // Two accounts of ONE source type — models two Gmail accounts on a single
  // collector. Teardown of one must never touch the other.
  {
    id: SourceType("multi-source"),
    name: "multi-source",
    description: "A source the user can add twice",
    provider: { id: ProviderType("multi-provider"), name: "multi-provider" },
    authType: "local",
    cleanupCredentials: async (accountId: string, ctx) => {
      cleanupCalls.push(`multi:${accountId}`);
      cleanupContextCalls.push({ accountId: `multi:${accountId}`, configDir: ctx?.configDir });
    },
  },
  // Sibling of `test-source` — same provider, different sourceType.
  // Models a multi-source provider like Notion (notion-pages + notion-databases
  // share `~/.config/omnesis/notion/<workspace>/`).
  {
    id: SourceType("test-source-sibling"),
    name: "Test Source Sibling",
    description: "Second source under the same provider",
    provider: { id: ProviderType("test-provider"), name: "Test Provider" },
    authType: "local",
    cleanupCredentials: async (accountId: string, ctx) => {
      cleanupCalls.push(`sibling:${accountId}`);
      cleanupContextCalls.push({ accountId: `sibling:${accountId}`, configDir: ctx?.configDir });
    },
  },
];

/** Params every `test-source` instance was created with, newest last. */
const testSourceCreations: Array<Record<string, unknown> | undefined> = [];

function createTestDefinitions(): SourceOrProviderDefinition[] {
  return [
    defineSource({
      id: "test-source",
      name: "Test Source",
      description: "A test data source",
      provider: { id: "test-provider", name: "Test Provider" },
      authType: "local",
      discover: async () => ["acct1"],
      create: async (options) => {
        testSourceCreations.push(
          (options.sourceConfig as { params?: Record<string, unknown> } | undefined)?.params,
        );
        return {
          sync: async () => ({
            documents: [],
            deletedExternalIds: [],
            cursor: {},
            hasMore: false,
          }),
        };
      },
    }),
    defineSource({
      id: "other-source",
      name: "Other Source",
      description: "Another test source",
      provider: { id: "other-provider", name: "Other Provider" },
      authType: "local",
      // A url-id pattern on a source that is NOT enabled/added in the test
      // config — `pushKnownUrlPatterns` must still surface it.
      urlPatterns: [{ regex: "other\\.example\\.com/([a-z0-9]+)", idGroup: 1 }],
      widgetRenderer: {
        kind: "other-widget",
        modulePath: "/providers/other/portal/widget.js",
      },
      // Declared on a source that is NOT added in the test config — the
      // gateway needs the full known set so a watch can be composed against a
      // source before the user has connected an account for it.
      documentEventProfile: {
        documentTypes: ["note"],
        personRoles: ["author"],
        metadataFields: [
          {
            path: "tags",
            type: "string-array",
            description: "Labels applied to the item.",
            canonicalValues: ["receipts"],
            valueAliases: { receipts: ["receipt"] },
          },
        ],
      },
      discover: async () => ["acct2"],
      create: async () => ({
        sync: async () => ({
          documents: [],
          deletedExternalIds: [],
          cursor: {},
          hasMore: false,
        }),
      }),
    }),
    // Path-input source — has params but no `discover`. Accounts come from
    // the user-supplied vaultPath, surfaced in the enabledSources key.
    // Models the real obsidian-notes / whatsapp-import shape.
    defineSource({
      id: "path-source",
      name: "Path Source",
      description: "A path-input source (mirrors obsidian-notes)",
      provider: { id: "path-provider", name: "Path Provider" },
      authType: "local",
      params: [{ name: "vaultPath", label: "Vault path", type: "path", required: true }],
      create: async () => ({
        sync: async () => ({
          documents: [],
          deletedExternalIds: [],
          cursor: {},
          hasMore: false,
        }),
      }),
    }),
    defineSource({
      id: "single-source",
      name: "Synthetic singleton",
      description: "One account per collector",
      provider: { id: "single-provider", name: "Synthetic provider" },
      authType: "local",
      singleInstance: true,
      discover: async () => ["account-a"],
      create: async () => ({
        sync: async () => ({
          documents: [],
          deletedExternalIds: [],
          cursor: {},
          hasMore: false,
        }),
      }),
    }),
    // Discovers TWO accounts, so both instances are live in the engine and a
    // teardown that over-matches on the source type is observable.
    defineSource({
      id: "multi-source",
      name: "multi-source",
      description: "A source the user can add twice",
      provider: { id: "multi-provider", name: "multi-provider" },
      authType: "local",
      discover: async () => ["acctA", "acctB"],
      create: async () => ({
        sync: async () => ({
          documents: [],
          deletedExternalIds: [],
          cursor: {},
          hasMore: false,
        }),
      }),
    }),
    defineSource({
      id: "test-source-sibling",
      name: "Test Source Sibling",
      description: "Second source under the same provider",
      provider: { id: "test-provider", name: "Test Provider" },
      authType: "local",
      discover: async () => ["acct1"],
      create: async () => ({
        sync: async () => ({
          documents: [],
          deletedExternalIds: [],
          cursor: {},
          hasMore: false,
        }),
      }),
    }),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SourceManager", () => {
  let engine: ReturnType<typeof createMockEngine>;
  let gateway: ReturnType<typeof createMockGateway>;
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    engine = createMockEngine();
    gateway = createMockGateway();
    tmpDir = mkdtempSync("/tmp/source-manager-test-");
    configPath = join(tmpDir, "collector.json");
    cleanupCalls = [];
    cleanupContextCalls = [];
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function createManager(
    config: CollectorInternalConfig = {},
    opts?: Partial<SourceManagerOptions>,
  ): SourceManager {
    return new SourceManager(engine, gateway, config, {
      definitions: createTestDefinitions(),
      descriptors: testDescriptors,
      configPath,
      configDir: tmpDir,
      ...opts,
    });
  }

  test("getConfig() returns initial config", () => {
    const config: CollectorInternalConfig = { defaultSyncInterval: "10m" };
    const manager = createManager(config);
    expect(manager.getConfig()).toBe(config);
  });

  test("getConfiguredSources() returns empty initially", () => {
    const manager = createManager({});
    expect(manager.getConfiguredSources()).toEqual({});
  });

  test("getConfiguredSources() returns sources from config", () => {
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": { enabled: true },
        "other-source:acct2": { enabled: false },
      },
    };
    const manager = createManager(config);
    const sources = manager.getConfiguredSources();
    expect(sources["test-source:acct1"].enabled).toBe(true);
    expect(sources["other-source:acct2"].enabled).toBe(false);
  });

  test("addSources() updates config with new sources", async () => {
    const manager = createManager({});

    const result = await manager.addSources({
      descriptorId: "test-source",
      accountIds: ["user1"],
    });

    expect(result.sourceIds).toEqual(["test-source:user1"]);
    const config = manager.getConfig();
    expect(config.sources?.["test-source:user1"]).toBeDefined();
    expect(config.sources?.["test-source:user1"].enabled).toBe(true);
  });

  test("addSources() refuses changed settings for an already hosted source", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "path-source:vault": { enabled: true, params: { vaultPath: "/tmp/alpha/vault" } },
      },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    await expect(
      manager.addSources({
        descriptorId: "path-source",
        accountIds: ["vault"],
        params: { vaultPath: "/tmp/beta/vault" },
      }),
    ).rejects.toThrow("already configured for /tmp/alpha/vault");
    expect(gateway.bulkUpsertCalls).toHaveLength(0);
    expect(manager.getConfiguredSources()["path-source:vault"].params?.vaultPath).toBe(
      "/tmp/alpha/vault",
    );
  });

  test("addSources() rejects a caller-supplied id that differs from the source's resolved id", async () => {
    const descriptors = testDescriptors.map((descriptor) =>
      String(descriptor.id) === "path-source"
        ? { ...descriptor, resolveAccountId: () => "resolved-vault" }
        : descriptor,
    );
    const manager = createManager({}, { descriptors });
    await expect(
      manager.resolveAccountId("path-source", { vaultPath: "/tmp/example-vault" }),
    ).resolves.toBe("resolved-vault");
    await expect(
      manager.addSources({
        descriptorId: "path-source",
        accountIds: ["wrong-vault"],
        params: { vaultPath: "/tmp/example-vault" },
      }),
    ).rejects.toThrow("resolve to account resolved-vault");
    expect(gateway.bulkUpsertCalls).toHaveLength(0);
  });

  test("addSources() cannot replace or resume a paused source through add", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "path-source:vault": { enabled: true, params: { vaultPath: "/tmp/alpha/vault" } },
      },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);
    await manager.disableSources(["path-source:vault"]);
    await expect(
      manager.addSources({
        descriptorId: "path-source",
        accountIds: ["vault"],
        params: { vaultPath: "/tmp/beta/vault" },
      }),
    ).rejects.toThrow("is paused");
    await expect(
      manager.addSources({ descriptorId: "path-source", accountIds: ["vault"] }),
    ).rejects.toThrow("is paused");
    expect(gateway.bulkUpsertCalls).toHaveLength(0);
    expect(manager.getConfiguredSources()["path-source:vault"]).toMatchObject({
      enabled: false,
      params: { vaultPath: "/tmp/alpha/vault" },
    });
  });

  test("a paused source assigned to another collector is not treated as local", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "path-source:vault": { enabled: false, params: { vaultPath: "/tmp/remote/vault" } },
      },
    };
    const pathDescriptor = testDescriptors.find(
      (descriptor) => String(descriptor.id) === "path-source",
    )!;
    const manager = createManager(config, {
      descriptors: [
        ...testDescriptors.filter((descriptor) => descriptor !== pathDescriptor),
        {
          ...pathDescriptor,
          resolveAccountId: (_params, existing) => (existing.length ? "wrong" : "new-vault"),
        },
      ],
    });
    await expect(
      manager.resolveAccountId("path-source", { vaultPath: "/tmp/new/vault" }),
    ).resolves.toBe("new-vault");
    await expect(
      manager.addSources({
        descriptorId: "path-source",
        accountIds: ["new-vault"],
        params: { vaultPath: "/tmp/new/vault" },
      }),
    ).resolves.toEqual({ sourceIds: ["path-source:new-vault"] });
  });

  test("an add during snapshot setup cannot replace the newly assigned source", async () => {
    let entered!: () => void;
    let release!: () => void;
    const settingUp = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const definitions = createTestDefinitions().filter(
      (definition) => definition.id !== "path-source",
    );
    definitions.push(
      defineSource({
        id: "path-source",
        name: "Path Source",
        description: "A path-input source",
        provider: { id: "path-provider", name: "Path Provider" },
        authType: "local",
        params: [{ name: "vaultPath", label: "Vault path", type: "path", required: true }],
        create: async () => {
          entered();
          await blocked;
          return {
            sync: async () => ({
              documents: [],
              deletedExternalIds: [],
              cursor: {},
              hasMore: false,
            }),
          };
        },
      }),
    );
    const descriptors = testDescriptors.map((descriptor) =>
      String(descriptor.id) === "path-source"
        ? {
            ...descriptor,
            resolveAccountId: (
              params: Record<string, string>,
              existing: readonly { accountId: string; params?: Record<string, string> }[],
            ) =>
              existing.find((entry) => entry.params?.vaultPath === params.vaultPath)?.accountId ??
              "vault",
          }
        : descriptor,
    );
    const manager = createManager({}, { definitions, descriptors });
    const snapshot = manager.applySourcesSnapshot([
      {
        id: "path-source:vault",
        type: "path-source",
        accountId: "vault",
        enabled: true,
        config: { enabled: true, params: { vaultPath: "/tmp/alpha/vault" } },
      },
    ]);
    await settingUp;
    await expect(
      manager.resolveAccountId("path-source", { vaultPath: "/tmp/alpha/vault" }),
    ).resolves.toBe("vault");
    await expect(
      manager.addSources({
        descriptorId: "path-source",
        accountIds: ["vault"],
        params: { vaultPath: "/tmp/beta/vault" },
      }),
    ).rejects.toThrow("already configured for /tmp/alpha/vault");
    expect(gateway.bulkUpsertCalls).toHaveLength(0);
    release();
    await snapshot;
  });

  test("a merge arriving during a full snapshot keeps only the new local identities", async () => {
    let entered!: () => void;
    let release!: () => void;
    const settingUp = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const definitions = createTestDefinitions().filter(
      (definition) => definition.id !== "path-source",
    );
    definitions.push(
      defineSource({
        id: "path-source",
        name: "Path Source",
        description: "A path-input source",
        provider: { id: "path-provider", name: "Path Provider" },
        authType: "local",
        params: [{ name: "vaultPath", label: "Vault path", type: "path", required: true }],
        create: async ({ accountId }) => {
          if (String(accountId) === "y") {
            entered();
            await blocked;
          }
          return {
            sync: async () => ({
              documents: [],
              deletedExternalIds: [],
              cursor: {},
              hasMore: false,
            }),
          };
        },
      }),
    );
    let observed: string[] = [];
    const descriptors = testDescriptors.map((descriptor) =>
      String(descriptor.id) === "path-source"
        ? {
            ...descriptor,
            resolveAccountId: (
              _params: Record<string, string>,
              existing: readonly { accountId: string }[],
            ) => {
              observed = existing.map((entry) => entry.accountId).sort();
              return "fresh";
            },
          }
        : descriptor,
    );
    const config: CollectorInternalConfig = {
      sources: { "path-source:x": { enabled: true, params: { vaultPath: "/tmp/x" } } },
    };
    const manager = createManager(config, { definitions, descriptors });
    await seedFromConfig(manager, config);
    const record = (accountId: string) => ({
      id: `path-source:${accountId}`,
      type: "path-source",
      accountId,
      enabled: true,
      config: { enabled: true, params: { vaultPath: `/tmp/${accountId}` } },
    });
    const full = manager.applySourcesSnapshot([record("y")]);
    await settingUp;
    const merge = manager.applySourcesSnapshot([record("z")], { merge: true });
    await manager.resolveAccountId("path-source", { vaultPath: "/tmp/fresh" });
    expect(observed).toEqual(["y", "z"]);
    release();
    await Promise.all([full, merge]);
    await manager.resolveAccountId("path-source", { vaultPath: "/tmp/fresh" });
    expect(observed).toEqual(["y", "z"]);
  });

  test("addSources() leaves an already hosted local source unchanged", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": {
          enabled: true,
          syncInterval: "15m",
          params: { folder: "/tmp/example" },
        },
      },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);
    await expect(
      manager.addSources({ descriptorId: "test-source", accountIds: ["acct1"] }),
    ).resolves.toEqual({ sourceIds: ["test-source:acct1"] });
    expect(gateway.bulkUpsertCalls).toHaveLength(0);
  });

  test("addSources() reserves an account while its gateway write is pending", async () => {
    const manager = createManager({});
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    (gateway as unknown as { bulkUpsertSources: unknown }).bulkUpsertSources = async () => {
      await waiting;
      return { count: 1, sources: [{ id: "test-source:acct1", updated: false }], errors: [] };
    };
    const first = manager.addSources({ descriptorId: "test-source", accountIds: ["acct1"] });
    await expect(
      manager.addSources({ descriptorId: "test-source", accountIds: ["acct1"] }),
    ).rejects.toThrow("already being added");
    release();
    await expect(first).resolves.toEqual({ sourceIds: ["test-source:acct1"] });
  });

  test("addSources() enforces a single-instance descriptor per collector host", async () => {
    const globalOnly = createManager({
      sources: { "single-source:account-a": { enabled: true } },
    });

    await expect(
      globalOnly.addSources({
        descriptorId: "single-source",
        accountIds: ["account-a", "account-b"],
      }),
    ).rejects.toThrow("choose exactly one account");
    expect(gateway.bulkUpsertCalls).toHaveLength(0);

    // The config mirror is gateway-wide: A alone does not mean this host owns
    // it, so a fresh host must still be able to add B.
    await expect(
      globalOnly.addSources({ descriptorId: "single-source", accountIds: ["account-b"] }),
    ).resolves.toEqual({ sourceIds: ["single-source:account-b"] });

    const localConfig: CollectorInternalConfig = {
      sources: { "single-source:account-a": { enabled: true } },
    };
    const local = createManager(localConfig);
    await seedFromConfig(local, localConfig);

    await expect(
      local.addSources({ descriptorId: "single-source", accountIds: ["account-b"] }),
    ).rejects.toThrow("single-source:account-a configured on this collector");
    expect(gateway.bulkUpsertCalls).toHaveLength(1);

    await expect(
      local.addSources({ descriptorId: "single-source", accountIds: ["account-a"] }),
    ).resolves.toEqual({ sourceIds: ["single-source:account-a"] });
  });

  test("addSources() reserves a single-instance slot before concurrent gateway work", async () => {
    const manager = createManager({});
    let releaseUpsert!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    (gateway as unknown as { bulkUpsertSources: unknown }).bulkUpsertSources = async (
      sources: Array<{ type: string; accountId: string }>,
    ) => {
      await blocked;
      return {
        count: sources.length,
        sources: sources.map((source) => ({
          id: `${source.type}:${source.accountId}`,
          updated: false,
        })),
        errors: [],
      };
    };

    const first = manager.addSources({ descriptorId: "single-source", accountIds: ["account-b"] });
    await expect(
      manager.addSources({ descriptorId: "single-source", accountIds: ["account-c"] }),
    ).rejects.toThrow("already being added on this collector");
    await expect(
      manager.addSources({ descriptorId: "single-source", accountIds: ["account-b"] }),
    ).rejects.toThrow("already being added on this collector");
    releaseUpsert();
    await expect(first).resolves.toEqual({ sourceIds: ["single-source:account-b"] });
  });

  test("addSources() counts a locally assigned unhosted instance against the host limit", async () => {
    engine.unhostedEntries = () => [
      {
        sourceId: "single-source:account-a",
        providerId: "single-provider",
        error: "synthetic setup failure",
      },
    ];
    const manager = createManager({
      sources: { "single-source:account-a": { enabled: true } },
    });

    await expect(
      manager.addSources({ descriptorId: "single-source", accountIds: ["account-b"] }),
    ).rejects.toThrow("single-source:account-a configured on this collector");
    expect(gateway.bulkUpsertCalls).toHaveLength(0);
  });

  test("a failed single-instance add releases only its own in-flight reservation", async () => {
    const manager = createManager({});
    let releaseUpsert!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    (gateway as unknown as { bulkUpsertSources: unknown }).bulkUpsertSources = async () => {
      await blocked;
      throw new Error("synthetic gateway failure");
    };

    const first = manager.addSources({ descriptorId: "single-source", accountIds: ["account-b"] });
    await expect(
      manager.addSources({ descriptorId: "single-source", accountIds: ["account-b"] }),
    ).rejects.toThrow("already being added on this collector");
    releaseUpsert();
    await expect(first).rejects.toThrow("synthetic gateway failure");

    (gateway as unknown as { bulkUpsertSources: unknown }).bulkUpsertSources = async (
      sources: Array<{ type: string; accountId: string }>,
    ) => ({
      count: sources.length,
      sources: sources.map((source) => ({
        id: `${source.type}:${source.accountId}`,
        updated: false,
      })),
      errors: [],
    });
    await expect(
      manager.addSources({ descriptorId: "single-source", accountIds: ["account-b"] }),
    ).resolves.toEqual({ sourceIds: ["single-source:account-b"] });
  });

  test("addSources() keeps its account intent when a racing snapshot records the source mode", async () => {
    // The gateway broadcasts the updated sources.snapshot over the device WS
    // the moment bulkUpsertSources lands — before addSources' HTTP await
    // resolves. If the snapshot reconciler sees the new key unmarked, it sets
    // the source up a second time: two live provider instances for one
    // account, which for a socket-holding provider means the two connections
    // mutually evict each other. The snapshot also records a multi-device mode;
    // that mutable state must not make post-auth discovery authoritative for
    // this still-running add. Simulate that ordering inside the mock upsert.
    let created = 0;
    const countingDefinitions: SourceOrProviderDefinition[] = [
      defineSource({
        id: "race-source",
        name: "Race Source",
        description: "Counts instantiations",
        provider: { id: "race-provider", name: "Race Provider" },
        authType: "local",
        discover: async () => ["previous-account"],
        params: [{ name: "p", label: "p", type: "string", required: false }],
        create: async () => {
          created++;
          return {
            sync: async () => ({
              documents: [],
              deletedExternalIds: [],
              cursor: {},
              hasMore: false,
            }),
          };
        },
      }),
    ];
    const manager = createManager(
      {},
      {
        definitions: countingDefinitions,
        descriptors: [
          ...testDescriptors,
          {
            id: SourceType("race-source"),
            name: "Race Source",
            description: "Counts instantiations",
            provider: { id: ProviderType("race-provider"), name: "Race Provider" },
            authType: "local",
          },
        ],
      },
    );

    (gateway as unknown as { bulkUpsertSources: unknown }).bulkUpsertSources = async (
      sources: Array<{ type: string; accountId: string }>,
    ) => {
      await manager.applySourcesSnapshot(
        sources.map((s) => ({
          id: `${s.type}:${s.accountId}`,
          type: s.type,
          accountId: s.accountId,
          enabled: true,
          multiDeviceMode: "replicated" as const,
        })),
      );
      return {
        count: sources.length,
        sources: sources.map((s) => ({ id: `${s.type}:${s.accountId}`, updated: false })),
        errors: [],
      };
    };

    await manager.addSources({
      descriptorId: "race-source",
      accountIds: ["acct1"],
    });

    expect(created).toBe(1);
  });

  test("a newer snapshot keeps its settings when an add response arrives", async () => {
    const manager = createManager({});
    (gateway as unknown as { bulkUpsertSources: unknown }).bulkUpsertSources = async () => {
      await manager.applySourcesSnapshot([
        {
          id: "test-source:acct1",
          type: "test-source",
          accountId: "acct1",
          enabled: true,
          config: { enabled: true, params: { folder: "/tmp/newer" } },
        },
      ]);
      return {
        count: 1,
        sources: [{ id: "test-source:acct1", updated: false }],
        errors: [],
      };
    };

    await manager.addSources({
      descriptorId: "test-source",
      accountIds: ["acct1"],
      params: { folder: "/tmp/older" },
    });
    expect(manager.getConfiguredSources()["test-source:acct1"]?.params).toEqual({
      folder: "/tmp/newer",
    });
    expect(testSourceCreations[testSourceCreations.length - 1]).toEqual({
      folder: "/tmp/newer",
    });
  });

  test("an add reports failure if setup with newer snapshot settings fails", async () => {
    const manager = createManager(
      {},
      {
        definitions: [
          defineSource({
            id: "test-source",
            name: "Test Source",
            description: "A test source",
            provider: { id: "test-provider", name: "Test Provider" },
            authType: "local",
            create: async (options) => {
              if ((options.sourceConfig as SourceConfig).params?.folder === "/tmp/newer") {
                throw new Error("new path unavailable");
              }
              return { sync: async () => ({ documents: [], cursor: {}, hasMore: false }) };
            },
          }),
        ],
      },
    );
    const record = (folder: string) => ({
      id: "test-source:acct1",
      type: "test-source",
      accountId: "acct1",
      enabled: true,
      config: { enabled: true, params: { folder } },
    });
    (gateway as unknown as { bulkUpsertSources: unknown }).bulkUpsertSources = async () => {
      await manager.applySourcesSnapshot([record("/tmp/older")]);
      await manager.applySourcesSnapshot([record("/tmp/newer")]);
      return {
        count: 1,
        sources: [{ id: "test-source:acct1", updated: false }],
        errors: [],
      };
    };

    await expect(
      manager.addSources({
        descriptorId: "test-source",
        accountIds: ["acct1"],
        params: { folder: "/tmp/older" },
      }),
    ).rejects.toThrow("new path unavailable");
  });

  test("a full snapshot removal prevents a pending add from restoring the source", async () => {
    const manager = createManager({});
    (gateway as unknown as { bulkUpsertSources: unknown }).bulkUpsertSources = async () => {
      await manager.applySourcesSnapshot([]);
      return {
        count: 1,
        sources: [{ id: "test-source:acct1", updated: false }],
        errors: [],
      };
    };

    await expect(
      manager.addSources({ descriptorId: "test-source", accountIds: ["acct1"] }),
    ).rejects.toThrow("Source assignment changed");
    expect(manager.getConfiguredSources()["test-source:acct1"]).toBeUndefined();
    expect(engine.getStatuses().some((entry) => entry.sourceId === "test-source:acct1")).toBe(
      false,
    );
  });

  test("an add finishing after a newer snapshot restores the newer provider settings", async () => {
    let entered!: () => void;
    let release!: () => void;
    const settingUp = new Promise<void>((resolve) => (entered = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const createdPaths: string[] = [];
    const manager = createManager(
      {},
      {
        definitions: [
          defineSource({
            id: "test-source",
            name: "Test Source",
            description: "A test source",
            provider: { id: "test-provider", name: "Test Provider" },
            authType: "local",
            create: async (options) => {
              const folder = (options.sourceConfig as SourceConfig).params?.folder ?? "";
              createdPaths.push(folder);
              if (folder === "/tmp/older") {
                entered();
                await blocked;
              }
              return { sync: async () => ({ documents: [], cursor: {}, hasMore: false }) };
            },
          }),
        ],
      },
    );
    const add = manager.addSources({
      descriptorId: "test-source",
      accountIds: ["acct1"],
      params: { folder: "/tmp/older" },
    });
    await settingUp;
    await manager.applySourcesSnapshot([
      {
        id: "test-source:acct1",
        type: "test-source",
        accountId: "acct1",
        enabled: true,
        config: { enabled: true, params: { folder: "/tmp/newer" } },
      },
    ]);
    release();
    await add;
    expect(manager.getConfiguredSources()["test-source:acct1"]?.params?.folder).toBe("/tmp/newer");
    expect(createdPaths.at(-1)).toBe("/tmp/newer");
  });

  test("addSources() registers new sources in the gateway `sources` table", async () => {
    // Regression: before this wire-up, sources added via `cli add` only
    // landed in the collector's local state + in-memory sync-status
    // registry. The portal filters out sources that appear in
    // /admin/sync/status but not in /admin/sources (as "orphan drift"),
    // so newly-added sources were invisible to it. addSources must
    // push a row to the gateway so the source shows up everywhere.
    const manager = createManager({});

    await manager.addSources({
      descriptorId: "test-source",
      accountIds: ["user1", "user2"],
    });

    expect(gateway.bulkUpsertCalls).toHaveLength(1);
    expect(gateway.bulkUpsertCalls[0]).toEqual([
      { type: "test-source", accountId: "user1", config: expect.any(Object), enabled: true },
      { type: "test-source", accountId: "user2", config: expect.any(Object), enabled: true },
    ]);
  });

  test.each([false, true])(
    "addSources() separates member params including advanced fields (advanced=%s)",
    async (advanced) => {
      const definitions: SourceOrProviderDefinition[] = [
        defineSource({
          id: "member-path-source",
          name: "Member-local path",
          description: "Exercises member-local source parameters",
          provider: { id: "member-path-provider", name: "Local fixture" },
          authType: "local",
          params: [
            { name: "sharedLabel", label: "Shared label", type: "string" },
            { name: "sessionsPath", label: "Sessions path", type: "path", scope: "member" },
          ],
          create: async () => ({
            sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
          }),
        }),
      ];
      const descriptors: SourceDescriptor[] = [
        {
          id: SourceType("member-path-source"),
          name: "Member-local path",
          description: "Exercises member-local source parameters",
          provider: { id: ProviderType("member-path-provider"), name: "Local fixture" },
          authType: "local",
          memberScopedParamNames: ["sessionsPath"],
          params: [
            { name: "sharedLabel", label: "Shared label", type: "string" },
            ...(!advanced
              ? [
                  {
                    name: "sessionsPath",
                    label: "Sessions path",
                    type: "path" as const,
                    scope: "member" as const,
                  },
                ]
              : []),
          ],
        },
      ];
      const manager = createManager({}, { definitions, descriptors });
      (gateway as unknown as { bulkUpsertSources: unknown }).bulkUpsertSources = async (
        sources: Array<{ type: string; accountId: string }>,
      ) => {
        gateway.bulkUpsertCalls.push(sources);
        return {
          count: sources.length,
          sources: sources.map((source) => ({
            id: `${source.type}:${source.accountId}`,
            updated: false,
            memberConfigApplied: true,
          })),
          errors: [],
        };
      };

      await manager.addSources({
        descriptorId: "member-path-source",
        accountIds: ["local"],
        params: {
          sharedLabel: "team",
          sessionsPath: "/srv/fictional-alpha/sessions",
        },
      });

      expect(gateway.bulkUpsertCalls).toEqual([
        [
          {
            type: "member-path-source",
            accountId: "local",
            config: {
              enabled: true,
              params: { sharedLabel: "team" },
              syncInterval: undefined,
            },
            memberConfig: {
              params: { sessionsPath: "/srv/fictional-alpha/sessions" },
            },
            enabled: true,
          },
        ],
      ]);
      expect(manager.getConfiguredSources()["member-path-source:local"]?.params).toEqual({
        sharedLabel: "team",
        sessionsPath: "/srv/fictional-alpha/sessions",
      });
    },
  );

  test("addSources() fails closed when a gateway does not acknowledge member config", async () => {
    const definitions: SourceOrProviderDefinition[] = [
      defineSource({
        id: "member-path-source",
        name: "Member-local path",
        description: "Exercises member-local source parameters",
        provider: { id: "member-path-provider", name: "Local fixture" },
        authType: "local",
        params: [{ name: "sessionsPath", label: "Sessions path", type: "path", scope: "member" }],
        create: async () => ({
          sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
        }),
      }),
    ];
    const descriptors: SourceDescriptor[] = [
      {
        id: SourceType("member-path-source"),
        name: "Member-local path",
        description: "Exercises member-local source parameters",
        provider: { id: ProviderType("member-path-provider"), name: "Local fixture" },
        authType: "local",
        params: [{ name: "sessionsPath", label: "Sessions path", type: "path", scope: "member" }],
      },
    ];
    const manager = createManager({}, { definitions, descriptors });

    await expect(
      manager.addSources({
        descriptorId: "member-path-source",
        accountIds: ["local"],
        params: { sessionsPath: "/srv/fictional-alpha/sessions" },
      }),
    ).rejects.toThrow(/member-local configuration/i);
    expect(manager.getConfiguredSources()).toEqual({});
  });

  test("addSources() re-registers sibling sources sharing the same provider account (regression for cli-add-reauth-doesnt-propagate-to-sibling-sources)", async () => {
    // Bug: when the user re-auths via `cli add <one-source>`, the
    // collector previously only re-registered THAT source — siblings of
    // the same provider stayed bound to their stale in-memory tokens
    // until a collector restart. Validation guide caught this live with
    // Google: revoking + re-running `cli add google-calendar` healed
    // calendar but left gmail/contacts/drive stuck.
    //
    // After the fix, addSources expands `enabledSources` to include any
    // already-configured siblings sharing the provider account, so
    // setupProviderDefinition re-creates ALL of their instances with
    // the freshly-loaded creds.
    //
    // We model this with `test-source` + `test-source-sibling`, both of
    // which share `test-provider`. The sibling is REGISTERED on this
    // collector (as a previously-set-up source is, via the boot snapshot)
    // — expansion only touches registered siblings, since the config
    // mirror is gateway-global and an unregistered key may belong to
    // another device.
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      {
        id: "test-source-sibling:acct1",
        type: "test-source-sibling",
        accountId: "acct1",
        enabled: true,
      },
    ]);
    engine.calls.length = 0;

    await manager.addSources({
      descriptorId: "test-source",
      accountIds: ["acct1"],
    });

    // The engine should have been called with registerProvider for BOTH
    // the new source AND the sibling — that's what re-creates the
    // sibling's source instance with fresh tokens. The engine merges
    // multiple calls under the same providerId (per sync-engine.ts:224)
    // so we just need both sources to appear across the registerProvider
    // calls; whether that's one combined call or two separate calls
    // doesn't matter functionally.
    const registerCalls = engine.calls.filter((c) => c.method === "registerProvider");
    const allRegisteredIds = registerCalls
      .flatMap((c) => (c.args[0] as RegisteredProvider).sources.map((s) => String(s.id)))
      .sort();
    expect(allRegisteredIds).toEqual(["test-source-sibling:acct1", "test-source:acct1"]);

    // Re-registering is not enough: the scheduler's timer closure pins the
    // pre-swap sibling instance, and a tick on it hits the stale-instance
    // fence and silently no-ops forever. The sibling's timer must be
    // re-armed with the new instance, exactly as reauthProvider does.
    const startCalls = engine.calls.filter((c) => c.method === "startSourceSyncLoops");
    const startedIds = [
      ...new Set(
        startCalls.flatMap((c) => (c.args[0] as Array<{ id: string }>).map((s) => String(s.id))),
      ),
    ].sort();
    expect(startedIds).toEqual(["test-source-sibling:acct1", "test-source:acct1"]);
  });

  test("addSources() does NOT pull in an unregistered sibling from the gateway-global config", async () => {
    // The config mirror names every source on every device. A
    // same-provider/same-account key this collector never registered is
    // usually hosted by another device — expanding it in would instantiate
    // a source this host doesn't own and race its cursor.
    const config: CollectorInternalConfig = {
      sources: {
        // In config (from the gateway-global mirror), never registered here.
        "test-source-sibling:acct1": { enabled: true },
      },
    };
    const manager = createManager(config);

    await manager.addSources({
      descriptorId: "test-source",
      accountIds: ["acct1"],
    });

    const registerCalls = engine.calls.filter((c) => c.method === "registerProvider");
    const allRegisteredIds = registerCalls.flatMap((c) =>
      (c.args[0] as RegisteredProvider).sources.map((s) => String(s.id)),
    );
    expect(allRegisteredIds).toEqual(["test-source:acct1"]);
  });

  test("addSources() does NOT pull in sources of a different provider (sibling expansion is provider-scoped)", async () => {
    // Defense check on the expansion logic: `other-source` is on
    // `other-provider`, so adding `test-source:acct1` must NOT pull
    // `other-source:acct1` into the registration.
    const config: CollectorInternalConfig = {
      sources: {
        "other-source:acct1": { enabled: true },
      },
    };
    const manager = createManager(config);

    await manager.addSources({
      descriptorId: "test-source",
      accountIds: ["acct1"],
    });

    // Only `test-source:acct1` should have been registered.
    const registerCalls = engine.calls.filter((c) => c.method === "registerProvider");
    expect(registerCalls).toHaveLength(1);
    const provider = registerCalls[0].args[0] as RegisteredProvider;
    const ids = provider.sources.map((s) => String(s.id));
    expect(ids).toEqual(["test-source:acct1"]);
  });

  test("addSources() does NOT pull in sources of a different account (sibling expansion is account-scoped)", async () => {
    // Same provider, different account — must NOT be expanded in.
    const config: CollectorInternalConfig = {
      sources: {
        "test-source-sibling:acct2": { enabled: true },
      },
    };
    const manager = createManager(config);

    await manager.addSources({
      descriptorId: "test-source",
      accountIds: ["acct1"],
    });

    // Should register `test-source:acct1` for `test-provider:acct1`.
    // Should NOT include `test-source-sibling:acct2` in the same call
    // since that's a different provider account.
    const registerCalls = engine.calls.filter((c) => c.method === "registerProvider");
    // We may see one call per provider:account pair. The acct1 call
    // should contain only the new source.
    const acct1Calls = registerCalls.filter((c) => {
      const p = c.args[0] as RegisteredProvider;
      return String(p.id) === "test-provider:acct1";
    });
    expect(acct1Calls).toHaveLength(1);
    const acct1Provider = acct1Calls[0].args[0] as RegisteredProvider;
    const acct1Ids = acct1Provider.sources.map((s) => String(s.id));
    expect(acct1Ids).toEqual(["test-source:acct1"]);
  });

  test("addSources() does NOT pull in disabled siblings (only re-registers enabled siblings)", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "test-source-sibling:acct1": { enabled: false },
      },
    };
    const manager = createManager(config);

    await manager.addSources({
      descriptorId: "test-source",
      accountIds: ["acct1"],
    });

    const registerCalls = engine.calls.filter((c) => c.method === "registerProvider");
    expect(registerCalls).toHaveLength(1);
    const provider = registerCalls[0].args[0] as RegisteredProvider;
    const ids = provider.sources.map((s) => String(s.id));
    // The disabled sibling stays disabled — not re-registered.
    expect(ids).toEqual(["test-source:acct1"]);
  });

  test("reauthProvider() re-registers every enabled source under (provider, account)", async () => {
    // The new `cli reauth <provider-id>` verb calls this method after the
    // OAuth subprocess has rotated tokens on disk. It must hand the full
    // sibling set to the engine so all of their stale in-memory token
    // references get replaced (gmail + calendar + contacts + drive all
    // share the same Google OAuth client — one re-auth heals all four).
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": { enabled: true },
        "test-source-sibling:acct1": { enabled: true },
      },
    };
    const manager = createManager(config);

    const result = await manager.reauthProvider("test-provider", "acct1");

    expect(result.sourceIds.sort()).toEqual(["test-source-sibling:acct1", "test-source:acct1"]);

    // Both siblings should reach engine.registerProvider so registerProvider's
    // re-registration path (sync-engine.ts:224) replaces their instances.
    const registerCalls = engine.calls.filter((c) => c.method === "registerProvider");
    const allRegisteredIds = registerCalls
      .flatMap((c) => (c.args[0] as RegisteredProvider).sources.map((s) => String(s.id)))
      .sort();
    expect(allRegisteredIds).toEqual(["test-source-sibling:acct1", "test-source:acct1"]);
  });

  test("reauthProvider() does NOT mutate config or call gateway.bulkUpsertSources", async () => {
    // Reauth is purely an in-memory refresh — no config writes, no gateway
    // upserts. That's the whole reason for the dedicated verb (vs. the
    // `cli add` flow which does all three).
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": { enabled: true, syncInterval: "5m" },
      },
    };
    const manager = createManager(config);
    const beforeJson = JSON.stringify(manager.getConfig());
    const upsertCallsBefore = gateway.bulkUpsertCalls.length;

    await manager.reauthProvider("test-provider", "acct1");

    expect(JSON.stringify(manager.getConfig())).toBe(beforeJson);
    expect(gateway.bulkUpsertCalls).toHaveLength(upsertCallsBefore);
    // No file should have been written either.
    expect(existsSync(configPath)).toBe(false);
  });

  test("reauthProvider() ignores siblings on a different account", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": { enabled: true },
        "test-source-sibling:acct2": { enabled: true },
      },
    };
    const manager = createManager(config);

    const result = await manager.reauthProvider("test-provider", "acct1");

    expect(result.sourceIds).toEqual(["test-source:acct1"]);
  });

  test("reauthProvider() ignores siblings on a different provider", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": { enabled: true },
        "other-source:acct1": { enabled: true },
      },
    };
    const manager = createManager(config);

    const result = await manager.reauthProvider("test-provider", "acct1");

    expect(result.sourceIds).toEqual(["test-source:acct1"]);
  });

  test("reauthProvider() ignores disabled siblings", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": { enabled: true },
        "test-source-sibling:acct1": { enabled: false },
      },
    };
    const manager = createManager(config);

    const result = await manager.reauthProvider("test-provider", "acct1");

    expect(result.sourceIds).toEqual(["test-source:acct1"]);
  });

  test("reauthProvider() fires startSourceSyncLoops on the refreshed sibling set", async () => {
    // Reauth must do more than swap in-memory source instances — it also has
    // to call startSourceSyncLoops so (a) the user gets an immediate sync on
    // the just-refreshed credentials instead of waiting for the next interval
    // tick, and (b) each per-source timer is rescheduled with a closure that
    // captures the NEW source ref. Without (b), the existing timer's closure
    // stays pinned to the old (revoked-token) source and the next scheduled
    // sync still fails with invalid_grant.
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": { enabled: true },
        "test-source-sibling:acct1": { enabled: true },
      },
    };
    const manager = createManager(config);

    await manager.reauthProvider("test-provider", "acct1");

    const startCalls = engine.calls.filter((c) => c.method === "startSourceSyncLoops");
    expect(startCalls).toHaveLength(1);
    const startedIds = (startCalls[0].args[0] as Array<{ id: string }>).map((s) => s.id).sort();
    expect(startedIds).toEqual(["test-source-sibling:acct1", "test-source:acct1"]);
  });

  test("reauthProvider() throws when no enabled source matches the (provider, account)", async () => {
    // Defensive — the CLI guards against this case before sending the
    // request, but if the gateway/collector get an orphan finalize call
    // (e.g. user revoked the source mid-flow) we want a clean 502, not a
    // silent no-op that the user can't tell apart from success.
    const manager = createManager({
      sources: {
        "test-source:acct2": { enabled: true },
      },
    });

    await expect(manager.reauthProvider("test-provider", "acct1")).rejects.toThrow(
      /No enabled sources match/,
    );
  });

  test("addSources() throws atomically when bulkUpsertSources fails — no half-registered local state", async () => {
    // Closes cli-add-not-atomic-leaves-source-half-registered. The
    // previous flow ran local setup first and only best-effort'd the
    // gateway upsert, leaving the user with on-disk creds + collector
    // config + no gateway row when the upsert failed. The cli treated
    // that as "already configured" on retry and forced another OAuth
    // dance.
    //
    // New contract: gateway-write happens FIRST. If it fails, no local
    // state is committed — the discover-based skip-OAuth path on retry
    // sees a clean slate and recovers without re-auth.
    (gateway as unknown as { bulkUpsertSources: () => Promise<never> }).bulkUpsertSources =
      async () => {
        throw new Error("gateway transient error");
      };
    const manager = createManager({});

    await expect(
      manager.addSources({
        descriptorId: "test-source",
        accountIds: ["user1"],
      }),
    ).rejects.toThrow(/gateway transient error/);

    // Atomicity: nothing should be in the in-memory mirror.
    expect(manager.getConfig().sources?.["test-source:user1"]).toBeUndefined();
  });

  test("addSources() throws when the gateway rejects an entry as hosted by another device", async () => {
    // The bulk-upsert HTTP call succeeds with per-entry results; a source
    // already hosted by another collector comes back as an error entry
    // rather than being silently adopted. The collector must treat
    // that as a failed registration — no local instance, no config mirror —
    // or it would sync a source this host doesn't own.
    (gateway as unknown as { bulkUpsertSources: unknown }).bulkUpsertSources = async () => ({
      count: 0,
      sources: [],
      errors: [
        {
          entry: { type: "test-source", accountId: "user1" },
          error: 'test-source:user1 is already hosted by device "other-collector"',
        },
      ],
    });
    const manager = createManager({});

    await expect(
      manager.addSources({
        descriptorId: "test-source",
        accountIds: ["user1"],
      }),
    ).rejects.toThrow(/already hosted by device/);

    // Nothing half-registered locally.
    expect(manager.getConfig().sources?.["test-source:user1"]).toBeUndefined();
    expect(engine.calls.some((c) => c.method === "registerProvider")).toBe(false);
  });

  test("addSources() commits accepted accounts and throws naming only the rejected ones", async () => {
    // Multi-account add where the gateway accepts one entry and rejects
    // another (hosted elsewhere). The accepted account has a live gateway
    // row, so it commits locally like any successful add; the rejected one
    // rolls back, and the thrown error names exactly the rejected keys.
    (gateway as unknown as { bulkUpsertSources: unknown }).bulkUpsertSources = async () => ({
      count: 1,
      sources: [{ id: "test-source:ok-account", updated: false }],
      errors: [
        {
          entry: { type: "test-source", accountId: "taken-account" },
          error: 'test-source:taken-account is already hosted by device "other-collector"',
        },
      ],
    });
    const manager = createManager({});

    await expect(
      manager.addSources({
        descriptorId: "test-source",
        accountIds: ["ok-account", "taken-account"],
      }),
    ).rejects.toThrow(/rejected: \[test-source:taken-account\]/);

    // Accepted account is fully committed; rejected one left no trace.
    expect(manager.getConfig().sources?.["test-source:ok-account"]).toBeDefined();
    expect(manager.getConfig().sources?.["test-source:taken-account"]).toBeUndefined();
    const registeredIds = engine.calls
      .filter((c) => c.method === "registerProvider")
      .flatMap((c) => (c.args[0] as RegisteredProvider).sources.map((s) => String(s.id)));
    expect(registeredIds).toContain("test-source:ok-account");
    expect(registeredIds).not.toContain("test-source:taken-account");
  });

  test("applySourcesSnapshot merge mode adds without unregistering the rest (source.added semantics)", async () => {
    // `source.added` carries ONE record; the collector merges it in.
    // Treating it as an authoritative snapshot would unregister every
    // other source this collector hosts.
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      { id: "multi-source:acctA", type: "multi-source", accountId: "acctA", enabled: true },
    ]);

    await manager.applySourcesSnapshot(
      [{ id: "multi-source:acctB", type: "multi-source", accountId: "acctB", enabled: true }],
      { merge: true },
    );

    const live = engine
      .getStatuses()
      .map((s: { sourceId: string }) => s.sourceId)
      .sort();
    expect(live).toEqual(["multi-source:acctA", "multi-source:acctB"]);
  });

  test("addSources() recovers idempotently after a transient gateway failure", async () => {
    // Simulate the user retry-flow: first add fails (gateway down), user
    // retries, second add succeeds. The collector must not have lingering
    // half-registered state from the first attempt that would confuse the
    // second.
    let upsertCalls = 0;
    let upsertShouldFail = true;
    (
      gateway as unknown as {
        bulkUpsertSources: (...args: unknown[]) => Promise<{ count: number }>;
      }
    ).bulkUpsertSources = async () => {
      upsertCalls++;
      if (upsertShouldFail) throw new Error("gateway transient error");
      return {
        count: 1,
        sources: [{ id: "test-source:user1", updated: false }],
        errors: [],
      };
    };
    const manager = createManager({});

    // First attempt: gateway down → throws.
    await expect(
      manager.addSources({
        descriptorId: "test-source",
        accountIds: ["user1"],
      }),
    ).rejects.toThrow();
    expect(upsertCalls).toBe(1);
    expect(manager.getConfig().sources?.["test-source:user1"]).toBeUndefined();

    // Gateway recovers, user retries.
    upsertShouldFail = false;
    const result = await manager.addSources({
      descriptorId: "test-source",
      accountIds: ["user1"],
    });

    expect(upsertCalls).toBe(2);
    expect(result.sourceIds).toEqual(["test-source:user1"]);
    expect(manager.getConfig().sources?.["test-source:user1"]?.enabled).toBe(true);
  });

  test("addSources() does NOT persist anything to disk (gateway owns config)", async () => {
    const manager = createManager({});

    await manager.addSources({
      descriptorId: "test-source",
      accountIds: ["user1"],
    });

    // In-memory mirror is updated for local diff tracking…
    expect(manager.getConfig().sources?.["test-source:user1"]?.enabled).toBe(true);
    // …and the file is never written — the gateway's config-store owns the
    // unified omnesis.json, and the collector is a pure consumer.
    expect(existsSync(configPath)).toBe(false);
  });

  test("disableSources() marks disabled in config", async () => {
    const config: CollectorInternalConfig = {
      sources: { "test-source:acct1": { enabled: true } },
    };
    const manager = createManager(config);
    // Set up initial sources so the engine has statuses
    await seedFromConfig(manager, config);

    await manager.disableSources(["test-source:acct1"]);

    const updatedConfig = manager.getConfig();
    expect(updatedConfig.sources?.["test-source:acct1"].enabled).toBe(false);
  });

  test("disableSources() updates in-memory config (nothing on disk)", async () => {
    const config: CollectorInternalConfig = {
      sources: { "test-source:acct1": { enabled: true } },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    await manager.disableSources(["test-source:acct1"]);

    expect(manager.getConfig().sources?.["test-source:acct1"].enabled).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  test("enableSources() re-enables disabled sources", async () => {
    const config: CollectorInternalConfig = {
      sources: { "test-source:acct1": { enabled: true } },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    // Disable first
    await manager.disableSources(["test-source:acct1"]);
    expect(manager.getConfig().sources?.["test-source:acct1"].enabled).toBe(false);

    // Re-enable
    await manager.enableSources(["test-source:acct1"]);
    expect(manager.getConfig().sources?.["test-source:acct1"].enabled).toBe(true);
  });

  test("removeSources() deletes data from gateway", async () => {
    const config: CollectorInternalConfig = {
      sources: { "test-source:acct1": { enabled: true } },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    const result = await manager.removeSources(["test-source:acct1"]);

    expect(result.deleted).toBeGreaterThanOrEqual(0);
    expect(gateway.deletedSources).toContain("test-source:acct1");
  });

  test("removeSources() stops the source BEFORE deleting its data", async () => {
    // Deleting a large source's data from the gateway takes tens of seconds.
    // For every one of them the source is still registered, the scheduler is
    // free to start a fresh sync, and that sync's pages land after the data is
    // gone — re-creating documents for a source that no longer exists, with
    // nothing left to reclaim them.
    //
    // Unregistering first collapses that window to the local teardown.
    const config: CollectorInternalConfig = {
      sources: { "test-source:acct1": { enabled: true } },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    // Capture what the engine had been told at the moment the remote delete ran.
    let engineCallsWhenDeleteRan: string[] = [];
    const realDelete = gateway.deleteAllBySource.bind(gateway);
    gateway.deleteAllBySource = async (sourceId: SourceId) => {
      engineCallsWhenDeleteRan = engine.calls.map((c: { method: string }) => c.method);
      return realDelete(sourceId);
    };

    await manager.removeSources(["test-source:acct1"]);

    expect(gateway.deletedSources).toContain("test-source:acct1");
    expect(engineCallsWhenDeleteRan).toContain("unregisterSource");
  });

  test("removeSources() calls cleanupCredentials on descriptor", async () => {
    const config: CollectorInternalConfig = {
      sources: { "test-source:acct1": { enabled: true } },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    await manager.removeSources(["test-source:acct1"]);

    expect(cleanupCalls).toContain("acct1");
    expect(cleanupContextCalls).toContainEqual({ accountId: "acct1", configDir: tmpDir });
  });

  test("removeSources() skips cleanupCredentials when a sibling source under the same provider+account remains", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": { enabled: true },
        "test-source-sibling:acct1": { enabled: true },
      },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    await manager.removeSources(["test-source:acct1"]);

    // Neither cleanup ran because the sibling still owns the same account dir.
    expect(cleanupCalls).toEqual([]);
    // Sibling stays in config.
    expect(manager.getConfig().sources?.["test-source-sibling:acct1"]).toBeDefined();
  });

  test("removeSources() runs cleanupCredentials when the last sibling under that account is removed", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": { enabled: true },
        "test-source-sibling:acct1": { enabled: true },
      },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    // Remove both in one call. The first iteration sees the second key still
    // in config and skips cleanup; the second iteration sees no siblings and
    // runs cleanup. Net: cleanup runs exactly once for the account.
    await manager.removeSources(["test-source:acct1", "test-source-sibling:acct1"]);

    // Exactly one cleanup call recorded — for the account, from whichever
    // descriptor's cleanup was invoked last.
    expect(cleanupCalls.length).toBe(1);
    expect(cleanupCalls[0]).toMatch(/acct1$/);
  });

  test("removeSources() runs cleanupCredentials when only a different-account sibling exists", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": { enabled: true },
        "test-source-sibling:acct2": { enabled: true },
      },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    await manager.removeSources(["test-source:acct1"]);

    // Different accountId — sibling does not protect acct1's creds.
    expect(cleanupCalls).toEqual(["acct1"]);
  });

  test("removeSources() runs cleanupCredentials when a same-account sibling is from a different provider", async () => {
    const config: CollectorInternalConfig = {
      sources: {
        "test-source:acct1": { enabled: true },
        // `other-source` is `other-provider`, not `test-provider`.
        "other-source:acct1": { enabled: true },
      },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    await manager.removeSources(["test-source:acct1"]);

    // Different provider — the cred dirs don't overlap.
    expect(cleanupCalls).toEqual(["acct1"]);
  });

  test("removeSources() removes source from in-memory config (gateway owns config file)", async () => {
    const config: CollectorInternalConfig = {
      sources: { "test-source:acct1": { enabled: true } },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    await manager.removeSources(["test-source:acct1"]);

    expect(manager.getConfig().sources?.["test-source:acct1"]).toBeUndefined();
    expect(existsSync(configPath)).toBe(false);
  });

  test("in-memory config tracks add → disable → enable across operations", async () => {
    const manager = createManager({});

    // Add a source
    await manager.addSources({
      descriptorId: "test-source",
      accountIds: ["user1"],
    });
    expect(manager.getConfig().sources?.["test-source:user1"].enabled).toBe(true);

    // Disable it
    await manager.disableSources(["test-source:user1"]);
    expect(manager.getConfig().sources?.["test-source:user1"].enabled).toBe(false);

    // Re-enable it
    await manager.enableSources(["test-source:user1"]);
    expect(manager.getConfig().sources?.["test-source:user1"].enabled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // applySourcesSnapshot — gateway-driven reconciliation
  // -------------------------------------------------------------------------

  test("applySourcesSnapshot adds new sources from gateway", async () => {
    // Account ID must match the descriptor's discover() return (acct1) so
    // doSetupSources actually instantiates the source instance.
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      { id: "test-source:acct1", type: "test-source", accountId: "acct1", enabled: true },
    ]);

    expect(manager.getConfig().sources?.["test-source:acct1"]).toBeDefined();
    expect(engine.calls.some((c) => c.method === "registerProvider")).toBe(true);
    expect(engine.calls.some((c) => c.method === "startSourceSyncLoops")).toBe(true);
  });

  test("the gateway-persisted mode overrides the descriptor through setup and re-instantiation", async () => {
    const definitions: SourceOrProviderDefinition[] = [
      defineSource({
        id: "mode-source",
        name: "mode-source",
        description: "Exercises the authoritative source-instance mode",
        provider: { id: "mode-provider", name: "mode-provider" },
        authType: "local",
        multiDevice: { mode: "exclusive" },
        discover: async () => ["local"],
        create: async () => ({
          sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
        }),
      }),
    ];
    const descriptors: SourceDescriptor[] = [
      {
        id: SourceType("mode-source"),
        name: "mode-source",
        description: "Exercises the authoritative source-instance mode",
        provider: { id: ProviderType("mode-provider"), name: "mode-provider" },
        authType: "local",
        multiDevice: { mode: "exclusive" },
      },
    ];
    const manager = createManager({}, { definitions, descriptors });

    await manager.applySourcesSnapshot([
      {
        id: "mode-source:local",
        type: "mode-source",
        accountId: "local",
        config: { enabled: true, params: { folder: "first" } },
        enabled: true,
        multiDeviceMode: "partitioned",
      },
    ]);

    const registeredModes = () =>
      engine.calls
        .filter((call) => call.method === "registerProvider")
        .flatMap((call) => (call.args[0] as RegisteredProvider).sources)
        .filter((source) => String(source.id) === "mode-source:local")
        .map((source) => source.multiDeviceMode);
    expect(registeredModes()).toEqual(["partitioned"]);

    await manager.applySourcesSnapshot([
      {
        id: "mode-source:local",
        type: "mode-source",
        accountId: "local",
        config: { enabled: true, params: { folder: "second" } },
        enabled: true,
        multiDeviceMode: "partitioned",
      },
    ]);
    expect(registeredModes()).toEqual(["partitioned", "partitioned"]);

    await manager.removeSources(["mode-source:local"]);
    await manager.applySourcesSnapshot([
      {
        id: "mode-source:local",
        type: "mode-source",
        accountId: "local",
        enabled: true,
      },
    ]);
    expect(registeredModes()).toEqual(["partitioned", "partitioned", "exclusive"]);
  });

  test("applySourcesSnapshot is idempotent — second call with same set is a no-op", async () => {
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      { id: "test-source:acct1", type: "test-source", accountId: "acct1", enabled: true },
    ]);
    const callsAfterFirst = engine.calls.length;

    await manager.applySourcesSnapshot([
      { id: "test-source:acct1", type: "test-source", accountId: "acct1", enabled: true },
    ]);

    // No additional engine actions for the unchanged source.
    expect(engine.calls.length).toBe(callsAfterFirst);
  });

  test("applySourcesSnapshot replaces a same-id source exactly once when its effective params change", async () => {
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      {
        id: "test-source:acct1",
        type: "test-source",
        accountId: "acct1",
        config: { enabled: true, params: { sessionsPath: "/srv/fictional-alpha/sessions" } },
        enabled: true,
      },
    ]);
    const registrationsBefore = engine.calls.filter(
      (call) => call.method === "registerProvider",
    ).length;
    const loopStartsBefore = engine.calls.filter(
      (call) => call.method === "startSourceSyncLoops",
    ).length;

    const changed = {
      id: "test-source:acct1",
      type: "test-source",
      accountId: "acct1",
      config: { enabled: true, params: { sessionsPath: "/srv/fictional-beta/sessions" } },
      enabled: true,
    };
    await manager.applySourcesSnapshot([changed]);

    expect(engine.calls.filter((call) => call.method === "registerProvider")).toHaveLength(
      registrationsBefore + 1,
    );
    expect(engine.calls.filter((call) => call.method === "startSourceSyncLoops")).toHaveLength(
      loopStartsBefore + 1,
    );
    expect(manager.getConfig().sources?.["test-source:acct1"]?.params?.sessionsPath).toBe(
      "/srv/fictional-beta/sessions",
    );
    expect(testSourceCreations[testSourceCreations.length - 1]).toMatchObject({
      sessionsPath: "/srv/fictional-beta/sessions",
    });

    await manager.applySourcesSnapshot([changed]);
    expect(engine.calls.filter((call) => call.method === "registerProvider")).toHaveLength(
      registrationsBefore + 1,
    );
    expect(engine.calls.filter((call) => call.method === "startSourceSyncLoops")).toHaveLength(
      loopStartsBefore + 1,
    );
  });

  test("applySourcesSnapshot unregisters sources that disappeared from the snapshot", async () => {
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      { id: "test-source:acct1", type: "test-source", accountId: "acct1", enabled: true },
    ]);

    // Empty snapshot — gateway no longer wants this source on us.
    await manager.applySourcesSnapshot([]);

    expect(manager.getConfig().sources?.["test-source:acct1"]).toBeUndefined();
    expect(engine.calls.some((c) => c.method === "unregisterSource")).toBe(true);
  });

  test("applySourcesSnapshot toggles disabled → enabled and back", async () => {
    const manager = createManager({});
    // Add via snapshot
    await manager.applySourcesSnapshot([
      { id: "test-source:acct1", type: "test-source", accountId: "acct1", enabled: true },
    ]);
    const before = engine.calls.length;

    // Toggle off
    await manager.applySourcesSnapshot([
      { id: "test-source:acct1", type: "test-source", accountId: "acct1", enabled: false },
    ]);
    expect(engine.calls.slice(before).some((c) => c.method === "disableSource")).toBe(true);
    expect(manager.getConfig().sources?.["test-source:acct1"].enabled).toBe(false);

    const afterDisable = engine.calls.length;
    // Toggle back on
    await manager.applySourcesSnapshot([
      { id: "test-source:acct1", type: "test-source", accountId: "acct1", enabled: true },
    ]);
    expect(engine.calls.slice(afterDisable).some((c) => c.method === "enableSource")).toBe(true);
    expect(manager.getConfig().sources?.["test-source:acct1"].enabled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Multi-account isolation — one account's teardown must not take its
  // siblings down. The reconciler used to match live instances with
  // `sourceId.startsWith("<type>:")`, so removing or pausing one account of a
  // source type unregistered every account of that type; the survivor stayed
  // in `config.sources` (so no later reconcile re-registered it) and silently
  // stopped syncing until the collector restarted.
  // -------------------------------------------------------------------------

  /** Live source ids the mock engine currently has registered. */
  function registeredIds(): string[] {
    return engine
      .getStatuses()
      .map((s: { sourceId: string }) => s.sourceId)
      .sort();
  }

  async function seedTwoAccounts(manager: SourceManager): Promise<void> {
    await manager.applySourcesSnapshot([
      { id: "multi-source:acctA", type: "multi-source", accountId: "acctA", enabled: true },
      { id: "multi-source:acctB", type: "multi-source", accountId: "acctB", enabled: true },
    ]);
  }

  test("applySourcesSnapshot removing one account leaves the sibling account registered", async () => {
    const manager = createManager({});
    await seedTwoAccounts(manager);
    expect(registeredIds()).toEqual(["multi-source:acctA", "multi-source:acctB"]);

    // Gateway drops only acctA.
    await manager.applySourcesSnapshot([
      { id: "multi-source:acctB", type: "multi-source", accountId: "acctB", enabled: true },
    ]);

    expect(registeredIds()).toEqual(["multi-source:acctB"]);
    expect(manager.getConfig().sources?.["multi-source:acctA"]).toBeUndefined();
    expect(manager.getConfig().sources?.["multi-source:acctB"]?.enabled).toBe(true);
  });

  test("applySourcesSnapshot disabling one account leaves the sibling account enabled", async () => {
    const manager = createManager({});
    await seedTwoAccounts(manager);
    const before = engine.calls.length;

    await manager.applySourcesSnapshot([
      { id: "multi-source:acctA", type: "multi-source", accountId: "acctA", enabled: false },
      { id: "multi-source:acctB", type: "multi-source", accountId: "acctB", enabled: true },
    ]);

    const disabled = engine.calls
      .slice(before)
      .filter((c) => c.method === "disableSource")
      .map((c) => c.args[0]);
    expect(disabled).toEqual(["multi-source:acctA"]);
    expect(manager.getConfig().sources?.["multi-source:acctB"]?.enabled).toBe(true);
  });

  test("removeSources on one account leaves the sibling account registered", async () => {
    const manager = createManager({});
    await seedTwoAccounts(manager);

    await manager.removeSources(["multi-source:acctA"]);

    expect(registeredIds()).toEqual(["multi-source:acctB"]);
    expect(manager.getConfig().sources?.["multi-source:acctB"]?.enabled).toBe(true);
  });

  test("a still-addressing bare key keeps an instance alive when its account key goes", async () => {
    // A bare `multi-source` key addresses every account under that type, so
    // dropping `multi-source:acctA` must not unregister the instance while the
    // bare key still enables it. This is the branch the teardown guards exist
    // for; without them the instance would be torn down while config still
    // claims it, and nothing would re-register it.
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      { id: "multi-source", type: "multi-source", accountId: "acctA", enabled: true },
      { id: "multi-source:acctA", type: "multi-source", accountId: "acctA", enabled: true },
    ]);
    const before = engine.calls.length;

    await manager.applySourcesSnapshot([
      { id: "multi-source", type: "multi-source", accountId: "acctA", enabled: true },
    ]);

    const unregistered = engine.calls
      .slice(before)
      .filter((c) => c.method === "unregisterSource")
      .map((c) => c.args[0]);
    expect(unregistered).not.toContain("multi-source:acctA");
    expect(registeredIds()).toContain("multi-source:acctA");
  });

  test("removeSources on one account cleans up only that account's credentials", async () => {
    const manager = createManager({});
    await seedTwoAccounts(manager);
    cleanupCalls.length = 0;

    await manager.removeSources(["multi-source:acctA"]);

    expect(cleanupCalls).toEqual(["multi:acctA"]);
  });

  test("path-input source (no discover) registers from enabled-sources key", async () => {
    // Regression: the obsidian-notes bug where a source with `params` but no
    // `discover()` was silently skipped because setupSourceDefinition bailed
    // on `accounts.length === 0`. Accounts now also derive from enabledSources
    // config keys matching `${def.id}:${accountId}`.
    const config: CollectorInternalConfig = {
      sources: {
        "path-source:MyVault": {
          enabled: true,
          params: { vaultPath: "/path/to/MyVault" },
        },
      },
    };
    const manager = createManager(config);
    await seedFromConfig(manager, config);

    const statuses = engine.getStatuses();
    const pathSourceStatus = statuses.find((s) => s.sourceId === "path-source:MyVault");
    expect(pathSourceStatus).toBeDefined();
  });

  test("applySourcesSnapshot does not call gateway.bulkUpsertSources", async () => {
    // Snapshot is FROM the gateway — pushing back would loop (even if idempotent).
    let bulkUpsertCalls = 0;
    (
      gateway as unknown as { bulkUpsertSources: () => Promise<{ count: number }> }
    ).bulkUpsertSources = async () => {
      bulkUpsertCalls++;
      return { count: 0 };
    };
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      { id: "test-source:acct1", type: "test-source", accountId: "acct1", enabled: true },
    ]);
    expect(bulkUpsertCalls).toBe(0);
  });

  // ---------------------------------------------------------------------
  // handleConfigChange — hot-reload of dataRetention + per-source maxAge
  // ---------------------------------------------------------------------

  test("handleConfigChange propagates dataRetention to this.config", async () => {
    const manager = createManager({ dataRetention: { maxAge: "1y" } });
    expect(manager.getConfig().dataRetention?.maxAge).toBe("1y");

    await manager.handleConfigChange({
      dataRetention: { maxAge: "30d" },
    });
    expect(manager.getConfig().dataRetention?.maxAge).toBe("30d");
  });

  test("handleConfigChange applies globals without overwriting snapshot-owned effective source config", async () => {
    const manager = createManager({ dataRetention: { maxAge: "1y" } });
    await manager.applySourcesSnapshot([
      {
        id: "test-source:acct1",
        type: "test-source",
        accountId: "acct1",
        config: {
          enabled: true,
          maxAge: "90d",
          params: { sessionsPath: "/srv/fictional-member/sessions" },
        },
        enabled: true,
      },
    ]);
    const registrationsBefore = engine.calls.filter(
      (call) => call.method === "registerProvider",
    ).length;

    await manager.handleConfigChange({
      dataRetention: { maxAge: "30d" },
      sources: {
        "test-source:acct1": {
          enabled: true,
          maxAge: "7d",
          params: { sessionsPath: "/srv/fictional-sibling/sessions" },
        },
      },
    });

    expect(manager.getConfig().dataRetention?.maxAge).toBe("30d");
    expect(manager.getConfig().sources?.["test-source:acct1"]).toMatchObject({
      enabled: true,
      maxAge: "90d",
      params: { sessionsPath: "/srv/fictional-member/sessions" },
    });
    expect(engine.calls.filter((call) => call.method === "registerProvider")).toHaveLength(
      registrationsBefore,
    );
    expect(
      engine.calls.filter((call) => call.method === "updateSyncIntervals").at(-1)?.args[0],
    ).toMatchObject({
      dataRetention: { maxAge: "30d" },
      sources: {
        "test-source:acct1": {
          maxAge: "90d",
          params: { sessionsPath: "/srv/fictional-member/sessions" },
        },
      },
    });
  });

  test("applySourcesSnapshot propagates per-source maxAge", async () => {
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      {
        id: "gmail:maya@example.com",
        type: "gmail",
        accountId: "maya@example.com",
        enabled: true,
        config: { enabled: true, maxAge: "30d" },
      },
    ]);
    expect(manager.getConfig().sources?.["gmail:maya@example.com"]?.maxAge).toBe("30d");
  });

  test("source.added regression: applySourcesSnapshot with a single new source instantiates it without restart", async () => {
    // Closes the bug where the gateway → collector `source.added` WS handler
    // was a literal NO-OP, so a source added via POST /admin/sources (portal /
    // iOS / cross-machine cli) never got instantiated until the collector
    // restarted. The fix is to forward the gateway-supplied SourceRecord
    // straight into applySourcesSnapshot. This test exercises the same
    // single-record entry point the handler uses — proving the reconciler
    // accepts a one-element snapshot, registers the source, and starts its
    // sync loop.
    const manager = createManager({});

    // Simulate the gateway's `source.added` payload: the SourceRecord shape
    // matches applySourcesSnapshot's `records` element shape one-for-one.
    const gatewaySourceRecord = {
      id: "test-source:acct1",
      type: "test-source",
      accountId: "acct1",
      config: { enabled: true },
      enabled: true,
    };

    await manager.applySourcesSnapshot([gatewaySourceRecord]);

    // The source should be registered in the engine and have a sync loop.
    expect(engine.calls.some((c) => c.method === "registerProvider")).toBe(true);
    expect(engine.calls.some((c) => c.method === "startSourceSyncLoops")).toBe(true);
    expect(manager.getConfig().sources?.["test-source:acct1"]).toBeDefined();
    expect(manager.getConfig().sources?.["test-source:acct1"].enabled).toBe(true);
  });

  test("applySourcesSnapshot re-instantiates a source whose params changed", async () => {
    // A source reads its params when it is created, so an edited param — a
    // repository allow-list, a watched directory — would sit inert until the
    // collector restarted. The recipient-specific snapshot has to
    // re-instantiate it.
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      {
        id: "test-source:acct1",
        type: "test-source",
        accountId: "acct1",
        config: { enabled: true, params: { repos: "acme/one" } },
        enabled: true,
      },
    ]);
    const before = engine.calls.filter((c) => c.method === "registerProvider").length;

    await manager.applySourcesSnapshot([
      {
        id: "test-source:acct1",
        type: "test-source",
        accountId: "acct1",
        config: { enabled: true, params: { repos: "acme/two" } },
        enabled: true,
      },
    ]);

    expect(engine.calls.filter((c) => c.method === "registerProvider").length).toBeGreaterThan(
      before,
    );
    expect(manager.getConfig().sources?.["test-source:acct1"]?.params?.repos).toBe("acme/two");
    // The crux: the re-created instance was built from the NEW params, and its
    // sync loop was restarted — a timer left pinned to the old instance would
    // keep syncing the previous repository list.
    expect(testSourceCreations[testSourceCreations.length - 1]).toMatchObject({
      repos: "acme/two",
    });
    expect(engine.calls.some((c) => c.method === "startSourceSyncLoops")).toBe(true);
  });

  test("applySourcesSnapshot leaves a source alone when its params only changed key order", async () => {
    // Config writes do not preserve key order, so comparing serialized params
    // directly would re-instantiate every source on every broadcast.
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      {
        id: "test-source:acct1",
        type: "test-source",
        accountId: "acct1",
        config: { enabled: true, params: { repos: "acme/one", excludeRepos: "acme/skip" } },
        enabled: true,
      },
    ]);
    const before = engine.calls.filter((c) => c.method === "registerProvider").length;

    await manager.applySourcesSnapshot([
      {
        id: "test-source:acct1",
        type: "test-source",
        accountId: "acct1",
        config: {
          enabled: true,
          params: { excludeRepos: "acme/skip", repos: "acme/one" },
        },
        enabled: true,
      },
    ]);

    expect(engine.calls.filter((c) => c.method === "registerProvider").length).toBe(before);
  });

  test("handleConfigChange never registers a source key it doesn't already host", async () => {
    // The config broadcast is gateway-global: it names every source on
    // every device. A key this collector hasn't registered is usually
    // another device's source, and registering it here would resurrect a
    // source this host no longer owns — both hosts then race one cursor.
    //The per-device WS commands (`source.added`,
    // `sources.snapshot`) are the only registration paths.
    const manager = createManager({});

    // Gateway pushes a config change mentioning a source this collector
    // has never registered (e.g. it is hosted by another collector).
    await manager.handleConfigChange({
      sources: {
        "test-source:acct1": { enabled: true },
      },
    });

    // Global source blocks are neither cached nor instantiated. The gateway
    // sends this collector's effective block through its addressed snapshot.
    expect(manager.getConfig().sources?.["test-source:acct1"]).toBeUndefined();
    expect(engine.calls.some((c) => c.method === "registerProvider")).toBe(false);
    expect(engine.calls.some((c) => c.method === "startSourceSyncLoops")).toBe(false);
  });

  test("handleConfigChange does NOT re-forward already-registered sources to applySourcesSnapshot", async () => {
    // A config refresh carrying only already-registered keys must not
    // trigger redundant engine calls.
    const manager = createManager({});

    // First: register the source via the snapshot path.
    await manager.applySourcesSnapshot([
      { id: "test-source:acct1", type: "test-source", accountId: "acct1", enabled: true },
    ]);
    const callsAfterFirstRegister = engine.calls.filter(
      (c) => c.method === "registerProvider",
    ).length;

    // Then: a config change carrying ONLY the same key must not trigger
    // any registration (no extra registerProvider calls).
    await manager.handleConfigChange({
      sources: {
        "test-source:acct1": { enabled: true, maxAge: "30d" },
      },
    });

    const callsAfterConfigChange = engine.calls.filter(
      (c) => c.method === "registerProvider",
    ).length;
    expect(callsAfterConfigChange).toBe(callsAfterFirstRegister);
    // The global source block may be another member's effective config and
    // therefore must not overwrite the snapshot-owned local block.
    expect(manager.getConfig().sources?.["test-source:acct1"]?.maxAge).toBeUndefined();
  });

  test("handleConfigChange preserves the existing enabled flag", async () => {
    // Simulate a prior applySourcesSnapshot that disabled a source — the
    // gateway-WS path is the source of truth for enablement, so a
    // toLegacyConfig roundtrip (which always sets enabled: true) must not
    // re-enable it.
    const manager = createManager({});
    await manager.applySourcesSnapshot([
      {
        id: "test-source:acct1",
        type: "test-source",
        accountId: "acct1",
        enabled: false,
      },
    ]);
    expect(manager.getConfig().sources?.["test-source:acct1"]?.enabled).toBe(false);

    // Config change arrives carrying the same source with enabled: true
    // (toLegacyConfig always normalises to true). Existing disabled state
    // wins.
    await manager.handleConfigChange({
      sources: {
        "test-source:acct1": { enabled: true, maxAge: "30d" },
      },
    });
    const after = manager.getConfig().sources?.["test-source:acct1"];
    expect(after?.enabled).toBe(false);
    expect(after?.maxAge).toBeUndefined();
  });

  test("pushKnownUrlPatterns() surfaces patterns from every definition, even unadded sources", async () => {
    // Empty config — no source is added. The push must still collect the
    // url-id pattern declared on `other-source`'s definition, because the
    // gateway's link-extraction keep-gate needs the FULL known set, not just
    // the added sources (otherwise a link to a not-yet-added source is
    // dropped permanently).
    const manager = createManager({});
    await manager.pushKnownUrlPatterns();

    expect(gateway.knownUrlPatternsCalls).toHaveLength(1);
    const pushed = gateway.knownUrlPatternsCalls[0];
    expect(pushed).toContainEqual({ regex: "other\\.example\\.com/([a-z0-9]+)" });
  });

  test("pushDocumentEventProfiles() surfaces profiles from every definition, even unadded sources", async () => {
    // Empty config — no source is added. The gateway still needs the full
    // known set: a watch is composed against a source type, and the compiler
    // must be able to describe one the user hasn't connected an account for.
    const manager = createManager({});
    await manager.pushDocumentEventProfiles();

    expect(gateway.documentEventProfileCalls).toHaveLength(1);
    const pushed = gateway.documentEventProfileCalls[0];
    expect(pushed).toEqual([
      {
        sourceType: "other-source",
        profile: {
          documentTypes: ["note"],
          personRoles: ["author"],
          metadataFields: [
            {
              path: "tags",
              type: "string-array",
              description: "Labels applied to the item.",
              canonicalValues: ["receipts"],
              valueAliases: { receipts: ["receipt"] },
            },
          ],
        },
      },
    ]);
  });

  test("pushWidgetRenderers() surfaces renderer modules from every definition, even unadded sources", async () => {
    const manager = createManager({});
    await manager.pushWidgetRenderers();

    expect(gateway.widgetRenderersCalls).toHaveLength(1);
    expect(gateway.widgetRenderersCalls[0]).toContainEqual({
      kind: "other-widget",
      modulePath: "/providers/other/portal/widget.js",
    });
  });
});
