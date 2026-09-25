// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { afterEach, describe, expect, test, vi } from "vitest";
import { AccountId, DeviceId, ProviderId, SourceId, SourceType, type Scope } from "@omnesis/types";
import { RowKeyError } from "@omnesis/source-sdk";
import {
  beginSyncAttempt,
  createDatabase,
  getDocumentCount,
  getSyncState,
  getWipeEpoch,
  upsertWithCursor,
} from "../../db.js";
import {
  createDevice,
  listDevices,
  updateDeviceCapabilities,
} from "../../data/repositories/DeviceRepository.js";
import {
  createSource,
  removeSourceMember,
  addSourceMember,
  getSourceForMember,
  getSourceMemberConfigOverride,
  getSource,
  listSourceMembers,
  listSources,
  setSourceMemberConfigOverride,
} from "../../data/repositories/SourceRepository.js";
import {
  listSyncStates,
  setSourceMeta,
  setSyncState,
} from "../../data/repositories/SyncStateRepository.js";
import {
  enqueueSourceStreamCleanup,
  completeSourceStreamCleanup,
  listPendingSourceStreamCleanups,
} from "../../data/repositories/SourceStreamCleanupRepository.js";
import {
  getSourceModeTransition,
  prepareSourceModeTransition,
  recordSourceModeTransitionFailure,
} from "../../data/repositories/SourceModeTransitionRepository.js";
import { getSourceMemberConfigContract } from "../../data/repositories/SourceMemberConfigContractRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { reconcileConfig } from "../../config-reconcile.js";
import { SyncLeaseRegistry } from "../../sync-lease.js";
import { SyncStatusRegistry } from "../../sync-status.js";
import { SourceWriteEpochFence, epochScope } from "../../source-write-epoch-fence.js";
import {
  recordDeletionClaims,
  recordPresenceClaims,
} from "../../data/repositories/ReplicaDeletionClaimRepository.js";
import { SourceDataRemovalService } from "./SourceDataRemovalService.js";
import { SourceService } from "./SourceService.js";
import type { AnalyticsDb } from "../../analytics-db.js";
import type { IndexWriteGate } from "../../indexer/index-write-gate.js";
import type { StatusCache } from "./StatusCache.js";
import type { DeviceWsServer } from "../../ws.js";
import type { WriteGate } from "../../write-gate.js";

const databases: ReturnType<typeof createDatabase>[] = [];
const services: SourceService[] = [];
afterEach(() => {
  services.splice(0).forEach((service) => service.dispose());
  databases.splice(0).forEach((db) => db.close());
});

const REPLICATED = SourceType("notes-synth");
const EXCLUSIVE = SourceType("mail-synth");
const HANDOFF = SourceType("calendar-synth");
const PARTITIONED = SourceType("visits-synth");
/** A replicated type a phone's kind hosts itself (`DEVICE_HOSTED_SOURCE_TYPES.ios`). */
const PHONE_REPLICATED = SourceType("photos");

/**
 * Membership under the multi-device modes. `notes-synth` is announced as
 * `replicated` by the collectors that host it; `mail-synth` carries no mode
 * and stays `exclusive`. Every add path — the admin endpoint, the
 * collector's bulk-upsert and a push device's first ingest — joins a
 * replicated source and refuses an exclusive one.
 */
function fixture(
  opts: {
    beforeMove?: () => Promise<void>;
    beforeRemoveMember?: () => Promise<void>;
    beforeUpdateMemberConfig?: () => Promise<void>;
    beforeAddSourceMember?: () => Promise<void>;
    beforePrepareModeTransition?: (sourceId: SourceId) => Promise<void>;
    modeAdoption?: (sourceId: SourceId, ownerDeviceId: string) => Promise<void>;
    prepareSourceRemoval?: (sourceId: string, streamId?: string) => Promise<void>;
    sourceWriteEpochFence?: SourceWriteEpochFence;
  } = {},
) {
  const db = createDatabase(":memory:");
  databases.push(db);
  const modes = {
    [REPLICATED]: "replicated" as const,
    [HANDOFF]: "handoff" as const,
    [PARTITIONED]: "partitioned" as const,
    [PHONE_REPLICATED]: "replicated" as const,
  };
  const types = [REPLICATED, EXCLUSIVE, HANDOFF, PARTITIONED, PHONE_REPLICATED];
  const alpha = createDevice(db, {
    name: "collector-alpha",
    kind: "collector",
    capabilities: {
      hostableSourceTypes: types,
      multiDeviceModes: modes,
      memberScopedParams: {
        [REPLICATED]: [],
        [EXCLUSIVE]: [],
        [HANDOFF]: [],
        [PARTITIONED]: ["sessionsPath"],
        [PHONE_REPLICATED]: [],
      },
      syncLease: true,
    },
  });
  const beta = createDevice(db, {
    name: "collector-beta",
    kind: "collector",
    capabilities: {
      hostableSourceTypes: types,
      multiDeviceModes: modes,
      memberScopedParams: {
        [REPLICATED]: [],
        [EXCLUSIVE]: [],
        [HANDOFF]: [],
        [PARTITIONED]: ["sessionsPath"],
        [PHONE_REPLICATED]: [],
      },
      syncLease: true,
    },
  });
  /** A collector that predates the lease contract. */
  const legacy = createDevice(db, {
    name: "collector-legacy",
    kind: "collector",
    capabilities: {
      hostableSourceTypes: types,
      multiDeviceModes: modes,
      memberScopedParams: {
        [REPLICATED]: [],
        [EXCLUSIVE]: [],
        [HANDOFF]: [],
        [PARTITIONED]: ["sessionsPath"],
        [PHONE_REPLICATED]: [],
      },
    },
  });
  /** A collector predating member-local configuration negotiation. */
  const preMemberConfig = createDevice(db, {
    name: "collector-pre-member-config",
    kind: "collector",
    capabilities: { hostableSourceTypes: types, multiDeviceModes: modes, syncLease: true },
  });
  const phone = createDevice(db, {
    name: "phone-a1b2c3",
    kind: "ios",
    capabilities: {
      hostableSourceTypes: [PHONE_REPLICATED],
      pushBasedSourceTypes: [PHONE_REPLICATED],
      multiDeviceModes: { [PHONE_REPLICATED]: "replicated" },
      syncLease: true,
    },
  });
  /** Devices the fake WS server reports online; every device by default. */
  const offline = new Set<string>();
  const isOnline = (id: string) => !offline.has(id);
  let now = 1_000_000;
  const lease = new SyncLeaseRegistry({ ttlMs: () => 60_000, isOnline, now: () => now });
  const tick = (ms: number) => (now += ms);
  const sendCommand = vi.fn(async () => ({ ok: true }));
  const notifySourceChange = vi.fn();
  const bump = vi.fn();
  const statusCache = {
    bump,
    get listSources() {
      return listSources(db);
    },
    get listSyncStates() {
      return listSyncStates(db);
    },
  } as unknown as StatusCache;
  const baseWriteGate = directWriteGate(db);
  const writeGate = {
    ...baseWriteGate,
    ...(opts.beforeMove
      ? {
          moveSource: async (...args: Parameters<WriteGate["moveSource"]>) => {
            await opts.beforeMove!();
            return baseWriteGate.moveSource(...args);
          },
        }
      : {}),
    ...(opts.beforeRemoveMember
      ? {
          removeSourceMember: async (...args: Parameters<WriteGate["removeSourceMember"]>) => {
            await opts.beforeRemoveMember!();
            return baseWriteGate.removeSourceMember(...args);
          },
        }
      : {}),
    ...(opts.beforeUpdateMemberConfig || opts.beforeAddSourceMember
      ? {
          addSourceMember: async (...args: Parameters<WriteGate["addSourceMember"]>) => {
            await opts.beforeAddSourceMember?.();
            if (args[2] !== undefined) await opts.beforeUpdateMemberConfig?.();
            return baseWriteGate.addSourceMember(...args);
          },
          updateSourceMemberConfigOverride: async (
            ...args: Parameters<WriteGate["updateSourceMemberConfigOverride"]>
          ) => {
            await opts.beforeUpdateMemberConfig?.();
            return baseWriteGate.updateSourceMemberConfigOverride(...args);
          },
        }
      : {}),
    ...(opts.beforePrepareModeTransition
      ? {
          prepareSourceModeTransition: async (
            sourceId: SourceId,
            toMode: Parameters<WriteGate["prepareSourceModeTransition"]>[1],
            expectedOwnerDeviceId: Parameters<WriteGate["prepareSourceModeTransition"]>[2],
            memberScopedParams: Parameters<WriteGate["prepareSourceModeTransition"]>[3],
          ) => {
            await opts.beforePrepareModeTransition!(sourceId);
            return baseWriteGate.prepareSourceModeTransition(
              sourceId,
              toMode,
              expectedOwnerDeviceId,
              memberScopedParams,
            );
          },
        }
      : {}),
  } satisfies WriteGate;
  const syncStatus = new SyncStatusRegistry();
  const syncSourceSettingsToConfig = vi.fn(async () => {});
  /** The stores outside SQLite a stream removal reaches, as spies. */
  const deleteAnalyticsStream = vi.fn(async (_sourceId: string, _streamId: string) => []);
  const forgetAbsenceObserver = vi.fn(async (_sourceId: string, _deviceId?: string) => {});
  const deleteChunksByDocuments = vi.fn(async (ids: readonly string[]) => ids.length);
  const service = new SourceService({
    db,
    writeGate,
    statusCache,
    wsServer: { sendCommand, isConnected: isOnline } as unknown as DeviceWsServer,
    sourceDataRemoval: new SourceDataRemovalService({
      db,
      writeGate,
      analyticsDb: {
        prepareSourceRemoval: opts.prepareSourceRemoval ?? (async () => {}),
        deleteAnalyticsStream,
        forgetAbsenceObserver,
      } as unknown as AnalyticsDb,
      indexWriteGate: { deleteChunksByDocuments } as unknown as IndexWriteGate,
      purgeAnnotationsFor: async () => {},
    }),
    ...(opts.modeAdoption
      ? {
          sourceModeTransitionAdoption: {
            adoptExclusiveToPartitioned: opts.modeAdoption,
          },
        }
      : {}),
    listDevices: () => listDevices(db),
    syncLease: lease,
    sourceWriteEpochFence: opts.sourceWriteEpochFence,
    syncStatus,
    notifySourceChange,
    syncSourceSettingsToConfig,
  });
  services.push(service);
  const seed = (type: SourceType, owner = alpha) =>
    createSource(db, {
      type,
      accountId: AccountId("shared"),
      deviceId: owner.id,
      multiDeviceMode: modes[type] ?? "exclusive",
    });
  /** One page of a device's stream on a partitioned source, under the row's current claim unless one is given. */
  const streamPage = (
    sourceId: SourceId,
    streamId: string,
    externalIds: string[],
    wipeEpoch = getWipeEpoch(db, sourceId, streamId),
  ) =>
    upsertWithCursor(db, {
      providerId: "visits-synth",
      sourceId,
      documents: externalIds.map((externalId) => ({
        providerId: ProviderId("visits-synth"),
        sourceId,
        externalId,
        title: externalId,
        content: `${streamId} ${externalId}`,
        contentHash: `${streamId}-${externalId}`,
        metadata: {},
        sourceCreatedAt: "2026-01-01T00:00:00Z",
        sourceUpdatedAt: "2026-01-01T00:00:00Z",
      })),
      hasMore: false,
      cursor: { page: 1 },
      cursorDeviceId: streamId,
      streamId,
      wipeEpoch,
    });
  const streamIds = (sourceId: SourceId): string[] =>
    db
      .prepare<[string], { stream_id: string }>(
        "SELECT DISTINCT stream_id FROM documents WHERE source_id = ? ORDER BY stream_id",
      )
      .all(sourceId)
      .map((r) => r.stream_id);
  return {
    db,
    alpha,
    beta,
    legacy,
    preMemberConfig,
    phone,
    service,
    sendCommand,
    notifySourceChange,
    bump,
    seed,
    lease,
    offline,
    tick,
    syncStatus,
    syncSourceSettingsToConfig,
    deleteAnalyticsStream,
    forgetAbsenceObserver,
    deleteChunksByDocuments,
    streamPage,
    streamIds,
  };
}

