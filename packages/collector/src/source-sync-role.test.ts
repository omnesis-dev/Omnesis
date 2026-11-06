// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { google } from "googleapis";
import { afterEach, expect, test, vi } from "vitest";
import googleProvider from "@omnesis/provider-google";
import { ProviderId, SourceId } from "@omnesis/types";
import { SyncEngine } from "./sync-engine.js";
import type { GoogleProvider } from "@omnesis/provider-google";
import type { GatewayClient, SourceInstance, SyncCursor, SyncOptions } from "@omnesis/source-sdk";
import type { MultiDeviceMode } from "@omnesis/types";

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
  const engine = register(gateway, instance, "exclusive", identity);

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
