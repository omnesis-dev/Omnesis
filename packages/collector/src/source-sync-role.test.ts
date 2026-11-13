// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { google } from "googleapis";
import { afterEach, expect, test, vi } from "vitest";
import googleProvider from "@omnesis/provider-google";
import { ProviderId, SourceId } from "@omnesis/types";
import { SyncEngine } from "./sync-engine.js";
import type { GoogleProvider } from "@omnesis/provider-google";
import type {
  GatewayClient,
  SourceInstance,
  SyncCursor,
  SyncOptions,
  SyncResult,
} from "@omnesis/source-sdk";
import type { MultiDeviceMode, SourceScopes } from "@omnesis/types";

const engines: SyncEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stopSyncLoopAndDrain()));
  vi.restoreAllMocks();
});

function recordingGateway(granted = true) {
  return {
    getSyncState: vi.fn(() => Promise.resolve(null)),
    getWipeEpoch: vi.fn(() => Promise.resolve(undefined)),
    setSourceMeta: vi.fn(() => Promise.resolve()),
    upsertWithCursor: vi.fn((page: Parameters<GatewayClient["upsertWithCursor"]>[0]) =>
      Promise.resolve({
        ingested: page.documents?.length ?? 0,
        reconciledDeleted: 0,
        indexCleanedRows: 0,
      }),
    ),
    claimSyncLease: vi.fn(() =>
      Promise.resolve({ granted, holder: granted ? undefined : "another-collector" }),
    ),
    releaseSyncLease: vi.fn(() => Promise.resolve(true)),
    supportsSourceScopes: vi.fn(() => Promise.resolve(true)),
    getScopeRefreshState: vi.fn(() =>
      Promise.resolve({ epochs: { folder: "previous-cut" }, requestIds: {} }),
    ),
  } satisfies Partial<GatewayClient>;
}

function register(
  gateway: ReturnType<typeof recordingGateway>,
  instance: SourceInstance,
  mode: MultiDeviceMode | undefined,
  identity = {
    sourceId: SourceId("example-source:owner"),
    providerId: ProviderId("example:owner"),
  },
  scopes?: SourceScopes,
) {
  const engine = new SyncEngine(gateway as unknown as GatewayClient, {
    scopeRefreshActorId: "registered-collector",
  });
  engines.push(engine);
  engine.registerProvider({
    id: identity.providerId,
    name: "Example provider",
    credentialState: () => Promise.resolve({ status: "connected" as const }),
    renewableCredential: true,
    sources: [
      {
        id: identity.sourceId,
        providerId: identity.providerId,
        name: "Example source",
        family: { name: "Example provider" },
        multiDeviceMode: mode,
        scopes,
        instance,
      },
    ],
  });
  return engine;
}