/** Raw membership, sorted: joins that land in the same millisecond have no defined order. */
const memberIds = (db: ReturnType<typeof createDatabase>, id: SourceId) =>
  listSourceMembers(db, id)
    .map((m) => m.deviceId)
    .sort();
const sorted = (ids: string[]) => [...ids].sort();

describe("SourceService membership", () => {
  test("admin create refuses member-local params in shared config", async () => {
    const { alpha, service } = fixture();

    await expect(
      service.createSource({
        type: PARTITIONED,
        accountId: AccountId("admin-shared-path"),
        deviceId: alpha.id,
        config: {
          params: { sessionsPath: "/srv/fictional-owner/sessions" },
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: "MEMBER_PARAM_IN_SHARED_CONFIG" });
  });

  test("admin PATCH refuses shared member params and sends recipient-specific safe updates", async () => {
    const { db, alpha, beta, service, notifySourceChange } = fixture();
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("admin-config-update"),
      deviceId: alpha.id,
      multiDeviceMode: "partitioned",
      config: { params: { sharedLabel: "fictional-team" } },
    });
    setSourceMemberConfigOverride(db, source.id, alpha.id, {
      params: { sessionsPath: "/srv/fictional-owner/sessions" },
    });
    await service.joinSource(source.id, beta.id);
    notifySourceChange.mockClear();

    await expect(
      service.updateSource(source.id, {
        config: {
          params: {
            sharedLabel: "fictional-updated-team",
            sessionsPath: "/srv/fictional-owner/sessions",
          },
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: "MEMBER_PARAM_IN_SHARED_CONFIG" });
    expect(notifySourceChange).not.toHaveBeenCalled();

    await service.updateSource(source.id, {
      config: { params: { sharedLabel: "fictional-updated-team" } },
    });
    expect(notifySourceChange).toHaveBeenCalledWith("source.updated", alpha.id, {
      source: expect.objectContaining({
        config: {
          params: {
            sharedLabel: "fictional-updated-team",
            sessionsPath: "/srv/fictional-owner/sessions",
          },
        },
      }),
    });
    expect(notifySourceChange).toHaveBeenCalledWith("source.updated", beta.id, {
      source: expect.objectContaining({
        config: { params: { sharedLabel: "fictional-updated-team" } },
      }),
    });
  });

  test("bulk reconciliation mirrors the persisted config when the announcement omits it", async () => {
    const { db, alpha, service, syncSourceSettingsToConfig } = fixture();
    const source = createSource(db, {
      type: EXCLUSIVE,
      accountId: AccountId("persisted-config"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
      config: { syncInterval: "5m", params: { sharedLabel: "fictional-team" } },
    });

    const result = await service.bulkUpsertForDevice(alpha.id, [
      { type: EXCLUSIVE, accountId: "persisted-config" },
    ]);

    expect(result.errors).toEqual([]);
    expect(syncSourceSettingsToConfig).toHaveBeenCalledWith(source.id, source.config);
  });

  test("a legacy collector may update its null-contract exclusive source before an upgrade pins the transition contract", async () => {
    const { db, preMemberConfig, service } = fixture({
      modeAdoption: () => Promise.resolve(),
    });
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("legacy-exclusive-upgrade"),
      deviceId: preMemberConfig.id,
      multiDeviceMode: "exclusive",
    });

    const legacyUpdate = await service.bulkUpsertForDevice(preMemberConfig.id, [
      {
        type: PARTITIONED,
        accountId: source.accountId,
        config: { syncInterval: "10m" },
      },
    ]);
    expect(legacyUpdate.errors).toEqual([]);
    expect(getSource(db, source.id)?.config).toEqual({ syncInterval: "10m" });

    updateDeviceCapabilities(db, preMemberConfig.id, {
      hostableSourceTypes: [PARTITIONED],
      multiDeviceModes: { [PARTITIONED]: "partitioned" },
      memberScopedParams: { [PARTITIONED]: ["sessionsPath"] },
      syncLease: true,
    });
    await expect(
      service.updateSource(source.id, { multiDeviceMode: "partitioned" }),
    ).resolves.toMatchObject({ multiDeviceMode: "partitioned" });
    expect(getSourceMemberConfigContract(db, source.id)).toEqual(["sessionsPath"]);
  });

  test("a partitioned source rejects a collector whose member-param contract differs", async () => {
    const { db, alpha, service } = fixture();
    const mismatched = createDevice(db, {
      name: "collector-mismatched",
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [PARTITIONED],
        multiDeviceModes: { [PARTITIONED]: "partitioned" },
        memberScopedParams: { [PARTITIONED]: [] },
        syncLease: true,
      },
    });

    const created = await service.bulkUpsertForDevice(alpha.id, [
      {
        type: PARTITIONED,
        accountId: "contract",
        config: { syncInterval: "5m" },
        memberConfig: { params: { sessionsPath: "/srv/fictional-alpha/sessions" } },
      },
    ]);
    const sourceId = SourceId(`${PARTITIONED}:contract`);
    expect(created.sources).toEqual([{ id: sourceId, updated: false, memberConfigApplied: true }]);

    const joined = await service.bulkUpsertForDevice(mismatched.id, [
      {
        type: PARTITIONED,
        accountId: "contract",
        config: {
          syncInterval: "5m",
          params: { sessionsPath: "/srv/fictional-mismatched/sessions" },
        },
      },
    ]);

    expect(joined.sources).toEqual([]);
    expect(joined.errors[0]?.error).toMatch(/member-local configuration contract/i);
    expect(memberIds(db, sourceId)).toEqual([alpha.id]);
    expect(getSource(db, sourceId)?.config).toEqual({ syncInterval: "5m" });
  });

  test("an additive member upgrade retains cursor access and private notifications without config authority", async () => {
    const { db, alpha, beta, service, notifySourceChange } = fixture();
    const source = await service.createSource({
      type: PARTITIONED,
      accountId: AccountId("additive-contract"),
      deviceId: alpha.id,
    });
    await service.joinSource(source.id, beta.id);
    for (const [member, folder] of [
      [alpha, "/fixture/owner"],
      [beta, "/fixture/sibling"],
    ] as const) {
      setSourceMemberConfigOverride(db, source.id, member.id, {
        params: { sessionsPath: folder },
      });
    }
    updateDeviceCapabilities(db, beta.id, {
      ...beta.capabilities,
      memberScopedParams: { [PARTITIONED]: ["cachePath", "sessionsPath"] },
    });

    expect(service.cursorRowFor(source.id, { deviceId: beta.id })).toBe(beta.id);
    await expect(
      service.updateMemberConfig(source.id, beta.id, { params: { cachePath: "/fixture/cache" } }),
    ).rejects.toMatchObject({ status: 409, code: "MEMBER_CONFIG_CONTRACT_MISMATCH" });
    notifySourceChange.mockClear();
    await service.updateSource(source.id, { enabled: false });
    expect(notifySourceChange).toHaveBeenCalledWith("source.updated", beta.id, {
      source: expect.objectContaining({
        enabled: false,
        config: { params: { sessionsPath: "/fixture/sibling" } },
      }),
    });
    expect(getSourceMemberConfigContract(db, source.id)).toEqual(["sessionsPath"]);
    expect(getSourceMemberConfigOverride(db, source.id, alpha.id)).toEqual({
      params: { sessionsPath: "/fixture/owner" },
    });
  });

  test.each([
    { label: "an empty declaration", memberScopedParams: [] },
    { label: "a different parameter", memberScopedParams: ["differentPath"] },
  ])(
    "an already-joined member is fenced after advertising $label",
    async ({ memberScopedParams }) => {
      const { db, alpha, beta, service, notifySourceChange } = fixture();
      const source = await service.createSource({
        type: PARTITIONED,
        accountId: AccountId(`joined-contract-${memberScopedParams.length}`),
        deviceId: alpha.id,
      });
      await service.joinSource(source.id, beta.id);

      updateDeviceCapabilities(db, beta.id, {
        hostableSourceTypes: [PARTITIONED],
        multiDeviceModes: { [PARTITIONED]: "partitioned" },
        memberScopedParams: { [PARTITIONED]: memberScopedParams },
        syncLease: true,
      });

      expect(() => service.cursorRowFor(source.id, { deviceId: beta.id })).toThrowError(
        expect.objectContaining({ status: 409, code: "MEMBER_CONFIG_CONTRACT_MISMATCH" }),
      );

      notifySourceChange.mockClear();
      await service.updateSource(source.id, { enabled: false });
      expect(notifySourceChange).toHaveBeenCalledWith(
        "source.updated",
        alpha.id,
        expect.anything(),
      );
      expect(notifySourceChange.mock.calls.some(([, deviceId]) => deviceId === beta.id)).toBe(
        false,
      );
    },
  );

  test("a lifecycle update excludes a joined member that lost persisted lease support", async () => {
    const { db, alpha, beta, service, notifySourceChange } = fixture();
    const source = await service.createSource({
      type: REPLICATED,
      accountId: AccountId("downgraded-lifecycle-member"),
      deviceId: alpha.id,
    });
    await service.joinSource(source.id, beta.id);
    updateDeviceCapabilities(db, beta.id, {
      hostableSourceTypes: [REPLICATED],
      multiDeviceModes: { [REPLICATED]: "replicated" },
      memberScopedParams: { [REPLICATED]: [] },
      syncLease: false,
    });
    notifySourceChange.mockClear();

    await service.updateSource(source.id, { enabled: false });

    expect(notifySourceChange).toHaveBeenCalledWith("source.updated", alpha.id, expect.anything());
    expect(notifySourceChange.mock.calls.some(([, deviceId]) => deviceId === beta.id)).toBe(false);
  });

  test("a completed exclusive-to-partitioned transition fences an owner that later downgrades", async () => {
    const { db, alpha, service } = fixture({ modeAdoption: () => Promise.resolve() });
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("completed-transition-contract"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
    });
    await service.updateSource(source.id, { multiDeviceMode: "partitioned" });

    updateDeviceCapabilities(db, alpha.id, {
      hostableSourceTypes: [PARTITIONED],
      multiDeviceModes: { [PARTITIONED]: "partitioned" },
      memberScopedParams: { [PARTITIONED]: [] },
      syncLease: true,
    });

    expect(() => service.cursorRowFor(source.id, { deviceId: alpha.id })).toThrowError(
      expect.objectContaining({ status: 409, code: "MEMBER_CONFIG_CONTRACT_MISMATCH" }),
    );
  });

  test("exclusive to replicated adopts cursor authority without re-keying analytics", async () => {
    const modeAdoption = vi.fn(async () => {});
    const { db, alpha, service } = fixture({ modeAdoption });
    updateDeviceCapabilities(db, alpha.id, {
      ...alpha.capabilities,
      replicaVersionPolicies: { [REPLICATED]: "source-updated-at" },
    });
    const source = createSource(db, {
      type: REPLICATED,
      accountId: AccountId("legacy-replica"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
    });

    const transitioned = await service.updateSource(source.id, {
      multiDeviceMode: "replicated",
    });

    expect(transitioned?.multiDeviceMode).toBe("replicated");
    expect(getSource(db, source.id)?.replicaVersionPolicy).toBe("source-updated-at");
    expect(modeAdoption).not.toHaveBeenCalled();

    updateDeviceCapabilities(db, alpha.id, {
      ...alpha.capabilities,
      replicaVersionPolicies: {},
    });
    expect(() => service.replicaVersionPolicy(source.id)).toThrowError(
      expect.objectContaining({ code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED" }),
    );
    expect(() => service.cursorRowFor(source.id, { deviceId: alpha.id })).toThrowError(
      expect.objectContaining({ code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED" }),
    );
  });

  test("owner transfer preserves a persisted replica version policy", async () => {
    const { db, alpha, beta, service } = fixture();
    for (const device of [alpha, beta]) {
      updateDeviceCapabilities(db, device.id, {
        ...device.capabilities,
        replicaVersionPolicies: { [REPLICATED]: "source-updated-at" },
      });
    }
    const source = await service.createSource({
      type: REPLICATED,
      accountId: AccountId("owner-transfer-version"),
      deviceId: alpha.id,
    });
    await service.joinSource(source.id, beta.id);
    await service.detachSource(source.id, alpha.id);

    expect(getSource(db, source.id)).toMatchObject({
      deviceId: beta.id,
      replicaVersionPolicy: "source-updated-at",
    });
    expect(service.replicaVersionPolicy(source.id)).toBe("source-updated-at");
  });

  test("concurrent exclusive to replicated requests observe one completed transition", async () => {
    let prepareCalls = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const enteredFirst = Promise.withResolvers<void>();
    const enteredSecond = Promise.withResolvers<void>();
    const { db, alpha, service } = fixture({
      beforePrepareModeTransition: async () => {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          enteredFirst.resolve();
          await firstBlocked;
        } else {
          enteredSecond.resolve();
          await secondBlocked;
        }
      },
      modeAdoption: () => Promise.resolve(),
    });
    const source = createSource(db, {
      type: REPLICATED,
      accountId: AccountId("concurrent-legacy-replica"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
    });
    const first = service.updateSource(source.id, { multiDeviceMode: "replicated" });
    await enteredFirst.promise;
    const second = service.updateSource(source.id, { multiDeviceMode: "replicated" });
    await enteredSecond.promise;

    releaseFirst();
    await expect(first).resolves.toMatchObject({ multiDeviceMode: "replicated" });
    releaseSecond();
    await expect(second).resolves.toMatchObject({ multiDeviceMode: "replicated" });
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("replicated");
  });

  test("collector join stores its local overlay and sends only its effective config", async () => {
    const { db, alpha, beta, service, notifySourceChange } = fixture();
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "partitioned",
      config: { syncInterval: "5m", params: { sharedLabel: "team" } },
    });
    setSourceMemberConfigOverride(db, source.id, alpha.id, {
      params: { sessionsPath: "/srv/fictional-alpha/sessions" },
    });

    const result = await service.bulkUpsertForDevice(beta.id, [
      {
        type: PARTITIONED,
        accountId: "shared",
        config: { syncInterval: "5m", params: { sharedLabel: "team" } },
        memberConfig: { params: { sessionsPath: "/srv/fictional-beta/sessions" } },
      },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.sources).toEqual([{ id: source.id, updated: false, memberConfigApplied: true }]);
    expect(getSource(db, source.id)?.config).toEqual({
      syncInterval: "5m",
      params: { sharedLabel: "team" },
    });
    expect(getSourceMemberConfigOverride(db, source.id, beta.id)).toEqual({
      params: { sessionsPath: "/srv/fictional-beta/sessions" },
    });
    expect(notifySourceChange).toHaveBeenCalledWith("source.added", beta.id, {
      source: expect.objectContaining({
        id: source.id,
        config: {
          syncInterval: "5m",
          params: {
            sharedLabel: "team",
            sessionsPath: "/srv/fictional-beta/sessions",
          },
        },
      }),
    });
    expect(JSON.stringify(notifySourceChange.mock.calls)).not.toContain("fictional-alpha");
  });

  test("collector update sends each member its own effective config", async () => {
    const { db, alpha, beta, service, notifySourceChange } = fixture();
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "partitioned",
      config: { syncInterval: "5m" },
    });
    await service.joinSource(source.id, beta.id);
    setSourceMemberConfigOverride(db, source.id, beta.id, {
      params: { sessionsPath: "/srv/fictional-beta/sessions" },
    });
    notifySourceChange.mockClear();

    const result = await service.bulkUpsertForDevice(alpha.id, [
      {
        type: PARTITIONED,
        accountId: "shared",
        config: { syncInterval: "10m" },
        memberConfig: { params: { sessionsPath: "/srv/fictional-alpha/sessions" } },
      },
    ]);

    expect(result.sources).toEqual([{ id: source.id, updated: true, memberConfigApplied: true }]);
    const updates = notifySourceChange.mock.calls
      .filter(([type]) => type === "source.updated")
      .map(([, deviceId, payload]) => [deviceId, payload.source.config]);
    expect(updates).toEqual(
      expect.arrayContaining([
        [
          alpha.id,
          {
            syncInterval: "10m",
            params: { sessionsPath: "/srv/fictional-alpha/sessions" },
          },
        ],
        [
          beta.id,
          {
            syncInterval: "10m",
            params: { sessionsPath: "/srv/fictional-beta/sessions" },
          },
        ],
      ]),
    );
  });

  test("member config patch updates and notifies only the addressed collector", async () => {
    const { db, alpha, beta, service, notifySourceChange, syncSourceSettingsToConfig } = fixture();
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "partitioned",
      config: { syncInterval: "5m" },
    });
    await service.joinSource(source.id, beta.id);
    notifySourceChange.mockClear();

    const effective = await service.updateMemberConfig(source.id, beta.id, {
      params: { sessionsPath: "/srv/fictional-beta/sessions" },
    });

    expect(effective.config).toEqual({
      syncInterval: "5m",
      params: { sessionsPath: "/srv/fictional-beta/sessions" },
    });
    expect(getSource(db, source.id)?.config).toEqual({ syncInterval: "5m" });
    expect(notifySourceChange).toHaveBeenCalledTimes(1);
    expect(notifySourceChange).toHaveBeenCalledWith("source.updated", beta.id, {
      source: effective,
    });
    expect(syncSourceSettingsToConfig).not.toHaveBeenCalled();
  });

  test("member config patch cannot resurrect a concurrently detached member", async () => {
    let entered!: () => void;
    const atWriter = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const continueWriter = new Promise<void>((resolve) => (release = resolve));
    const { db, alpha, beta, service } = fixture({
      beforeUpdateMemberConfig: async () => {
        entered();
        await continueWriter;
      },
    });
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "partitioned",
    });
    await service.joinSource(source.id, beta.id);

    const patch = service.updateMemberConfig(source.id, beta.id, {
      params: { sessionsPath: "/srv/fictional-beta/sessions" },
    });
    await atWriter;
    await service.detachSource(source.id, beta.id);
    release();

    await expect(patch).rejects.toMatchObject({ code: "DEVICE_NOT_MEMBER" });
    expect(memberIds(db, source.id)).toEqual([alpha.id]);
  });

  test("member config patch revalidates a capability change at the writer", async () => {
    const downgrade = () =>
      updateDeviceCapabilities(db, alpha.id, {
        hostableSourceTypes: [PARTITIONED],
        multiDeviceModes: { [PARTITIONED]: "partitioned" },
        memberScopedParams: { [PARTITIONED]: [] },
      });
    const { db, alpha, service } = fixture({
      beforeUpdateMemberConfig: async () => {
        downgrade();
      },
    });
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("writer-race"),
      deviceId: alpha.id,
      multiDeviceMode: "partitioned",
      memberScopedParams: ["sessionsPath"],
    });
    setSourceMemberConfigOverride(db, source.id, alpha.id, {
      params: { sessionsPath: "/srv/fictional-original/sessions" },
    });
    await expect(
      service.updateMemberConfig(source.id, alpha.id, {
        params: { sessionsPath: "/srv/fictional-new/sessions" },
      }),
    ).rejects.toThrow(/no longer advertises/);
    expect(getSourceMemberConfigOverride(db, source.id, alpha.id)).toEqual({
      params: { sessionsPath: "/srv/fictional-original/sessions" },
    });
  });

  test("legacy bulk upsert cannot erase a stored member-local overlay", async () => {
    const { db, alpha, service } = fixture();
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "partitioned",
      config: { syncInterval: "5m" },
    });
    setSourceMemberConfigOverride(db, source.id, alpha.id, {
      params: { sessionsPath: "/srv/fictional-alpha/sessions" },
    });

    await service.bulkUpsertForDevice(alpha.id, [
      {
        type: PARTITIONED,
        accountId: "shared",
        config: { syncInterval: "10m" },
        // Older collectors do not send memberConfig.
      },
    ]);

    expect(getSourceMemberConfigOverride(db, source.id, alpha.id)).toEqual({
      params: { sessionsPath: "/srv/fictional-alpha/sessions" },
    });
  });

  test("a partitioned collector without the member-config contract cannot write shared paths", async () => {
    const { db, preMemberConfig, service } = fixture();
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("shared"),
      deviceId: preMemberConfig.id,
      multiDeviceMode: "partitioned",
      config: { syncInterval: "5m" },
    });

    const result = await service.bulkUpsertForDevice(preMemberConfig.id, [
      {
        type: PARTITIONED,
        accountId: "shared",
        config: {
          syncInterval: "10m",
          params: { sessionsPath: "/srv/fictional-legacy/sessions" },
        },
      },
    ]);

    expect(result.sources).toEqual([]);
    expect(result.errors[0]?.error).toMatch(/member-local configuration contract/i);
    expect(getSource(db, source.id)?.config).toEqual({ syncInterval: "5m" });
  });

  test("gateway rejects a declared member param in shared config before any write", async () => {
    const { db, alpha, service } = fixture();
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "partitioned",
      config: { syncInterval: "5m" },
    });

    const result = await service.bulkUpsertForDevice(alpha.id, [
      {
        type: PARTITIONED,
        accountId: "shared",
        config: {
          syncInterval: "10m",
          params: { sessionsPath: "/srv/fictional-alpha/sessions" },
        },
        memberConfig: {},
      },
    ]);

    expect(result.sources).toEqual([]);
    expect(result.errors[0]?.error).toMatch(/member-scoped parameter.*shared config/i);
    expect(getSource(db, source.id)?.config).toEqual({ syncInterval: "5m" });
  });

  test("gateway rejects undeclared top-level member config before any write", async () => {
    const { db, alpha, service } = fixture();
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("shared"),
      deviceId: alpha.id,
      multiDeviceMode: "partitioned",
      config: { syncInterval: "5m" },
    });

    const result = await service.bulkUpsertForDevice(alpha.id, [
      {
        type: PARTITIONED,
        accountId: "shared",
        config: { syncInterval: "10m" },
        memberConfig: { syncInterval: "1m" },
      },
    ]);

    expect(result.sources).toEqual([]);
    expect(result.errors[0]?.error).toMatch(/field "syncInterval" is not supported/i);
    expect(getSource(db, source.id)?.config).toEqual({ syncInterval: "5m" });
  });

  test("a device joins a replicated source and learns it as an add; the owner stays", async () => {
    const { db, alpha, beta, service, notifySourceChange, seed } = fixture();
    const source = seed(REPLICATED);
    const joined = await service.joinSource(source.id, beta.id);
    expect(joined.deviceId).toBe(alpha.id);
    expect(memberIds(db, source.id)).toEqual(sorted([alpha.id, beta.id]));
    expect(notifySourceChange).toHaveBeenCalledWith("source.added", beta.id, { source });
    // Joining again is a no-op.
    await service.joinSource(source.id, beta.id);
    expect(memberIds(db, source.id)).toEqual(sorted([alpha.id, beta.id]));
  });

  test("a non-exclusive source refuses a collector that lacks its required contract", async () => {
    const { db, legacy, service, seed } = fixture();
    const source = seed(HANDOFF);

    await expect(service.joinSource(source.id, legacy.id)).rejects.toMatchObject({
      status: 409,
      code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
    });
    expect(memberIds(db, source.id)).toEqual([source.deviceId]);
  });

  test("a non-exclusive source refuses a collector that announces a conflicting mode", async () => {
    const { db, beta, service, seed } = fixture();
    const source = seed(REPLICATED);
    updateDeviceCapabilities(db, beta.id, {
      hostableSourceTypes: [REPLICATED],
      multiDeviceModes: { [REPLICATED]: "partitioned" },
      syncLease: true,
    });

    await expect(service.joinSource(source.id, beta.id)).rejects.toMatchObject({
      status: 409,
      code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
    });
    expect(memberIds(db, source.id)).toEqual([source.deviceId]);
  });

  test("a replicated source fails closed when members disagree on row version policy", async () => {
    const { db, alpha, beta, service } = fixture();
    updateDeviceCapabilities(db, alpha.id, {
      ...alpha.capabilities,
      replicaVersionPolicies: { [REPLICATED]: "source-updated-at" },
    });
    const source = createSource(db, {
      type: REPLICATED,
      accountId: AccountId("versioned"),
      deviceId: alpha.id,
      multiDeviceMode: "replicated",
      replicaVersionPolicy: "source-updated-at",
    });

    await expect(service.joinSource(source.id, beta.id)).rejects.toMatchObject({
      status: 409,
      code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
    });
    expect(memberIds(db, source.id)).toEqual([alpha.id]);

    updateDeviceCapabilities(db, beta.id, {
      ...beta.capabilities,
      replicaVersionPolicies: { [REPLICATED]: "source-updated-at" },
    });
    await service.joinSource(source.id, beta.id);
    expect(service.replicaVersionPolicy(source.id)).toBe("source-updated-at");
  });

  test("replicated sources without a row version policy keep ordinary arrival ordering", () => {
    const { service, seed } = fixture();
    const source = seed(REPLICATED);
    expect(service.replicaVersionPolicy(source.id)).toBeUndefined();
  });

  test("a lease-backed mode cannot activate from an announcement without lease support", async () => {
    const { legacy, service } = fixture();

    await expect(
      service.createSource({
        type: HANDOFF,
        accountId: AccountId("legacy-activation"),
        deviceId: legacy.id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
    });
  });

  test("a capable join is refused while an existing member lacks the pinned contract", async () => {
    const { db, beta, legacy, service, seed } = fixture();
    const source = seed(HANDOFF);
    db.prepare("INSERT INTO source_devices (source_id, device_id, added_at) VALUES (?, ?, ?)").run(
      source.id,
      legacy.id,
      1,
    );

    await expect(service.joinSource(source.id, beta.id)).rejects.toMatchObject({
      status: 409,
      code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
    });
    expect(memberIds(db, source.id)).toEqual(sorted([source.deviceId, legacy.id]));
  });

  test("an exclusive source refuses a join with the 409 that names its host", async () => {
    const { db, alpha, beta, service, seed } = fixture();
    const source = seed(EXCLUSIVE);
    await expect(service.joinSource(source.id, beta.id)).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_ALREADY_HOSTED",
      detail: { currentDeviceId: alpha.id, currentDeviceName: "collector-alpha" },
    });
    expect(memberIds(db, source.id)).toEqual([alpha.id]);
  });

  test("the admin add path and the collector's bulk-upsert join a replicated source", async () => {
    const { db, alpha, beta, service, seed } = fixture();
    const source = seed(REPLICATED);
    const viaAdmin = await service.createSource({
      type: REPLICATED,
      accountId: AccountId("shared"),
      deviceId: beta.id,
    });
    expect(viaAdmin.deviceId).toBe(alpha.id);
    expect(memberIds(db, source.id)).toEqual(sorted([alpha.id, beta.id]));

    const exclusive = seed(EXCLUSIVE);
    const result = await service.bulkUpsertForDevice(beta.id, [
      { type: REPLICATED, accountId: "shared", enabled: true },
      { type: EXCLUSIVE, accountId: "shared", enabled: true },
    ]);
    // The member's re-registration is accepted without touching the row.
    expect(result.sources).toEqual([{ id: source.id, updated: false }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("collector-alpha");
    expect(getSource(db, exclusive.id)?.deviceId).toBe(alpha.id);
    expect(memberIds(db, exclusive.id)).toEqual([alpha.id]);
  });

  test("collector bulk-upsert rejects both a new and a preexisting incompatible member", async () => {
    const { db, beta, legacy, service, seed } = fixture();
    const fresh = seed(HANDOFF);
    const existing = seed(REPLICATED);
    db.prepare("INSERT INTO source_devices (source_id, device_id, added_at) VALUES (?, ?, ?)").run(
      existing.id,
      beta.id,
      1,
    );
    updateDeviceCapabilities(db, beta.id, {
      hostableSourceTypes: [REPLICATED],
      multiDeviceModes: { [REPLICATED]: "partitioned" },
      syncLease: true,
    });

    const freshResult = await service.bulkUpsertForDevice(legacy.id, [
      { type: HANDOFF, accountId: "shared" },
    ]);
    const existingResult = await service.bulkUpsertForDevice(beta.id, [
      { type: REPLICATED, accountId: "shared" },
    ]);

    expect(freshResult.sources).toEqual([]);
    expect(freshResult.errors[0]?.error).toContain("does not support the handoff contract");
    expect(existingResult.sources).toEqual([]);
    expect(existingResult.errors[0]?.error).toContain("does not support the replicated contract");
    expect(memberIds(db, fresh.id)).toEqual([fresh.deviceId]);
  });

  test("a push device's first ingest joins a replicated source it has the write scope for", async () => {
    const { db, alpha, phone, service, notifySourceChange, seed } = fixture();
    const source = seed(PHONE_REPLICATED);
    await service.ensurePushSourcesRegistered([source.id], {
      deviceId: phone.id,
      scopes: [`write:${PHONE_REPLICATED}`] as Scope[],
    });
    expect(memberIds(db, source.id)).toEqual(sorted([alpha.id, phone.id]));
    expect(notifySourceChange).toHaveBeenCalledWith("source.added", phone.id, { source });
    // Without the scope, or for an exclusive source, nothing joins.
    const exclusive = seed(EXCLUSIVE);
    await service.ensurePushSourcesRegistered([exclusive.id], {
      deviceId: phone.id,
      scopes: [`write:${EXCLUSIVE}`] as Scope[],
    });
    expect(memberIds(db, exclusive.id)).toEqual([alpha.id]);
  });

  test("push auto-join requires explicit opt-in after a partitioned detach completes", async () => {
    const { db, alpha, beta, service, seed } = fixture();
    const source = seed(PARTITIONED);
    const auth = { deviceId: beta.id, scopes: [`write:${PARTITIONED}`] as Scope[] };
    await service.ensurePushSourcesRegistered([source.id], auth);
    expect(memberIds(db, source.id)).toEqual(sorted([alpha.id, beta.id]));
    const detached = removeSourceMember(db, source.id, beta.id);
    if (!detached.removed || !detached.streamCleanup) throw new Error("expected cleanup journal");
    completeSourceStreamCleanup(db, detached.streamCleanup);
    await expect(service.ensurePushSourcesRegistered([source.id], auth)).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_MEMBER_REJOIN_REQUIRED",
    });
    expect(memberIds(db, source.id)).toEqual([alpha.id]);
    await service.joinSource(source.id, beta.id);
    await service.ensurePushSourcesRegistered([source.id], auth);
    expect(memberIds(db, source.id)).toEqual(sorted([alpha.id, beta.id]));
  });

  test("writer rejects an implicit join queued before a completed detach", async () => {
    let beforeAdd = async () => {};
    const { db, alpha, beta, service, seed } = fixture({
      beforeAddSourceMember: () => beforeAdd(),
    });
    const source = seed(PARTITIONED);
    beforeAdd = async () => {
      // The read-side admission saw a never-member. An explicit join and
      // detach complete before its queued writer operation gets a turn.
      addSourceMember(db, source.id, beta.id);
      const detached = removeSourceMember(db, source.id, beta.id);
      if (!detached.removed || !detached.streamCleanup) throw new Error("expected cleanup journal");
      completeSourceStreamCleanup(db, detached.streamCleanup);
    };
    await expect(
      service.ensurePushSourcesRegistered([source.id], {
        deviceId: beta.id,
        scopes: [`write:${PARTITIONED}`] as Scope[],
      }),
    ).rejects.toMatchObject({ status: 409, code: "SOURCE_MEMBER_REJOIN_REQUIRED" });
    expect(memberIds(db, source.id)).toEqual([alpha.id]);
  });

  test("push auto-join refuses to expand membership around an incompatible owner", async () => {
    const { db, alpha, phone, service, seed } = fixture();
    const source = seed(PHONE_REPLICATED);
    updateDeviceCapabilities(db, alpha.id, {
      hostableSourceTypes: [PHONE_REPLICATED],
      multiDeviceModes: { [PHONE_REPLICATED]: "partitioned" },
      syncLease: true,
    });
    await expect(
      service.ensurePushSourcesRegistered([source.id], {
        deviceId: phone.id,
        scopes: [`write:${PHONE_REPLICATED}`] as Scope[],
      }),
    ).rejects.toMatchObject({ code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED" });
    expect(memberIds(db, source.id)).toEqual([alpha.id]);
  });

  test("detaching a member keeps the owner; detaching the owner passes ownership on", async () => {
    const {
      db,
      alpha,
      beta,
      phone,
      service,
      sendCommand,
      notifySourceChange,
      seed,
      forgetAbsenceObserver,
    } = fixture();
    const source = seed(PHONE_REPLICATED);
    await service.joinSource(source.id, beta.id);
    await service.joinSource(source.id, phone.id);

    const detached = await service.detachSource(source.id, beta.id);
    expect(detached?.source.deviceId).toBe(alpha.id);
    expect(detached?.members).toEqual([alpha.id, phone.id]);
    // The detached member's snapshots no longer speak for the source's rows.
    expect(forgetAbsenceObserver).toHaveBeenCalledWith(source.id, beta.id);
    // A detached collector gets a member-scoped snapshot that no longer lists the source.
    expect(sendCommand).toHaveBeenCalledWith(beta.id, "sources.snapshot", { sources: [] });

    const ownerLeft = await service.detachSource(source.id, alpha.id);
    expect(ownerLeft?.source.deviceId).toBe(phone.id);
    expect(getSource(db, source.id)?.deviceId).toBe(phone.id);
    expect(memberIds(db, source.id)).toEqual([phone.id]);

    // The last host cannot leave: a source always has a host, and taking it
    // away is removing the source.
    await expect(service.detachSource(source.id, phone.id)).rejects.toMatchObject({
      status: 409,
      code: "LAST_MEMBER",
    });
    expect(getSource(db, source.id)?.deviceId).toBe(phone.id);
    // A detached push device is told the source is gone for it.
    await service.joinSource(source.id, beta.id);
    await service.detachSource(source.id, phone.id);
    expect(notifySourceChange).toHaveBeenCalledWith("source.removed", phone.id, {
      sourceId: source.id,
    });
    expect(getSource(db, source.id)?.deviceId).toBe(beta.id);

    await expect(service.detachSource(source.id, phone.id)).rejects.toMatchObject({
      status: 409,
      code: "DEVICE_NOT_MEMBER",
    });
    expect(await service.detachSource(SourceId("notes-synth:nobody"), beta.id)).toBeNull();
  });

  test("detaching a partitioned member removes its stream from every store; the sibling's and the shared stream stay", async () => {
    const {
      db,
      alpha,
      beta,
      service,
      seed,
      streamPage,
      streamIds,
      deleteAnalyticsStream,
      deleteChunksByDocuments,
    } = fixture();
    const source = seed(PARTITIONED);
    await service.joinSource(source.id, beta.id);
    streamPage(source.id, alpha.id, ["day-1", "day-2"]);
    streamPage(source.id, beta.id, ["day-1", "day-2"]);
    streamPage(source.id, "", ["old-1"]);
    const betasDocIds = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE stream_id = ? ORDER BY id")
      .all(beta.id)
      .map((r) => r.id);
    expect(getDocumentCount(db, source.id)).toBe(5);

    const detached = await service.detachSource(source.id, beta.id);

    expect(detached?.members).toEqual([alpha.id]);
    expect(getDocumentCount(db, source.id)).toBe(3);
    expect(streamIds(source.id)).toEqual(["", alpha.id]);
    expect(deleteAnalyticsStream).toHaveBeenCalledWith(source.id, beta.id);
    expect(deleteChunksByDocuments).toHaveBeenCalledTimes(1);
    expect([...deleteChunksByDocuments.mock.calls[0]![0]].sort()).toEqual(betasDocIds);

    // A replicated member's detach leaves the documents: they are the source's, not the member's.
    const replicated = seed(REPLICATED);
    await service.joinSource(replicated.id, beta.id);
    streamPage(replicated.id, "", ["note-1"]);
    deleteAnalyticsStream.mockClear();
    await service.detachSource(replicated.id, beta.id);
    expect(getDocumentCount(db, replicated.id)).toBe(1);
    expect(deleteAnalyticsStream).not.toHaveBeenCalled();
  });

  test("a page a detached member had in flight is refused and its stream stays empty; the re-joined device claims past it", async () => {
    const { db, alpha, beta, service, seed, streamPage, streamIds, deleteAnalyticsStream } =
      fixture();
    const source = seed(PARTITIONED);
    await service.joinSource(source.id, beta.id);
    streamPage(source.id, alpha.id, ["day-1"]);
    streamPage(source.id, beta.id, ["day-1"]);
    const claimed = beginSyncAttempt(db, source.id, beta.id);
    // Cleanup runs only after membership and its cursor authority are retired.
    const membersDuringWipe: string[][] = [];
    deleteAnalyticsStream.mockImplementationOnce(async () => {
      membersDuringWipe.push(memberIds(db, source.id));
      return [];
    });

    await service.detachSource(source.id, beta.id);

    expect(membersDuringWipe).toEqual([[alpha.id]]);
    const late = streamPage(source.id, beta.id, ["day-2"], claimed);
    expect(late.rejected).toBe(true);
    expect(streamIds(source.id)).toEqual([alpha.id]);
    expect(getSyncState(db, source.id, beta.id)).toBeNull();
    await service.joinSource(source.id, beta.id);
    expect(beginSyncAttempt(db, source.id, beta.id)).toBeGreaterThan(claimed);
  });

  test("a move refuses the pages its losers had in flight; the streams they wiped stay empty", async () => {
    const { db, alpha, beta, legacy, service, seed, streamPage, streamIds } = fixture();
    const source = seed(PARTITIONED);
    await service.joinSource(source.id, beta.id);
    for (const member of [alpha, beta]) streamPage(source.id, member.id, ["day-1"]);
    const claims = new Map([alpha, beta].map((m) => [m.id, beginSyncAttempt(db, source.id, m.id)]));

    await service.updateSource(source.id, { deviceId: legacy.id });

    for (const loser of [alpha, beta]) {
      expect(streamPage(source.id, loser.id, ["day-2"], claims.get(loser.id)).rejected).toBe(true);
      expect(getSyncState(db, source.id, loser.id)).toBeNull();
    }
    expect(streamIds(source.id)).toEqual([]);
    expect(beginSyncAttempt(db, source.id, beta.id)).toBeGreaterThan(claims.get(beta.id)!);
  });

  test("an explicit move fences a shared-cursor page already in flight", async () => {
    const { db, beta, service, seed } = fixture();
    const source = seed(EXCLUSIVE);
    const claimed = beginSyncAttempt(db, source.id);

    await service.updateSource(source.id, { deviceId: beta.id });

    const late = upsertWithCursor(db, {
      providerId: "mail-synth",
      sourceId: source.id,
      documents: [
        {
          providerId: ProviderId("mail-synth"),
          sourceId: source.id,
          externalId: "late-page",
          title: "Late page",
          content: "A page claimed before the explicit move",
          contentHash: "late-page-before-move",
          metadata: {},
          sourceCreatedAt: "2026-01-01T00:00:00Z",
          sourceUpdatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      hasMore: false,
      cursor: { page: 1 },
      cursorDeviceId: "",
      streamId: "",
      wipeEpoch: claimed,
    });

    expect(late.rejected).toBe(true);
    expect(getDocumentCount(db, source.id)).toBe(0);
    expect(getWipeEpoch(db, source.id)).toBeGreaterThan(claimed);
  });

  test("a cleanup failure cannot preserve membership after erasing the member's SQLite stream", async () => {
    const {
      db,
      alpha,
      beta,
      legacy,
      service,
      seed,
      sendCommand,
      notifySourceChange,
      bump,
      streamPage,
      deleteAnalyticsStream,
    } = fixture();
    const source = seed(PARTITIONED);
    await service.joinSource(source.id, beta.id);
    await service.joinSource(source.id, legacy.id);
    for (const member of [alpha, beta, legacy]) streamPage(source.id, member.id, ["day-1"]);
    streamPage(source.id, "", ["old-1"]);
    const docsIn = (streamId: string) =>
      db
        .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM documents WHERE stream_id = ?")
        .get(streamId)!.n;
    sendCommand.mockClear();
    bump.mockClear();
    deleteAnalyticsStream.mockRejectedValueOnce(new Error("analytics unavailable"));

    const detached = await service.detachSource(source.id, beta.id);

    expect(detached?.members).toEqual([alpha.id, legacy.id]);
    expect(memberIds(db, source.id)).toEqual(sorted([alpha.id, legacy.id]));
    expect(getSource(db, source.id)?.deviceId).toBe(alpha.id);
    expect(sendCommand).toHaveBeenCalledWith(beta.id, "sources.snapshot", { sources: [] });
    expect(docsIn(alpha.id)).toBe(1);
    expect(docsIn(legacy.id)).toBe(1);
    expect(docsIn("")).toBe(1);
    expect(bump).toHaveBeenCalledTimes(2);

    // A move commits the authoritative membership before attempting its
    // retryable cleanup too. The caller must never be told the old owner is
    // still authoritative after one of its stores was already erased.
    sendCommand.mockClear();
    notifySourceChange.mockClear();
    deleteAnalyticsStream.mockRejectedValueOnce(new Error("analytics unavailable"));
    const moved = await service.updateSource(source.id, { deviceId: legacy.id });
    expect(moved?.deviceId).toBe(legacy.id);
    expect(memberIds(db, source.id)).toEqual([legacy.id]);
    expect(getSource(db, source.id)?.deviceId).toBe(legacy.id);
    expect(sendCommand).toHaveBeenCalledWith(alpha.id, "sources.snapshot", { sources: [] });
    expect(docsIn(legacy.id)).toBe(1);
  });

  test("simultaneous detaches cannot both wipe their streams before one is refused as the last member", async () => {
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => (release = resolve));
    const serviceGate = async () => {
      entered += 1;
      if (entered === 2) release();
      await bothEntered;
    };
    const { db, alpha, beta, service, seed, streamPage, streamIds } = fixture({
      beforeRemoveMember: serviceGate,
    });
    const source = seed(PARTITIONED);
    await service.joinSource(source.id, beta.id);
    streamPage(source.id, alpha.id, ["day-1"]);
    streamPage(source.id, beta.id, ["day-1"]);

    const outcomes = await Promise.allSettled([
      service.detachSource(source.id, alpha.id),
      service.detachSource(source.id, beta.id),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const survivors = memberIds(db, source.id);
    expect(survivors).toHaveLength(1);
    expect(streamIds(source.id)).toEqual(survivors);
  });

  test("a failed cleanup survives restart, blocks rejoin, and resumes before the device can return", async () => {
    const { db, beta, service, seed, deleteAnalyticsStream } = fixture();
    const source = seed(PARTITIONED);
    await service.joinSource(source.id, beta.id);
    deleteAnalyticsStream.mockRejectedValueOnce(new Error("analytics unavailable"));

    await service.detachSource(source.id, beta.id);

    expect(listPendingSourceStreamCleanups(db)).toMatchObject([
      { sourceId: source.id, deviceId: beta.id, generation: 1, attempts: 1 },
    ]);
    await expect(service.joinSource(source.id, beta.id)).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_STREAM_CLEANUP_IN_PROGRESS",
    });
    await expect(service.updateSource(source.id, { deviceId: beta.id })).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_STREAM_CLEANUP_IN_PROGRESS",
    });

    // Exercise the gateway's boot-time resumption entry point. The journal is
    // in SQLite rather than memory, and cleanup is idempotent: SQLite/index
    // may already be empty while the failed analytics arm finishes now.
    service.resumePendingRemovals();
    await vi.waitFor(() => expect(listPendingSourceStreamCleanups(db)).toEqual([]));
    await service.joinSource(source.id, beta.id);
    expect(memberIds(db, source.id)).toEqual(expect.arrayContaining([beta.id]));
  });

  test("concurrent moves cannot re-home onto a stream the winning move is retiring", async () => {
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => (release = resolve));
    const { db, alpha, beta, legacy, service, seed, streamPage, streamIds } = fixture({
      beforeMove: async () => {
        entered += 1;
        if (entered === 2) release();
        await bothEntered;
      },
    });
    const source = seed(PARTITIONED);
    await service.joinSource(source.id, beta.id);
    await service.joinSource(source.id, legacy.id);
    for (const member of [alpha, beta, legacy]) streamPage(source.id, member.id, ["day-1"]);

    const outcomes = await Promise.allSettled([
      service.updateSource(source.id, { deviceId: legacy.id }),
      service.updateSource(source.id, { deviceId: beta.id }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const owner = getSource(db, source.id)!.deviceId;
    expect(memberIds(db, source.id)).toEqual([owner]);
    expect(streamIds(source.id)).toEqual([owner]);
  });

  test("partitioned re-home ownership refusal preserves the source, destination member and every stream", async () => {
    const prepareSourceRemoval = vi.fn(async () => {
      throw new RowKeyError("Parent ownership is unresolved");
    });
    const {
      db,
      alpha,
      beta,
      service,
      seed,
      streamPage,
      streamIds,
      deleteAnalyticsStream,
      sendCommand,
      syncSourceSettingsToConfig,
    } = fixture({
      prepareSourceRemoval,
      sourceWriteEpochFence: new SourceWriteEpochFence(),
    });
    const source = seed(PARTITIONED);
    await service.joinSource(source.id, beta.id);
    for (const member of [alpha, beta]) streamPage(source.id, member.id, ["fixture-day"]);
    const before = getSource(db, source.id);
    const cursors = listSyncStates(db);
    sendCommand.mockClear();
    syncSourceSettingsToConfig.mockClear();
    await expect(
      service.updateSource(source.id, { deviceId: beta.id, enabled: false }),
    ).rejects.toMatchObject({
      status: 409,
      code: "ANALYTICS_OWNERSHIP_UNRESOLVED",
    });
    expect(prepareSourceRemoval).toHaveBeenCalledWith(source.id, undefined);
    expect(getSource(db, source.id)).toEqual(before);
    expect(memberIds(db, source.id)).toEqual(sorted([alpha.id, beta.id]));
    expect(streamIds(source.id)).toEqual(sorted([alpha.id, beta.id]));
    expect(listSyncStates(db)).toEqual(cursors);
    expect(listPendingSourceStreamCleanups(db)).toEqual([]);
    expect(deleteAnalyticsStream).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(syncSourceSettingsToConfig).not.toHaveBeenCalled();

    // No authority is displaced by naming the current owner again.
    prepareSourceRemoval.mockClear();
    await service.updateSource(source.id, { deviceId: alpha.id });
    expect(prepareSourceRemoval).not.toHaveBeenCalled();
  });

  test("partitioned re-home preflights all streams while fencing new writes and captures a late join", async () => {
    let entered!: () => void;
    let release!: () => void;
    const prepared = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fence = new SourceWriteEpochFence();
    const prepareSourceRemoval = vi.fn(async () => {
      entered();
      await proceed;
    });
    const { db, alpha, beta, legacy, service, seed } = fixture({
      prepareSourceRemoval,
      sourceWriteEpochFence: fence,
    });
    const source = seed(PARTITIONED);
    const moving = service.updateSource(source.id, { deviceId: beta.id });
    await prepared;
    let admitted = false;
    const write = fence.run(epochScope(source.id, alpha.id), async () => {
      admitted = true;
      expect(getSource(db, source.id)?.deviceId).toBe(beta.id);
    });
    await service.joinSource(source.id, legacy.id);
    expect(admitted).toBe(false);
    expect(prepareSourceRemoval).toHaveBeenCalledWith(source.id, undefined);
    release();
    await moving;
    await write;
    expect(memberIds(db, source.id)).toEqual([beta.id]);
    expect(admitted).toBe(true);
  });

  test("moving a partitioned source removes every former member's stream except the new owner's", async () => {
    const { alpha, beta, legacy, service, seed, streamPage, streamIds, deleteAnalyticsStream } =
      fixture();
    const source = seed(PARTITIONED);
    await service.joinSource(source.id, beta.id);
    await service.joinSource(source.id, legacy.id);
    for (const member of [alpha, beta, legacy]) streamPage(source.id, member.id, ["day-1"]);
    expect(streamIds(source.id)).toEqual(sorted([alpha.id, beta.id, legacy.id]));

    // Re-home onto a member: its stream is the source's history now.
    const moved = await service.updateSource(source.id, { deviceId: beta.id });
    expect(moved?.deviceId).toBe(beta.id);
    expect(streamIds(source.id)).toEqual([beta.id]);
    expect(deleteAnalyticsStream.mock.calls.map(([, streamId]) => streamId).sort()).toEqual(
      sorted([alpha.id, legacy.id]),
    );

    // Re-home onto a device that never contributed: every stream goes.
    deleteAnalyticsStream.mockClear();
    await service.updateSource(source.id, { deviceId: legacy.id });
    expect(streamIds(source.id)).toEqual([]);
    expect(deleteAnalyticsStream).toHaveBeenCalledWith(source.id, beta.id);
  });

  test("a join refuses an unknown, revoked or incapable device, and the last host cannot detach", async () => {
    const { db, alpha, beta, service, sendCommand, seed } = fixture();
    const source = seed(REPLICATED);
    await expect(
      service.joinSource(source.id, DeviceId("00000000-0000-4000-8000-000000000099")),
    ).rejects.toMatchObject({ status: 404, code: "DEVICE_NOT_FOUND" });
    const picky = createDevice(db, {
      name: "collector-picky",
      kind: "collector",
      capabilities: { hostableSourceTypes: [EXCLUSIVE] },
    });
    await expect(service.joinSource(source.id, picky.id)).rejects.toMatchObject({
      status: 400,
      code: "DEVICE_CANNOT_HOST_TYPE",
    });
    db.prepare("UPDATE devices SET revoked_at = 1 WHERE id = ?").run(beta.id);
    await expect(service.joinSource(source.id, beta.id)).rejects.toMatchObject({
      status: 409,
      code: "DEVICE_REVOKED",
    });
    await expect(service.detachSource(source.id, alpha.id)).rejects.toMatchObject({
      status: 409,
      code: "LAST_MEMBER",
    });
    // The refused detach tore nothing down.
    expect(sendCommand).not.toHaveBeenCalled();
    expect(getSource(db, source.id)?.deviceId).toBe(alpha.id);
  });

  test("a join and a move apply the hosting rule by kind: a phone hosts only the types its kind pushes, an operator kind never hosts", async () => {
    const { db, alpha, phone, service, seed } = fixture();
    const collectorType = seed(REPLICATED);
    await expect(service.joinSource(collectorType.id, phone.id)).rejects.toMatchObject({
      status: 400,
      code: "DEVICE_CANNOT_HOST_TYPE",
      detail: { deviceKind: "ios", sourceType: REPLICATED },
    });
    await expect(
      service.updateSource(collectorType.id, { deviceId: phone.id }),
    ).rejects.toMatchObject({ status: 400, code: "DEVICE_CANNOT_HOST_TYPE" });
    expect(memberIds(db, collectorType.id)).toEqual([alpha.id]);
    expect(getSource(db, collectorType.id)?.deviceId).toBe(alpha.id);

    const phoneType = seed(PHONE_REPLICATED);
    expect((await service.joinSource(phoneType.id, phone.id)).deviceId).toBe(alpha.id);
    expect(memberIds(db, phoneType.id)).toEqual(sorted([alpha.id, phone.id]));

    const portal = createDevice(db, { name: "portal-session", kind: "portal" });
    await expect(service.joinSource(phoneType.id, portal.id)).rejects.toMatchObject({
      status: 400,
      code: "DEVICE_CANNOT_HOST_TYPE",
      detail: { deviceKind: "portal", hostableSourceTypes: [] },
    });

    // The admin add path applies the same rule to a brand-new source.
    await expect(
      service.createSource({ type: REPLICATED, accountId: AccountId("fresh"), deviceId: phone.id }),
    ).rejects.toMatchObject({
      status: 400,
      code: "DEVICE_CANNOT_HOST_TYPE",
      detail: { deviceKind: "ios", sourceType: REPLICATED },
    });
    expect(getSource(db, SourceId(`${REPLICATED}:fresh`))).toBeNull();
  });

  test("a move re-seats the whole membership: every other member is torn down", async () => {
    const { db, alpha, beta, service, sendCommand, notifySourceChange, seed, syncStatus } =
      fixture();
    const gamma = createDevice(db, {
      name: "collector-gamma",
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [REPLICATED],
        multiDeviceModes: { [REPLICATED]: "replicated" },
        memberScopedParams: { [REPLICATED]: [] },
        syncLease: true,
      },
    });
    const source = seed(REPLICATED);
    await service.joinSource(source.id, beta.id);
    for (const deviceId of [alpha.id, beta.id]) {
      syncStatus.update({
        sourceId: source.id,
        deviceId,
        state: "completed",
        lastUpdated: Date.now(),
      });
    }
    sendCommand.mockClear();
    notifySourceChange.mockClear();

    const moved = await service.updateSource(source.id, { deviceId: gamma.id });
    expect(moved?.deviceId).toBe(gamma.id);
    expect(memberIds(db, source.id)).toEqual([gamma.id]);
    expect(syncStatus.listMembers(source.id)).toEqual([]);
    expect(notifySourceChange).toHaveBeenCalledWith("source.added", gamma.id, { source: moved });
    for (const loser of [alpha.id, beta.id]) {
      expect(sendCommand).toHaveBeenCalledWith(loser, "sources.snapshot", { sources: [] });
    }

    // Moving onto a member: it already hosts the source, so no add.
    await service.joinSource(source.id, beta.id);
    notifySourceChange.mockClear();
    await service.updateSource(source.id, { deviceId: beta.id });
    expect(notifySourceChange).not.toHaveBeenCalledWith("source.added", beta.id, expect.anything());
    expect(memberIds(db, source.id)).toEqual([beta.id]);
  });

  test("a move clears a member that joined after its preliminary membership read", async () => {
    let admitMove!: () => void;
    let moveEntered!: () => void;
    const admitted = new Promise<void>((resolve) => (admitMove = resolve));
    const entered = new Promise<void>((resolve) => (moveEntered = resolve));
    const { db, beta, service, seed, syncStatus, sendCommand } = fixture({
      beforeMove: async () => {
        moveEntered();
        await admitted;
      },
    });
    const late = createDevice(db, {
      name: "collector-late",
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [REPLICATED],
        multiDeviceModes: { [REPLICATED]: "replicated" },
        memberScopedParams: { [REPLICATED]: [] },
        syncLease: true,
      },
    });
    const source = seed(REPLICATED);

    const moving = service.updateSource(source.id, { deviceId: beta.id });
    await entered;
    await service.joinSource(source.id, late.id);
    syncStatus.update({
      sourceId: source.id,
      deviceId: late.id,
      state: "completed",
      lastUpdated: Date.now(),
    });
    admitMove();
    await moving;

    expect(memberIds(db, source.id)).toEqual([beta.id]);
    expect(syncStatus.listMembers(source.id)).toEqual([]);
    expect(sendCommand).toHaveBeenCalledWith(late.id, "sources.snapshot", { sources: [] });
  });

  test("a committed move clears former status even when config mirroring fails", async () => {
    const { db, alpha, beta, service, seed, syncStatus, syncSourceSettingsToConfig } = fixture();
    const source = seed(REPLICATED);
    syncStatus.update({
      sourceId: source.id,
      deviceId: alpha.id,
      state: "completed",
      lastUpdated: Date.now(),
    });
    syncSourceSettingsToConfig.mockRejectedValueOnce(new Error("config unavailable"));

    await expect(
      service.updateSource(source.id, { deviceId: beta.id, config: { folder: "Archive" } }),
    ).rejects.toThrow("config unavailable");

    expect(memberIds(db, source.id)).toEqual([beta.id]);
    expect(syncStatus.listMembers(source.id)).toEqual([]);
  });

  test("the cursor row: exclusive sources are ungated; a replicated one gates hosting devices and scopes their row", () => {
    const { alpha, beta, phone, service, seed } = fixture();
    const exclusive = seed(EXCLUSIVE);
    const replicated = seed(REPLICATED);
    // Nothing gates an exclusive source, whoever asks.
    expect(service.cursorRowFor(exclusive.id, { deviceId: beta.id })).toBe("");
    expect(service.cursorRowFor(exclusive.id, { deviceId: null })).toBe("");
    // An unknown source is not gated either — a push source may register on its first ingest.
    expect(service.cursorRowFor("notes-synth:nobody", { deviceId: beta.id })).toBe("");
    // The owner and a member get their own row; a non-member host is refused;
    // an operator identity uses the shared row.
    expect(service.cursorRowFor(replicated.id, { deviceId: alpha.id })).toBe(alpha.id);
    expect(() => service.cursorRowFor(replicated.id, { deviceId: phone.id })).toThrow(
      /does not host/,
    );
    expect(service.cursorRowFor(replicated.id, { deviceId: null })).toBe("");
  });

  test("status reads the freshest cursor row and lists one entry per member, live or persisted", async () => {
    const { db, alpha, beta, service, seed, syncStatus } = fixture();
    const source = seed(REPLICATED);
    await service.joinSource(source.id, beta.id);
    // The shared row carries only metadata; each member synced on its own row.
    setSourceMeta(db, source.id, { label: "Shared notes" });
    setSyncState(db, source.id, { page: 2 }, undefined, undefined, true, undefined, alpha.id);
    setSyncState(db, source.id, { page: 3 }, undefined, undefined, true, undefined, beta.id);
    for (const deviceId of [alpha.id, beta.id]) {
      syncStatus.update({
        sourceId: source.id,
        deviceId,
        state: "completed",
        lastUpdated: Date.now(),
      });
    }

    const single = service.syncStatusFor(source.id);
    expect(single?.state).toBe("synced");
    expect(single?.members?.map((m) => [m.deviceId, m.state]).sort()).toEqual(
      [
        [alpha.id, "synced"],
        [beta.id, "synced"],
      ].sort(),
    );
    const listed = service.listSyncStatuses().find((s) => s.sourceId === source.id);
    expect(listed?.state).toBe("synced");
    expect(listed?.members?.map((m) => m.deviceId).sort()).toEqual([alpha.id, beta.id].sort());

    // Detaching a member forgets its rows: it leaves the breakdown and no
    // longer stands for the source; the shared row and the owner's row stay.
    await service.detachSource(source.id, beta.id);
    expect(
      listSyncStates(db)
        .filter((r) => r.source_id === source.id)
        .map((r) => r.device_id)
        .sort(),
    ).toEqual(["", alpha.id].sort());
    const afterDetach = service.syncStatusFor(source.id);
    expect(afterDetach?.state).toBe("synced");
    expect(afterDetach?.members).toBeUndefined();
    expect(syncStatus.listMembers(source.id).map((status) => status.deviceId)).toEqual([alpha.id]);

    // A source nobody synced yet reads as idle with no breakdown; an unknown one is null.
    const exclusive = seed(EXCLUSIVE);
    expect(service.syncStatusFor(exclusive.id)?.state).toBe("idle");
    expect(service.syncStatusFor(exclusive.id)?.members).toBeUndefined();
    expect(service.syncStatusFor(SourceId("mail-synth:nobody"))).toBeNull();
  });

  test("each member carries its own notices; the aggregate carries them only without members", async () => {
    const { db, alpha, beta, service, seed, syncStatus } = fixture();
    const source = seed(REPLICATED);
    await service.joinSource(source.id, beta.id);
    setSyncState(db, source.id, { page: 2 }, undefined, undefined, true, undefined, alpha.id);
    setSyncState(db, source.id, { page: 3 }, undefined, undefined, true, undefined, beta.id);
    syncStatus.update({
      sourceId: source.id,
      deviceId: alpha.id,
      state: "error",
      errorMessage: "store locked",
      lastUpdated: Date.now(),
    });
    syncStatus.update({
      sourceId: source.id,
      deviceId: beta.id,
      state: "completed",
      unitName: "notes",
      coverage: "unknown",
      coverageDetail: "The app deletes old notes on its own",
      lastUpdated: Date.now(),
    });
    // alpha deleted two notes that beta's replica still holds.
    recordDeletionClaims(db, "notes-synth", source.id, alpha.id, ["n-1", "n-2"], Date.now());
    recordPresenceClaims(db, "notes-synth", source.id, beta.id, ["n-1", "n-2"], Date.now());

    const status = service.syncStatusFor(source.id)!;
    expect(status.notices).toBeUndefined();
    const byDevice = new Map(status.members!.map((m) => [m.deviceId, m.notices ?? []]));
    expect(byDevice.get(alpha.id)!.map((n) => [n.kind, n.detail])).toEqual([
      ["error", "store locked"],
    ]);
    expect(byDevice.get(beta.id)!.map((n) => [n.kind, n.title])).toEqual([
      ["replica-dispute", "Keeping 2 notes that collector-alpha no longer has"],
      ["coverage-unknown", "Older history may be incomplete"],
    ]);

    // With one member left there is no breakdown; the source carries its notices.
    await service.detachSource(source.id, beta.id);
    const single = service.syncStatusFor(source.id)!;
    expect(single.members).toBeUndefined();
    expect(single.notices?.map((n) => n.kind)).toEqual(["error"]);
  });

  test("the sync lease: hosts claim, a handoff page from a non-holder is refused, a replicated non-holder defers its reconcile", async () => {
    const { alpha, beta, phone, service, seed, lease, offline, tick } = fixture();
    const handoff = seed(HANDOFF);
    const replicated = seed(REPLICATED);
    const exclusive = seed(EXCLUSIVE);
    await service.joinSource(handoff.id, beta.id);
    await service.joinSource(replicated.id, beta.id);
    // Only a hosting device claims; a source with no lease grants trivially.
    await expect(service.claimLease(handoff.id, { deviceId: null })).rejects.toThrow(
      /Only a device/,
    );
    await expect(service.claimLease(handoff.id, { deviceId: phone.id })).rejects.toThrow(
      /does not host/,
    );
    expect(await service.claimLease(exclusive.id, { deviceId: alpha.id })).toMatchObject({
      granted: true,
    });
    expect(lease.holderOf(exclusive.id)).toBeNull();

    // The owner holds the handoff source; a member is refused and its page rejected.
    expect(await service.claimLease(handoff.id, { deviceId: alpha.id })).toMatchObject({
      granted: true,
      holder: alpha.id,
    });
    expect(await service.pageLeaseGate(handoff.id, { deviceId: alpha.id })).toEqual({
      rejected: false,
      reconcile: true,
    });
    expect(await service.pageLeaseGate(handoff.id, { deviceId: beta.id })).toEqual({
      rejected: true,
      holder: alpha.id,
    });
    // Releasing hands it to the next claim; a page from a capable device
    // with nobody holding the lease claims it by writing.
    expect(await service.releaseLease(handoff.id, { deviceId: beta.id })).toBe(false);
    expect(await service.releaseLease(handoff.id, { deviceId: alpha.id })).toBe(true);
    expect(await service.pageLeaseGate(handoff.id, { deviceId: beta.id })).toEqual({
      rejected: false,
      reconcile: true,
    });
    expect(lease.holderOf(handoff.id)?.deviceId).toBe(beta.id);

    // A replicated member without the lease commits but does not reconcile.
    expect(await service.claimLease(replicated.id, { deviceId: alpha.id })).toMatchObject({
      granted: true,
    });
    expect(await service.pageLeaseGate(replicated.id, { deviceId: beta.id })).toEqual({
      rejected: false,
      reconcile: false,
      replicated: true,
    });
    expect(await service.pageLeaseGate(replicated.id, { deviceId: alpha.id })).toEqual({
      rejected: false,
      reconcile: true,
      resetReplicaCursors: true,
      replicated: true,
    });
    // Sync now goes to a handoff source's online holder; with the holder
    // offline or no holder at all every member is triggered and their ticks
    // race for the lease.
    expect(service.syncTargets(handoff.id)).toEqual([beta.id]);
    offline.add(beta.id);
    expect(sorted(service.syncTargets(handoff.id))).toEqual(sorted([alpha.id, beta.id]));
    offline.delete(beta.id);
    lease.releaseAll(beta.id);
    expect(sorted(service.syncTargets(handoff.id))).toEqual(sorted([alpha.id, beta.id]));

    // A page from a capable non-holder inside the incumbent window is refused
    // the way its claim would be: the lapsed holder is online and preferred.
    expect(await service.claimLease(handoff.id, { deviceId: alpha.id })).toMatchObject({
      granted: true,
    });
    tick(90_000);
    expect(await service.pageLeaseGate(handoff.id, { deviceId: beta.id })).toEqual({
      rejected: true,
      holder: alpha.id,
    });
    offline.add(alpha.id);
    expect(await service.pageLeaseGate(handoff.id, { deviceId: beta.id })).toEqual({
      rejected: false,
      reconcile: true,
    });
    expect(lease.holderOf(handoff.id)?.deviceId).toBe(beta.id);
  });

  test("the stream: a partitioned source's hosts write their own, everything else the source's one stream", async () => {
    const { alpha, beta, phone, service, seed } = fixture();
    const partitioned = seed(PARTITIONED);
    await service.joinSource(partitioned.id, beta.id);
    const replicated = seed(REPLICATED);
    expect(service.streamFor(partitioned.id, { deviceId: alpha.id })).toBe(alpha.id);
    expect(service.streamFor(partitioned.id, { deviceId: beta.id })).toBe(beta.id);
    // An operator identity writes the shared stream; a non-host is refused.
    expect(service.streamFor(partitioned.id, { deviceId: null })).toBe("");
    expect(() => service.streamFor(partitioned.id, { deviceId: phone.id })).toThrow(
      /does not host/,
    );
    expect(service.streamFor(replicated.id, { deviceId: alpha.id })).toBe("");
    expect(service.streamFor("mail-synth:nobody", { deviceId: alpha.id })).toBe("");
    expect(service.streamFor("not a source id", { deviceId: alpha.id })).toBe("");
  });

  test("an existing mixed-version member is fenced from cursors and leases", async () => {
    const { db, legacy, service, seed } = fixture();
    const source = seed(HANDOFF);
    db.prepare("INSERT INTO source_devices (source_id, device_id, added_at) VALUES (?, ?, ?)").run(
      source.id,
      legacy.id,
      1,
    );

    expect(() => service.cursorRowFor(source.id, { deviceId: legacy.id })).toThrowError(
      expect.objectContaining({ code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED" }),
    );
    await expect(service.claimLease(source.id, { deviceId: legacy.id })).rejects.toThrowError(
      expect.objectContaining({ code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED" }),
    );
  });

  test("updates fan out to every member; Sync now targets follow the mode", async () => {
    const { alpha, beta, service, notifySourceChange, seed } = fixture();
    const source = seed(REPLICATED);
    await service.joinSource(source.id, beta.id);
    notifySourceChange.mockClear();
    const updated = await service.updateSource(source.id, { enabled: false });
    for (const deviceId of [alpha.id, beta.id]) {
      expect(notifySourceChange).toHaveBeenCalledWith("source.updated", deviceId, {
        source: updated,
      });
    }
    expect(service.syncTargets(source.id)).toEqual([alpha.id, beta.id]);
    const exclusive = seed(EXCLUSIVE);
    expect(service.syncTargets(exclusive.id)).toEqual([alpha.id]);
    expect(service.syncTargets(SourceId("notes-synth:nobody"))).toEqual([]);
  });

  test("the admin listing carries members and the mode, and a device filter includes joined sources", async () => {
    const { alpha, beta, service, seed } = fixture();
    const source = seed(REPLICATED);
    const exclusive = seed(EXCLUSIVE);
    await service.joinSource(source.id, beta.id);
    const all = service.listSourcesForAdmin();
    expect(all.find((s) => s.id === source.id)).toMatchObject({
      members: [alpha.id, beta.id],
      multiDeviceMode: "replicated",
    });
    expect(all.find((s) => s.id === exclusive.id)).toMatchObject({
      members: [alpha.id],
      multiDeviceMode: "exclusive",
    });
    expect(service.listSourcesForAdmin({ deviceId: beta.id }).map((s) => s.id)).toEqual([
      source.id,
    ]);
    expect(
      service.listSourcesForAdmin({ deviceId: DeviceId("00000000-0000-4000-8000-000000000009") }),
    ).toEqual([]);
  });

  test("a newer conflicting descriptor cannot reinterpret an existing source", () => {
    const { db, alpha, beta, service, seed } = fixture();
    const source = seed(REPLICATED);

    updateDeviceCapabilities(db, beta.id, {
      hostableSourceTypes: [REPLICATED],
      multiDeviceModes: { [REPLICATED]: "partitioned" },
      syncLease: true,
    });

    expect(service.listSourcesForAdmin().find((entry) => entry.id === source.id)).toMatchObject({
      multiDeviceMode: "replicated",
    });
    expect(service.streamFor(source.id, { deviceId: alpha.id })).toBe("");
  });

  test("a newer exclusive announcement cannot disable a persisted handoff lease", async () => {
    const { db, alpha, beta, service, seed } = fixture();
    const source = seed(HANDOFF);
    await service.joinSource(source.id, beta.id);
    expect(await service.claimLease(source.id, { deviceId: alpha.id })).toMatchObject({
      granted: true,
    });

    updateDeviceCapabilities(db, beta.id, {
      hostableSourceTypes: [HANDOFF],
      multiDeviceModes: { [HANDOFF]: "exclusive" },
      syncLease: true,
    });

    await expect(service.pageLeaseGate(source.id, { deviceId: beta.id })).rejects.toThrowError(
      expect.objectContaining({ code: "MULTI_DEVICE_CONTRACT_UNSUPPORTED" }),
    );
  });

  test("a newer handoff announcement cannot make a persisted exclusive source joinable", async () => {
    const { db, beta, service, seed } = fixture();
    const source = seed(EXCLUSIVE);

    updateDeviceCapabilities(db, beta.id, {
      hostableSourceTypes: [EXCLUSIVE],
      multiDeviceModes: { [EXCLUSIVE]: "handoff" },
      syncLease: true,
    });

    await expect(service.joinSource(source.id, beta.id)).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_ALREADY_HOSTED",
    });
  });

  test("a new source pins the target device's declaration, not another device's newer one", async () => {
    const { db, alpha, beta, service } = fixture();
    updateDeviceCapabilities(db, beta.id, {
      hostableSourceTypes: [REPLICATED],
      multiDeviceModes: { [REPLICATED]: "partitioned" },
      syncLease: true,
    });

    const source = await service.createSource({
      type: REPLICATED,
      accountId: AccountId("target-mode"),
      deviceId: alpha.id,
    });

    expect(getSource(db, source.id)?.multiDeviceMode).toBe("replicated");
    expect(service.listSourcesForAdmin().find((entry) => entry.id === source.id)).toMatchObject({
      multiDeviceMode: "replicated",
    });
  });

  test("the admin listing offers join candidates: paired, not yet a member, able to host the type — none for an exclusive source", async () => {
    const { db, beta, preMemberConfig, phone, service, seed } = fixture();
    const source = seed(REPLICATED);
    await service.joinSource(source.id, beta.id);
    const revoked = createDevice(db, {
      name: "collector-revoked",
      kind: "collector",
      capabilities: { hostableSourceTypes: [REPLICATED, PHONE_REPLICATED] },
    });
    db.prepare("UPDATE devices SET revoked_at = 1 WHERE id = ?").run(revoked.id);
    createDevice(db, { name: "portal-session", kind: "portal" });
    const phoneType = seed(PHONE_REPLICATED);
    const exclusive = seed(EXCLUSIVE);

    const listing = service.listSourcesForAdmin();
    const candidatesOf = (id: SourceId) => sorted(listing.find((s) => s.id === id)!.joinCandidates);
    // The owner and the joined member are out; the phone cannot host a
    // collector type; the revoked collector and the portal never join.
    expect(candidatesOf(source.id)).toEqual([]);
    // A type the phone's kind hosts admits the phone alongside the collectors.
    expect(candidatesOf(phoneType.id)).toEqual(sorted([beta.id, preMemberConfig.id, phone.id]));
    expect(candidatesOf(exclusive.id)).toEqual([]);
  });

  test.each([{ memberScopedParams: [] }, { memberScopedParams: ["differentPath"] }])(
    "the admin listing excludes a join candidate advertising $memberScopedParams instead of the pinned member contract",
    async ({ memberScopedParams }) => {
      const { db, alpha, service } = fixture();
      const source = await service.createSource({
        type: PARTITIONED,
        accountId: AccountId(`candidate-${memberScopedParams.length}`),
        deviceId: alpha.id,
      });
      const candidate = createDevice(db, {
        name: `collector-candidate-${memberScopedParams.length}`,
        kind: "collector",
        capabilities: {
          hostableSourceTypes: [PARTITIONED],
          multiDeviceModes: { [PARTITIONED]: "partitioned" },
          memberScopedParams: { [PARTITIONED]: memberScopedParams },
          syncLease: true,
        },
      });

      expect(
        service.listSourcesForAdmin().find((entry) => entry.id === source.id)?.joinCandidates,
      ).not.toContain(candidate.id);
    },
  );

  test("a pending mode transition blocks writes and lifecycle changes while the source stays exclusive", async () => {
    const { db, alpha, beta, service } = fixture();
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("pending-transition"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
    });
    prepareSourceModeTransition(db, source.id, "partitioned", alpha.id);
    recordSourceModeTransitionFailure(db, source.id, "synthetic analytics outage");

    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
    expect(service.listSourcesForAdmin().find((entry) => entry.id === source.id)).toMatchObject({
      modeTransition: {
        fromMode: "exclusive",
        toMode: "partitioned",
        lastError: "synthetic analytics outage",
      },
    });
    expect(() => service.cursorRowFor(source.id, { deviceId: alpha.id })).toThrowError(
      expect.objectContaining({ code: "SOURCE_MODE_TRANSITION_IN_PROGRESS" }),
    );
    await expect(service.pageLeaseGate(source.id, { deviceId: null })).rejects.toThrowError(
      expect.objectContaining({ code: "SOURCE_MODE_TRANSITION_IN_PROGRESS" }),
    );
    expect(() => service.syncTargets(source.id)).toThrowError(
      expect.objectContaining({ code: "SOURCE_MODE_TRANSITION_IN_PROGRESS" }),
    );
    await expect(service.claimLease(source.id, { deviceId: alpha.id })).rejects.toThrowError(
      expect.objectContaining({ code: "SOURCE_MODE_TRANSITION_IN_PROGRESS" }),
    );
    await expect(service.releaseLease(source.id, { deviceId: alpha.id })).rejects.toThrowError(
      expect.objectContaining({ code: "SOURCE_MODE_TRANSITION_IN_PROGRESS" }),
    );
    await expect(service.joinSource(source.id, beta.id)).rejects.toMatchObject({
      code: "SOURCE_MODE_TRANSITION_IN_PROGRESS",
    });
    await expect(service.deleteSource(source.id)).rejects.toMatchObject({
      code: "SOURCE_MODE_TRANSITION_IN_PROGRESS",
    });
    await expect(
      service.createSource({
        type: source.type,
        accountId: source.accountId,
        deviceId: alpha.id,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_MODE_TRANSITION_IN_PROGRESS" });
    expect(
      await service.bulkUpsertForDevice(alpha.id, [
        { id: source.id, type: source.type, accountId: source.accountId },
      ]),
    ).toMatchObject({
      count: 0,
      errors: [{ error: expect.stringContaining("is transitioning") }],
    });
  });

  test("last-member detach is refused before lease side effects", async () => {
    const { db, alpha, service, lease } = fixture();
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("detach-last-member"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
    });
    const release = vi.spyOn(lease, "release");

    await expect(service.detachSource(source.id, alpha.id)).rejects.toMatchObject({
      status: 409,
      code: "LAST_MEMBER",
    });
    expect(release).not.toHaveBeenCalled();
    expect(getSource(db, source.id)?.deviceId).toBe(alpha.id);
    expect(memberIds(db, source.id)).toEqual([alpha.id]);
  });

  test("an explicit mode patch adopts through the injected store seam before publishing partitioned", async () => {
    const adopt = vi.fn(async () => {});
    const { db, alpha, service } = fixture({ modeAdoption: adopt });
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("mode-change"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
    });

    const updated = await service.updateSource(source.id, { multiDeviceMode: "partitioned" });

    expect(adopt).toHaveBeenCalledWith(source.id, alpha.id);
    expect(updated?.multiDeviceMode).toBe("partitioned");
  });

  test("an explicit mode transition mirrors the stripped shared config", async () => {
    const { db, alpha, service, syncSourceSettingsToConfig } = fixture({
      modeAdoption: () => Promise.resolve(),
    });
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("legacy-member-param"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
      config: {
        syncInterval: "5m",
        params: {
          sessionsPath: "/srv/fictional-owner/sessions",
          sharedLabel: "fictional-team",
        },
      },
    });

    await service.updateSource(source.id, { multiDeviceMode: "partitioned" });

    expect(syncSourceSettingsToConfig).toHaveBeenCalledWith(source.id, undefined, true);
  });

  test("a failed transition file cleanup cannot leak its stale owner path on later reconcile", async () => {
    const { db, alpha, beta, service, syncSourceSettingsToConfig } = fixture({
      modeAdoption: () => Promise.resolve(),
    });
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("failed-file-cleanup"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
      config: {
        params: {
          sessionsPath: "/srv/fictional-owner/sessions",
          sharedLabel: "fictional-team",
        },
      },
    });
    syncSourceSettingsToConfig.mockRejectedValueOnce(new Error("synthetic config write failure"));

    await service.updateSource(source.id, { multiDeviceMode: "partitioned" });
    expect(
      db
        .prepare("SELECT last_error FROM source_mode_transition_publications WHERE source_id = ?")
        .get(source.id),
    ).toEqual({ last_error: "synthetic config write failure" });

    service.resumePendingRemovals();
    await vi.waitFor(() => {
      expect(syncSourceSettingsToConfig).toHaveBeenCalledTimes(2);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM source_mode_transition_publications WHERE source_id = ?",
          )
          .get(source.id),
      ).toEqual({ count: 0 });
    });
    expect(syncSourceSettingsToConfig).toHaveBeenLastCalledWith(source.id, undefined, true);

    await service.joinSource(source.id, beta.id);
    await reconcileConfig(db, directWriteGate(db), {
      sources: {
        [source.id]: {
          params: {
            sessionsPath: "/srv/stale-file/sessions",
            sharedLabel: "fictional-updated-team",
          },
        },
      },
    });

    expect(getSource(db, source.id)?.config).toEqual({
      params: { sharedLabel: "fictional-updated-team" },
    });
    expect(getSourceForMember(db, source.id, beta.id)?.config).toEqual({
      params: { sharedLabel: "fictional-updated-team" },
    });
  });

  test("an explicit mode patch refuses an owner re-home between its service read and writer prepare", async () => {
    let betaId = "";
    const { db, alpha, beta, service } = fixture({
      modeAdoption: () => Promise.resolve(),
      beforePrepareModeTransition: (sourceId) => {
        db.prepare("UPDATE sources SET device_id = ? WHERE id = ?").run(betaId, sourceId);
        db.prepare("DELETE FROM source_devices WHERE source_id = ?").run(sourceId);
        db.prepare(
          "INSERT INTO source_devices (source_id, device_id, added_at) VALUES (?, ?, 1)",
        ).run(sourceId, betaId);
        return Promise.resolve();
      },
    });
    betaId = beta.id;
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("owner-drift"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
    });

    await expect(
      service.updateSource(source.id, { multiDeviceMode: "partitioned" }),
    ).rejects.toThrow(/owner.*changed/i);
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
  });

  test("an explicit mode patch refuses capability drift before writer prepare", async () => {
    let ownerId = "";
    const { db, alpha, service } = fixture({
      modeAdoption: () => Promise.resolve(),
      beforePrepareModeTransition: () => {
        db.prepare("UPDATE devices SET capabilities = ? WHERE id = ?").run(
          JSON.stringify({ hostableSourceTypes: [PARTITIONED] }),
          ownerId,
        );
        return Promise.resolve();
      },
    });
    ownerId = alpha.id;
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("capability-drift"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
    });

    await expect(
      service.updateSource(source.id, { multiDeviceMode: "partitioned" }),
    ).rejects.toThrow(/does not support the partitioned contract/);
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
  });

  test("an explicit mode patch reports a revoked owner as a stable conflict", async () => {
    const { db, alpha, service } = fixture({ modeAdoption: () => Promise.resolve() });
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("revoked-owner"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
    });
    db.prepare("UPDATE devices SET revoked_at = 1 WHERE id = ?").run(alpha.id);

    await expect(
      service.updateSource(source.id, { multiDeviceMode: "partitioned" }),
    ).rejects.toMatchObject({ status: 409, code: "DEVICE_REVOKED" });
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
    expect(getSourceModeTransition(db, source.id)).toBeNull();
  });

  test("an owner revoked between the service read and writer prepare gets the same stable conflict", async () => {
    let ownerId = "";
    const { db, alpha, service } = fixture({
      modeAdoption: () => Promise.resolve(),
      beforePrepareModeTransition: () => {
        db.prepare("UPDATE devices SET revoked_at = 1 WHERE id = ?").run(ownerId);
        return Promise.resolve();
      },
    });
    ownerId = alpha.id;
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("owner-revocation-race"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
    });

    await expect(
      service.updateSource(source.id, { multiDeviceMode: "partitioned" }),
    ).rejects.toMatchObject({ status: 409, code: "DEVICE_REVOKED" });
    expect(getSourceModeTransition(db, source.id)).toBeNull();
  });

  test("a boot-resumed mode transition bumps caches and publishes the completed contract", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { db, alpha, service, notifySourceChange, bump } = fixture({
      modeAdoption: async () => blocked,
    });
    const source = createSource(db, {
      type: PARTITIONED,
      accountId: AccountId("resume-publish"),
      deviceId: alpha.id,
      multiDeviceMode: "exclusive",
    });
    prepareSourceModeTransition(db, source.id, "partitioned", alpha.id);

    service.resumePendingRemovals();
    expect(notifySourceChange).not.toHaveBeenCalledWith(
      "source.updated",
      alpha.id,
      expect.anything(),
    );
    release();

    await vi.waitFor(() =>
      expect(notifySourceChange).toHaveBeenCalledWith("source.updated", alpha.id, {
        source: expect.objectContaining({ id: source.id, multiDeviceMode: "partitioned" }),
      }),
    );
    expect(bump).toHaveBeenCalled();
  });

  test.each([
    {
      label: "extra membership",
      arrange: (db: ReturnType<typeof createDatabase>, sourceId: SourceId, betaId: DeviceId) => {
        db.prepare(
          "INSERT INTO source_devices (source_id, device_id, added_at) VALUES (?, ?, 1)",
        ).run(sourceId, betaId);
      },
      code: "SOURCE_MODE_TRANSITION_MEMBERSHIP_CONFLICT",
    },
    {
      label: "pending stream cleanup",
      arrange: (db: ReturnType<typeof createDatabase>, sourceId: SourceId, betaId: DeviceId) => {
        enqueueSourceStreamCleanup(db, sourceId, betaId);
      },
      code: "SOURCE_STREAM_CLEANUP_IN_PROGRESS",
    },
    {
      label: "ambiguous partitioned history",
      arrange: (db: ReturnType<typeof createDatabase>, sourceId: SourceId, betaId: DeviceId) => {
        db.prepare(
          `INSERT INTO removed_documents
             (provider_id, source_id, external_id, stream_id, removed_at)
           VALUES ('visits-synth', ?, 'fictional-old-row', ?, 1)`,
        ).run(sourceId, betaId);
      },
      code: "SOURCE_MODE_TRANSITION_AMBIGUOUS_HISTORY",
    },
  ])(
    "maps $label prepare refusal to a stable conflict without fencing",
    async ({ arrange, code }) => {
      const { db, alpha, beta, service } = fixture({ modeAdoption: async () => {} });
      const source = createSource(db, {
        type: PARTITIONED,
        accountId: AccountId(`conflict-${code.toLowerCase()}`),
        deviceId: alpha.id,
        multiDeviceMode: "exclusive",
      });
      const sharedEpoch = getWipeEpoch(db, source.id, "");
      const ownerEpoch = getWipeEpoch(db, source.id, alpha.id);
      arrange(db, source.id, beta.id);

      await expect(
        service.updateSource(source.id, { multiDeviceMode: "partitioned" }),
      ).rejects.toMatchObject({ status: 409, code });
      expect(getWipeEpoch(db, source.id, "")).toBe(sharedEpoch);
      expect(getWipeEpoch(db, source.id, alpha.id)).toBe(ownerEpoch);
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM source_mode_transitions WHERE source_id = ?")
          .get(source.id),
      ).toEqual({ n: 0 });
    },
  );

  test("an explicit mode patch refuses transitions outside the supported adoption matrix", async () => {
    const { service, seed } = fixture();
    const source = seed(REPLICATED);

    await expect(
      service.updateSource(source.id, { multiDeviceMode: "exclusive" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_MODE_TRANSITION_UNSUPPORTED",
    });
  });
});