test.each([
  { mode: undefined, granted: true, role: undefined },
  { mode: "exclusive", granted: true, role: undefined },
  { mode: "partitioned", granted: true, role: undefined },
  { mode: "handoff", granted: true, role: "holder" },
  { mode: "replicated", granted: true, role: "holder" },
  { mode: "replicated", granted: false, role: "member" },
] as const)(
  "$mode source receives lease role $role when granted=$granted",
  async ({ mode, granted, role }) => {
    const gateway = recordingGateway(granted);
    const sync = vi.fn((_cursor: SyncCursor | null, _options?: SyncOptions) =>
      Promise.resolve({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
    );
    const engine = register(gateway, { sync }, mode);

    await engine.syncAll();

    expect(sync).toHaveBeenCalledTimes(1);
    const run = sync.mock.calls[0]![1]!.run;
    expect(run).toMatchObject({ id: expect.any(String), reason: "boot", page: 0 });
    if (role === undefined) {
      expect(run).not.toHaveProperty("role");
      expect(gateway.claimSyncLease).not.toHaveBeenCalled();
    } else {
      expect(run?.role).toBe(role);
      expect(gateway.claimSyncLease).toHaveBeenCalledTimes(1);
    }
    expect(gateway.upsertWithCursor).toHaveBeenCalledTimes(1);
    expect(engine.getStatuses()[0]!.state).toBe("idle");
  },
);

test("a handoff non-holder still skips the source before invoking its sync", async () => {
  const gateway = recordingGateway(false);
  const sync = vi.fn(() =>
    Promise.resolve({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
  );
  const engine = register(gateway, { sync }, "handoff");

  await engine.syncAll();

  expect(gateway.claimSyncLease).toHaveBeenCalledTimes(1);
  expect(sync).not.toHaveBeenCalled();
  expect(gateway.upsertWithCursor).not.toHaveBeenCalled();
  expect(engine.getStatuses()[0]!.state).toBe("idle");
});

test("an exclusive Drive from its exported factory publishes native folder refresh requests through the engine", async () => {
  const drive = {
    files: { list: vi.fn(() => Promise.resolve({ data: { files: [] } })) },
    changes: {
      getStartPageToken: vi.fn(() => Promise.resolve({ data: { startPageToken: "content-cut" } })),
    },
  };
  vi.spyOn(google, "drive").mockReturnValue(drive as unknown as ReturnType<typeof google.drive>);
  const accountId = "run-owner@example.org";
  const definition = googleProvider.sources.find((source) => source.id === "google-drive")!;
  const identity = {
    sourceId: SourceId(`google-drive:${accountId}`),
    providerId: ProviderId(`google:${accountId}`),
  };
  const instance = await definition.create!(
    {
      accountId,
      ...identity,
    },
    { accountId, auth: new google.auth.OAuth2(), provider: {} as GoogleProvider },
  );
  const gateway = recordingGateway();
  const engine = register(gateway, instance, "exclusive", identity, definition.scopes);

  await engine.syncAll();

  const pages = gateway.upsertWithCursor.mock.calls.map(([page]) => page);
  expect(pages).toHaveLength(2);
  expect(pages.every((page) => page.sourceId === identity.sourceId)).toBe(true);
  const requestId = pages[0]!.scopeUpdates?.refreshes?.[0]?.requestId;
  expect(requestId).toEqual(expect.any(String));
  expect(pages[0]!.scopeUpdates).toMatchObject({
    refreshes: [{ kind: "folder", active: true, epoch: "previous-cut", restart: true, requestId }],
    readiness: [{ kind: "folder", complete: false }],
  });
  expect(pages[1]!.scopeUpdates?.refreshes?.[0]?.requestId).toBe(requestId);
  expect(pages[0]!.cursor).toMatchObject({
    scopeFoldersStage: "awaiting",
    scopeFoldersActorId: "registered-collector",
  });
  expect(gateway.claimSyncLease).not.toHaveBeenCalled();
  expect(drive.files.list).not.toHaveBeenCalled();
  expect(drive.changes.getStartPageToken).not.toHaveBeenCalled();
  expect(engine.getStatuses()[0]!.state).toBe("idle");
});

test("a source that declares no scopes syncs without negotiating them", async () => {
  const gateway = recordingGateway();
  const sync = vi.fn((_cursor: SyncCursor | null, _options?: SyncOptions) =>
    Promise.resolve({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
  );
  const engine = register(gateway, { sync }, undefined);

  await engine.syncAll();

  expect(gateway.supportsSourceScopes).not.toHaveBeenCalled();
  expect(gateway.getScopeRefreshState).not.toHaveBeenCalled();
  const options = sync.mock.calls[0]![1]!;
  expect(options).not.toHaveProperty("scopeFactsSupported");
  expect(options).not.toHaveProperty("scopeRefreshEpochs");
  expect(engine.getStatuses()[0]!.state).toBe("idle");
});

test("a source that declares scopes negotiates them before every page", async () => {
  const gateway = recordingGateway();
  const sync = vi.fn((_cursor: SyncCursor | null, _options?: SyncOptions) =>
    Promise.resolve({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
  );
  const engine = register(gateway, { sync }, undefined, undefined, { items: [] });

  await engine.syncAll();

  expect(gateway.supportsSourceScopes.mock.calls).toEqual([[], [2]]);
  expect(gateway.getScopeRefreshState).toHaveBeenCalledTimes(1);
  expect(sync.mock.calls[0]![1]).toMatchObject({
    scopeFactsSupported: true,
    scopeHierarchySupported: true,
    scopeRefreshEpochs: { folder: "previous-cut" },
  });
});

test.each([
  {
    name: "the gateway probe fails",
    arrange: (gateway: ReturnType<typeof recordingGateway>) =>
      gateway.supportsSourceScopes.mockRejectedValue(new Error("fetch failed")),
  },
  {
    name: "the gateway advertises no source filters",
    arrange: (gateway: ReturnType<typeof recordingGateway>) =>
      gateway.supportsSourceScopes.mockResolvedValue(false),
  },
])("a scoped source syncs its page without filter facts when $name", async ({ arrange }) => {
  const gateway = recordingGateway();
  arrange(gateway);
  const sync = vi.fn((_cursor: SyncCursor | null, _options?: SyncOptions) =>
    Promise.resolve({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
  );
  const engine = register(gateway, { sync }, undefined, undefined, { items: [] });

  await engine.syncAll();

  // The page is fetched and committed as a collector without filters would:
  // no scope option reaches the source, and the sync does not end in error.
  expect(sync).toHaveBeenCalledTimes(1);
  const options = sync.mock.calls[0]![1]!;
  expect(options).not.toHaveProperty("scopeFactsSupported");
  expect(options).not.toHaveProperty("scopeHierarchySupported");
  expect(options).not.toHaveProperty("scopeRefreshEpochs");
  expect(gateway.getScopeRefreshState).not.toHaveBeenCalled();
  expect(gateway.upsertWithCursor).toHaveBeenCalledTimes(1);
  expect(engine.getStatuses()[0]!.state).toBe("idle");
});

test("a scoped source whose refresh state cannot be read still syncs, without refresh epochs", async () => {
  const gateway = recordingGateway();
  gateway.getScopeRefreshState.mockRejectedValue(new Error("fetch failed"));
  const sync = vi.fn((_cursor: SyncCursor | null, _options?: SyncOptions) =>
    Promise.resolve({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
  );
  const engine = register(gateway, { sync }, undefined, undefined, { items: [] });

  await engine.syncAll();

  const options = sync.mock.calls[0]![1]!;
  expect(options).toMatchObject({ scopeFactsSupported: true, scopeHierarchySupported: true });
  expect(options).not.toHaveProperty("scopeRefreshEpochs");
  expect(engine.getStatuses()[0]!.state).toBe("idle");
});

test.each([
  { name: "an empty scope envelope", scopeUpdates: { conversations: [] }, waits: true },
  { name: "no scope envelope", scopeUpdates: undefined, waits: true },
  {
    name: "scope readiness",
    scopeUpdates: { readiness: [{ kind: "label" as const, complete: false }] },
    waits: false,
  },
])(
  "a page with no documents and $name waits=$waits before the next page",
  async ({ scopeUpdates, waits }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const gateway = recordingGateway();
      const pages: SyncResult[] = [
        { documents: [], deletedExternalIds: [], cursor: {}, hasMore: true, scopeUpdates },
        { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false },
      ];
      const sync = vi.fn(() => Promise.resolve(pages.shift()!));
      const engine = register(gateway, { sync }, undefined, undefined, { items: [] });

      const run = engine.syncAll();
      await vi.advanceTimersByTimeAsync(1900);
      expect(sync).toHaveBeenCalledTimes(waits ? 1 : 2);
      await vi.advanceTimersByTimeAsync(200);
      await run;

      expect(sync).toHaveBeenCalledTimes(2);
      expect(engine.getStatuses()[0]!.state).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  },
);
