// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  assertNever,
  createLogger,
  SOURCE_CONTRACT_WIRE_VERSION,
  sourceContractWireRangeSchema,
  type WsRequestPayload,
  type WsResponsePayload,
} from "@omnesis/core";
import {
  AccountId,
  SourceId,
  SourceType,
  parseSourceId,
  scopeSatisfies,
  tryDeviceId,
  trySourceId,
  trySourceType,
  writeScope,
  hasPerDeviceCursor,
  DEVICE_HOSTED_SOURCE_TYPES,
  SOURCE_HOSTING_DEVICE_KINDS,
  type MultiDeviceMode,
  SCOPE_WRITE_ALL,
  DeviceId,
  type DeviceRecord,
  type Scope,
} from "@omnesis/types";
import {
  getSource,
  getSourceForMember,
  isSourceCleanupPending,
  isSourceRemoved,
  listPendingSourceRemovals,
  listRemovedSources,
  listSourcesForMember,
  listSourceMembers,
  listAllSourceMembers,
  isSourceMember,
  sourceMemberDetachRefusal,
  type SourceMemberDetachRefusal,
  type SourceRecord,
} from "../../data/repositories/SourceRepository.js";
import {
  countDisputedBySource,
  countRestoredByMember,
  listDeletersByRestorer,
} from "../../data/repositories/ReplicaDeletionClaimRepository.js";
import { getDevice } from "../../data/repositories/DeviceRepository.js";
import { sourceWireFloor } from "../../data/repositories/SourceWireContractRepository.js";
import {
  isStalePairingWriteError,
  type PairingGenerationFence,
} from "../../data/pairing-generation-fence.js";
import {
  hasSourceStreamCleanupHistory,
  isSourceStreamCleanupPending,
} from "../../data/repositories/SourceStreamCleanupRepository.js";
import {
  getSourceModeTransition,
  listPendingSourceModeTransitions,
  SourceModeTransitionPrepareError,
  type SourceModeTransition,
} from "../../data/repositories/SourceModeTransitionRepository.js";
import { getSourceMeta, getWipeEpoch, listSyncStatesForSource } from "../../db.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HttpError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors.js";
import {
  advertisedMemberScopedParamNames,
  deviceMatchesMemberConfigContract,
  deviceSupportsMultiDeviceMode,
  resolveDeviceMultiDeviceMode,
  splitMemberScopedParams,
} from "../../multi-device-mode.js";
import {
  deviceSupportsExistingSourceExecution,
  deviceSupportsPersistedSourceContract as supportsPersistedSourceContract,
  getSourceMemberConfigContract,
} from "../../data/repositories/SourceMemberConfigContractRepository.js";
import { purgeCognitiveStateThroughGate } from "../../brain/cognitive-state-cascade.js";
import { deriveDisplayStatus } from "../../sync-status.js";
import { buildSourceNotices } from "../../source-notices.js";
import {
  aggregateMobilePermissionHealth,
  listMobilePermissionHealth,
  listMobilePermissionHealthForSource,
  type MobilePermissionReportRow,
} from "../../data/repositories/MobilePermissionHealthRepository.js";
import { runWithPriority } from "../../priority.js";
import {
  getPendingSourcePage,
  type PreparePendingSourcePage,
} from "../../data/repositories/PendingSourcePageRepository.js";
import { epochScope } from "../../source-write-epoch-fence.js";
import { listSourceSyncIssues } from "../../data/repositories/SourceSyncIssueRepository.js";
import { assertSourceJoinDiscoverable } from "./source-join-preflight.js";
import { SourceStreamCleanupCoordinator } from "./SourceStreamCleanupCoordinator.js";
import {
  SourceModeTransitionCoordinator,
  type SourceModeTransitionAdoption,
} from "./SourceModeTransitionCoordinator.js";
import type { AccountDescriptor } from "@omnesis/source-sdk";
import type { SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import type {
  SourcePageWriteAuthority,
  SyncLeaseDecision,
  SyncLeaseHolder,
  SyncLeaseRegistry,
} from "../../sync-lease.js";
import type Database from "better-sqlite3";
import type { IndexWriteGate } from "../../indexer/index-write-gate.js";
import type { WriteGate } from "../../write-gate.js";
import type { DeviceWsServer } from "../../ws.js";
import type { DisplaySyncStatus, SyncStatusRegistry, SourceSyncStatus } from "../../sync-status.js";
import type { StoredSyncState } from "../../data/types.js";
import type { SourceDataRemovalService } from "./SourceDataRemovalService.js";
import type { StatusCache } from "./StatusCache.js";

type Db = Database.Database;

const log = createLogger("gateway:http").child("sources");

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemberParamValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Backoff for a post-removal sweep that failed. The first retry is quick
 * because the likely causes — an indexer worker restarting, a transient index
 * or disk error — usually clear within a minute.
 */
const SWEEP_RETRY_BASE_MS = 60_000;
const SWEEP_RETRY_MAX_MS = 15 * 60_000;

const SOURCE_WIRE_UPGRADE_REMEDIATION = {
  summary: "A device needs an upgrade before it can sync this source",
  steps: ["Update every collector that hosts this source to the gateway's release."],
  restartRequired: true,
};

/**
 * Context bundle for SourceService. Grouping closure helpers + registries
 * here keeps the constructor free of 10+ positional dependencies; the
 * service is instantiated once in createServer() and shared by admin.ts.
 */
export interface SourceServiceDeps {
  db: Db;
  writeGate: WriteGate;
  statusCache: StatusCache;
  wsServer?: DeviceWsServer;
  syncStatus?: SyncStatusRegistry;
  /**
   * Typed gate for `index.db` writes. When omitted
   * (test path that doesn't wire an index DB), the post-removal index
   * sweep is skipped — same behaviour as the prior raw-handle path.
   */
  indexWriteGate?: IndexWriteGate;
  /**
   * The multi-store wipes: a partitioned member's stream goes with the
   * member on detach and move, and a resync wipes a stream or the source.
   */
  sourceDataRemoval: SourceDataRemovalService;
  sourceWriteEpochFence?: SourceWriteEpochFence;
  /** Idempotent DuckDB adoption invoked between durable prepare and SQLite finalize. */
  sourceModeTransitionAdoption?: SourceModeTransitionAdoption;
  /** The sync lease of handoff and replicated sources; absent, nothing is lease-gated. */
  syncLease?: SyncLeaseRegistry;
  listDevices: () => readonly DeviceRecord[];
  notifySourceChange: <K extends "source.added" | "source.removed" | "source.updated">(
    type: K,
    deviceId: DeviceId,
    payload: WsRequestPayload<K>,
  ) => void;
  syncSourceSettingsToConfig: (
    id: string,
    /** Undefined resolves the live DB row inside the serialized config-file update. */
    dbConfig: Record<string, unknown> | null | undefined,
    required?: boolean,
  ) => Promise<void>;
}

export interface BulkUpsertEntry {
  id?: string;
  type?: string;
  accountId?: string;
  /** See `SourceRecord.account`. Absent from a collector that declares none. */
  account?: AccountDescriptor;
  config?: Record<string, unknown>;
  /** Configuration that is meaningful only on the calling collector. */
  memberConfig?: Record<string, unknown>;
  enabled?: boolean;
}

export interface BulkUpsertResult {
  count: number;
  sources: Array<{ id: string; updated: boolean; memberConfigApplied?: boolean }>;
  errors: Array<{ entry: unknown; error: string }>;
}

/** The device holding a live lease, or null once it lapsed. */
function liveHolder(holder: SyncLeaseHolder | null | undefined): DeviceId | null {
  return holder && !holder.expired ? holder.deviceId : null;
}

/**
 * Whether a device may host a source of this type. A collector hosts every
 * type unless it advertises `hostableSourceTypes`, in which case only those.
 * Any other kind hosts exactly the types `DEVICE_HOSTED_SOURCE_TYPES` lists
 * for it — phones and the browser extension never advertise a list, and the
 * operator kinds (cli, portal, agent) host nothing.
 */
export function deviceCanHostType(device: DeviceRecord, sourceType: SourceType): boolean {
  if (device.kind === "collector") {
    const advertised = device.capabilities.hostableSourceTypes;
    return !Array.isArray(advertised) || advertised.includes(sourceType);
  }
  return DEVICE_HOSTED_SOURCE_TYPES[device.kind].includes(sourceType);
}

/**
 * Whether a source's data only ever arrives by push, with nothing behind it
 * that a sync command makes re-read a store: a browser extension holds no
 * archive of the pages it captured, and a collector-hosted push source has an
 * inert `sync()` — an external runtime pushes its data. A phone pushes too,
 * but re-reads its own store when told to sync, so its sources are not
 * push-only. Wiping a push-only source is unrecoverable, so a resync of one
 * is refused.
 */
function isPushOnly(host: DeviceRecord, sourceType: SourceType): boolean {
  if (host.kind === "browser") return true;
  if (host.kind !== "collector") return false;
  return (host.capabilities.pushBasedSourceTypes ?? []).includes(sourceType);
}

/**
 * Where a resync's sync command went, by each online member's answer.
 * `deviceIds` started a fresh sync; `restarting` aborted the run they had in
 * flight and start over once it has stopped; `skipped` were already syncing
 * and left the command alone; `disabled` have the source paused, so nothing
 * re-fetches what was wiped until it is resumed there. A member that is
 * offline, or whose connection failed the command, is in none of them: it
 * syncs on its own schedule, and its next run reads the reset cursor anyway.
 */
interface ResyncDispatch {
  deviceIds: DeviceId[];
  restarting: DeviceId[];
  skipped: DeviceId[];
  disabled: DeviceId[];
}

/** The 400 a resync gets when `isPushOnly` says the device has nothing to fetch from. */
function pushOnlyResyncError(id: SourceId, host: DeviceRecord): HttpError {
  return new HttpError(
    400,
    "RESYNC_PUSH_ONLY",
    `${id} receives its data by push from ${host.name}; there is nothing to fetch it again from, so it cannot be resynced`,
  );
}

/** The 400 an add, a join or a move gets when `deviceCanHostType` says no. */
function cannotHostTypeError(device: DeviceRecord, sourceType: SourceType): HttpError {
  const hostable =
    device.kind === "collector"
      ? (device.capabilities.hostableSourceTypes ?? [])
      : DEVICE_HOSTED_SOURCE_TYPES[device.kind];
  return new HttpError(
    400,
    "DEVICE_CANNOT_HOST_TYPE",
    `device "${device.name}" (${device.kind}) cannot host source type "${sourceType}" — hostable types: ${hostable.join(", ") || "(none)"}`,
    { sourceType, deviceKind: device.kind, hostableSourceTypes: hostable },
  );
}

export type AdminSourceListEntry = SourceRecord & {
  lastSyncedAt: string | null;
  /** Every device contributing to the source, the owner first. */
  members: DeviceId[];
  multiDeviceMode: MultiDeviceMode;
  /** The device holding the source's sync lease, when one does. */
  leaseHolder: DeviceId | null;
  /**
   * Items one replica member reported deleted that another member still
   * holds. The gateway keeps them until the members agree; always 0 for a
   * source that is not replicated.
   */
  disputedDeletions: number;
  /**
   * The devices a join would accept right now: paired (not revoked), not
   * yet a member, and able to host the type (`deviceCanHostType`). Always
   * empty for an `exclusive` source, which admits no second host.
   */
  joinCandidates: DeviceId[];
  pushBased: boolean;
  /** Durable recovery state while a cross-store mode transition is pending. */
  modeTransition: Pick<
    SourceModeTransition,
    "fromMode" | "toMode" | "preparedAt" | "lastError"
  > | null;
};

/**
 * Why a push (`ingest`) for a given source was refused.
 *   - `removed` — the source carries a durable removal tombstone; the user
 *     removed it and it stays removed until an explicit re-enable.
 *   - `paused`  — a `sources` row exists with `enabled = 0`.
 * Returned to push clients (browser extension, Apple Health, Health Connect)
 * in the ingest response so they can stop pushing and surface the right state.
 */
export type PushRejectionReason = "removed" | "paused";
export interface PushRejection {
  sourceId: string;
  reason: PushRejectionReason;
}

/**
 * A source whose removal has been recorded but whose data purge is still
 * draining. Shaped to be renderable on its own: the `sources` row is already
 * gone, so a client has nothing else left to join against.
 */
export interface PendingRemovalEntry {
  id: SourceId;
  type: string;
  accountId: string;
  removedAt: number;
  state: "removing";
}

export class SourceService {
  private readonly streamCleanup: SourceStreamCleanupCoordinator;
  private readonly modeTransition: SourceModeTransitionCoordinator | null;
  /**
   * Sweeps running right now. Removal is idempotent and resumption cannot see
   * whether a sweep is already in flight, so this is what stops a repeated
   * DELETE or a boot-time resume from running two passes over one source.
   */
  private readonly sweeping = new Set<SourceId>();

  /**
   * Consecutive failures per source, which set the retry delay. Cleared on
   * success, so a source that fails once and then succeeds starts fresh.
   */
  private readonly sweepFailures = new Map<SourceId, number>();

  /** Retry timers, so shutdown can drop them. */
  private readonly retryTimers = new Map<SourceId, NodeJS.Timeout>();

  constructor(private readonly deps: SourceServiceDeps) {
    this.streamCleanup = new SourceStreamCleanupCoordinator({
      db: deps.db,
      writeGate: deps.writeGate,
      sourceDataRemoval: deps.sourceDataRemoval,
      statusCache: deps.statusCache,
    });
    this.modeTransition = deps.sourceModeTransitionAdoption
      ? new SourceModeTransitionCoordinator({
          db: deps.db,
          writeGate: deps.writeGate,
          adoption: deps.sourceModeTransitionAdoption,
          onCompleted: async (sourceId) => {
            await deps.syncSourceSettingsToConfig(sourceId, undefined, true);
            deps.statusCache.bump();
            const current = getSource(deps.db, sourceId);
            if (current) this.notifyMembers(current);
          },
        })
      : null;
  }

  private assertNoModeTransition(id: SourceId): void {
    const pending = getSourceModeTransition(this.deps.db, id);
    if (!pending) return;
    throw new HttpError(
      409,
      "SOURCE_MODE_TRANSITION_IN_PROGRESS",
      `source ${id} is transitioning from ${pending.fromMode} to ${pending.toMode}; retry after adoption finishes`,
      { sourceId: id, fromMode: pending.fromMode, toMode: pending.toMode },
    );
  }

  private modeTransitionPrepareError(error: SourceModeTransitionPrepareError): HttpError {
    const mapping: Record<
      SourceModeTransitionPrepareError["reason"],
      { status: 404 | 409; code: string }
    > = {
      "not-found": { status: 404, code: "SOURCE_NOT_FOUND" },
      "removal-pending": { status: 409, code: "SOURCE_REMOVAL_IN_PROGRESS" },
      "stream-cleanup-pending": { status: 409, code: "SOURCE_STREAM_CLEANUP_IN_PROGRESS" },
      "owner-revoked": { status: 409, code: "DEVICE_REVOKED" },
      unsupported: { status: 409, code: "SOURCE_MODE_TRANSITION_UNSUPPORTED" },
      "membership-conflict": {
        status: 409,
        code: "SOURCE_MODE_TRANSITION_MEMBERSHIP_CONFLICT",
      },
      "ambiguous-history": {
        status: 409,
        code: "SOURCE_MODE_TRANSITION_AMBIGUOUS_HISTORY",
      },
      "already-transitioning": {
        status: 409,
        code: "SOURCE_MODE_TRANSITION_IN_PROGRESS",
      },
    };
    const mapped = mapping[error.reason];
    return new HttpError(mapped.status, mapped.code, error.message);
  }

  private assertRemovalFinished(id: SourceId): void {
    if (isSourceCleanupPending(this.deps.db, id)) {
      throw new HttpError(
        409,
        "SOURCE_REMOVAL_IN_PROGRESS",
        `source ${id} is still being removed; retry after cleanup finishes`,
      );
    }
  }

  /**
   * The refusal for adopting a source another device hosts. Ownership only
   * moves through the explicit re-home (`updateSource` with a deviceId,
   * surfaced as `omnesis sources move`); a second add would leave both
   * hosts syncing one shared cursor.
   */
  private alreadyHostedError(sourceId: SourceId, hostDeviceId: DeviceId): HttpError {
    const host = getDevice(this.deps.db, hostDeviceId);
    return new HttpError(
      409,
      "SOURCE_ALREADY_HOSTED",
      `${sourceId} is already hosted by device "${host?.name ?? hostDeviceId}". To move it: omnesis sources move ${sourceId} --device <collector>`,
      {
        sourceId,
        currentDeviceId: hostDeviceId,
        currentDeviceName: host?.name ?? null,
      },
    );
  }

  /** The storage contract pinned on an existing source row. */
  modeFor(source: SourceRecord): MultiDeviceMode {
    return source.multiDeviceMode;
  }

  /** Whether a source uses shared replicated storage and lease-owned deletion. */
  isReplicated(rawId: string): boolean {
    const id = trySourceId(rawId);
    const source = id ? getSource(this.deps.db, id) : null;
    return source !== null && this.modeFor(source) === "replicated";
  }

  /**
   * The replicated row-version contract pinned on the source row. Device
   * announcements are compatibility evidence only; they cannot change an
   * existing source's storage semantics.
   */
  replicaVersionPolicy(rawId: string): "source-updated-at" | undefined {
    const id = trySourceId(rawId);
    const source = id ? getSource(this.deps.db, id) : null;
    if (!source || this.modeFor(source) !== "replicated") return undefined;
    const expected = source.replicaVersionPolicy ?? undefined;
    for (const deviceId of this.membersOf(source)) {
      const member = getDevice(this.deps.db, deviceId);
      if (member && member.capabilities.replicaVersionPolicies?.[source.type] !== expected) {
        throw new HttpError(
          409,
          "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
          `device "${member.name}" does not support the replica version contract for source type "${source.type}"; update the device before syncing this source`,
          { sourceType: source.type, multiDeviceMode: "replicated", deviceId: member.id },
        );
      }
    }
    return expected;
  }

  /** Resolve a new row's contract from its intended host, exactly once. */
  private initialModeFor(sourceType: SourceType, deviceId: DeviceId): MultiDeviceMode {
    const device = getDevice(this.deps.db, deviceId);
    const mode = resolveDeviceMultiDeviceMode(device, sourceType);
    if (device) this.assertModeSupport(device, sourceType, mode);
    return mode;
  }

  private initialReplicaVersionPolicyFor(
    sourceType: SourceType,
    deviceId: DeviceId,
    mode: MultiDeviceMode,
  ): "source-updated-at" | undefined {
    if (mode !== "replicated") return undefined;
    return getDevice(this.deps.db, deviceId)?.capabilities.replicaVersionPolicies?.[sourceType];
  }

  private initialContractFor(sourceType: SourceType, deviceId: DeviceId) {
    const multiDeviceMode = this.initialModeFor(sourceType, deviceId);
    return {
      multiDeviceMode,
      replicaVersionPolicy: this.initialReplicaVersionPolicyFor(
        sourceType,
        deviceId,
        multiDeviceMode,
      ),
    };
  }

  /** Refuse a host whose separately deployed client cannot honor the source's persisted contract. */
  private assertModeSupport(
    device: DeviceRecord,
    sourceType: SourceType,
    mode: MultiDeviceMode,
  ): void {
    if (!deviceSupportsMultiDeviceMode(device, sourceType, mode)) {
      throw new HttpError(
        409,
        "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
        `device "${device.name}" does not support the ${mode} contract for source type "${sourceType}"; update the device before hosting this source`,
        { sourceType, multiDeviceMode: mode, deviceId: device.id },
      );
    }
    if (this.deviceSupportsSourceContract(device, sourceType, mode)) return;
    throw new HttpError(
      409,
      "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
      `device "${device.name}" does not support the member-local configuration contract for partitioned source type "${sourceType}"; update the device before hosting this source`,
      { sourceType, multiDeviceMode: mode, deviceId: device.id },
    );
  }

  private deviceSupportsSourceContract(
    device: DeviceRecord,
    sourceType: SourceType,
    mode: MultiDeviceMode,
  ): boolean {
    if (!deviceSupportsMultiDeviceMode(device, sourceType, mode)) return false;
    return !(
      device.kind === "collector" &&
      mode === "partitioned" &&
      !Object.hasOwn(device.capabilities.memberScopedParams ?? {}, sourceType)
    );
  }

  private memberConfigContractFor(source: SourceRecord): string[] {
    const stored = getSourceMemberConfigContract(this.deps.db, source.id);
    if (stored) return stored;
    const owner = getDevice(this.deps.db, source.deviceId);
    const advertised = owner ? advertisedMemberScopedParamNames(owner, source.type) : null;
    if (advertised === null) {
      throw new HttpError(
        409,
        "MEMBER_CONFIG_CONTRACT_UNSUPPORTED",
        `source ${source.id} owner does not advertise an authoritative member-local configuration contract`,
      );
    }
    return advertised;
  }

  private assertMemberConfigContract(
    device: DeviceRecord,
    sourceType: SourceType,
    expected: readonly string[],
  ): void {
    if (deviceMatchesMemberConfigContract(device, sourceType, expected)) return;
    throw new HttpError(
      409,
      "MEMBER_CONFIG_CONTRACT_MISMATCH",
      `device "${device.name}" does not advertise the source's member-local configuration contract for source type "${sourceType}"`,
      { sourceType, deviceId: device.id, memberScopedParams: expected },
    );
  }

  private assertStoredMemberConfigContract(device: DeviceRecord, source: SourceRecord): void {
    const expected = getSourceMemberConfigContract(this.deps.db, source.id);
    if (expected === null) return;
    this.assertMemberConfigContract(device, source.type, expected);
  }

  private deviceSupportsPersistedSourceContract(
    device: DeviceRecord,
    source: SourceRecord,
    expected = getSourceMemberConfigContract(this.deps.db, source.id),
  ): boolean {
    return supportsPersistedSourceContract(this.deps.db, source, device, expected);
  }

  private assertSourceExecutionContract(device: DeviceRecord, source: SourceRecord): void {
    if (deviceSupportsExistingSourceExecution(this.deps.db, source, device)) return;
    // Preserve the established, actionable diagnostics for mode and
    // member-local parameter mismatches; the remaining arm is the replicated
    // row-version policy pinned on the source.
    this.assertModeSupport(device, source.type, source.multiDeviceMode);
    const replicaPolicyMismatch =
      source.multiDeviceMode === "replicated" &&
      device.capabilities.replicaVersionPolicies?.[source.type] !==
        (source.replicaVersionPolicy ?? undefined);
    if (!replicaPolicyMismatch) {
      this.assertStoredMemberConfigContract(device, source);
    }
    throw new HttpError(
      409,
      "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
      `device "${device.name}" no longer supports the persisted multi-device contract for source type "${source.type}"; update the device before syncing this source`,
      {
        sourceType: source.type,
        multiDeviceMode: source.multiDeviceMode,
        replicaVersionPolicy: source.replicaVersionPolicy,
        deviceId: device.id,
      },
    );
  }

  private assertMemberConfigPlacement(
    device: DeviceRecord,
    entry: BulkUpsertEntry,
    declaredOverride?: readonly string[],
  ): void {
    const sourceType = entry.type ? trySourceType(entry.type) : null;
    if (!sourceType) return;
    const declared =
      declaredOverride ?? advertisedMemberScopedParamNames(device, sourceType) ?? undefined;
    if (entry.memberConfig !== undefined && !declared) {
      throw new HttpError(
        409,
        "MEMBER_CONFIG_CONTRACT_UNSUPPORTED",
        `device "${device.name}" does not support member-local configuration for source type "${sourceType}"`,
      );
    }
    if (!declared) return;
    for (const name of Object.keys(entry.memberConfig ?? {})) {
      if (name !== "params") {
        throw new HttpError(
          400,
          "UNKNOWN_MEMBER_CONFIG_FIELD",
          `member-local configuration field "${name}" is not supported`,
        );
      }
    }
    const sharedParams = entry.config?.params;
    if (sharedParams !== undefined && !isPlainRecord(sharedParams)) {
      throw new HttpError(400, "INVALID_SHARED_PARAMS", "shared params must be an object");
    }
    if (isPlainRecord(sharedParams)) {
      const misplaced = Object.keys(
        splitMemberScopedParams(entry.config ?? {}, declared).memberParams,
      )[0];
      if (misplaced) {
        throw new HttpError(
          400,
          "MEMBER_PARAM_IN_SHARED_CONFIG",
          `member-scoped parameter "${misplaced}" must be sent in memberConfig, not shared config`,
        );
      }
    }
    const localParams = entry.memberConfig?.params;
    if (localParams !== undefined && !isPlainRecord(localParams)) {
      throw new HttpError(400, "INVALID_MEMBER_PARAMS", "member-local params must be an object");
    }
    if (isPlainRecord(localParams)) {
      for (const name of Object.keys(localParams)) {
        if (!declared.includes(name)) {
          throw new HttpError(
            400,
            "UNKNOWN_MEMBER_PARAM",
            `parameter "${name}" is not declared member-scoped for source type "${sourceType}"`,
          );
        }
        if (!isMemberParamValue(localParams[name])) {
          throw new HttpError(
            400,
            "INVALID_MEMBER_PARAM_VALUE",
            `member-scoped parameter "${name}" must have a primitive value`,
          );
        }
      }
    }
  }

  /** Every existing member must remain safe before membership can expand. */
  private assertMemberModesSupport(source: SourceRecord): void {
    const expectedReplicaPolicy = source.replicaVersionPolicy ?? undefined;
    for (const deviceId of this.membersOf(source)) {
      const device = getDevice(this.deps.db, deviceId);
      if (device) {
        this.assertModeSupport(device, source.type, source.multiDeviceMode);
        if (
          source.multiDeviceMode === "replicated" &&
          device.capabilities.replicaVersionPolicies?.[source.type] !== expectedReplicaPolicy
        ) {
          throw new HttpError(
            409,
            "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
            `device "${device.name}" does not support the replica version contract for source type "${source.type}"; update the device before hosting this source`,
            { sourceType: source.type, multiDeviceMode: "replicated", deviceId: device.id },
          );
        }
      }
    }
  }

  private assertMembersSupport(source: SourceRecord, memberScopedParams: readonly string[]): void {
    for (const deviceId of this.membersOf(source)) {
      const device = getDevice(this.deps.db, deviceId);
      if (device) {
        this.assertModeSupport(device, source.type, source.multiDeviceMode);
        this.assertMemberConfigContract(device, source.type, memberScopedParams);
      }
    }
  }

  /** The owner first, then every other member — the devices a source's events reach. */
  membersOf(source: SourceRecord): DeviceId[] {
    const members = [source.deviceId];
    for (const m of listSourceMembers(this.deps.db, source.id)) {
      if (!members.includes(m.deviceId)) members.push(m.deviceId);
    }
    return members;
  }

  /**
   * The devices a "Sync now" reaches: every member of a source each member
   * syncs on its own cursor; the lease holder of a handoff source while it
   * is online, else every member (their ticks race for the lease); the
   * owner otherwise.
   */
  syncTargets(id: SourceId): DeviceId[] {
    const source = getSource(this.deps.db, id);
    if (!source) return [];
    this.assertNoModeTransition(id);
    const mode = this.modeFor(source);
    if (hasPerDeviceCursor(mode)) return this.membersOf(source);
    if (mode === "handoff") {
      const holder = this.deps.syncLease?.holderOf(id);
      if (holder && !holder.expired && this.deps.wsServer?.isConnected(holder.deviceId)) {
        return [holder.deviceId];
      }
      return this.membersOf(source);
    }
    return [source.deviceId];
  }

  /**
   * The stream a device's documents belong to: its own for a partitioned
   * source — every device contributes a distinct stream, and a snapshot only
   * reconciles the contributor's own — and the source's one stream otherwise.
   * An exclusive-to-partitioned transition first adopts shared-stream history
   * into the owner's stream, so partitioned operations see one identity per
   * contributor. Exclusive-to-replicated adoption deliberately leaves this
   * shared stream unchanged.
   */
  streamFor(rawId: string, auth: { deviceId: DeviceId | null }): string {
    const id = trySourceId(rawId);
    const source = id ? getSource(this.deps.db, id) : null;
    if (!source || this.modeFor(source) !== "partitioned") return "";
    // The stream is the device's cursor row: a hosting member's own id, the
    // shared row for an operator identity, and a refusal for a non-member.
    return this.cursorRowFor(rawId, auth);
  }

  /** Ownership changes wait for admitted source writes to finish committing. */
  private withLeaseMutation<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.runSourceExclusive(sourceId, operation)
      : operation();
  }

  /** Only hosts claim; exclusive and partitioned sources grant trivially. */
  claimLease(rawId: string, auth: { deviceId: DeviceId | null }): Promise<SyncLeaseDecision> {
    return this.withLeaseMutation(rawId, async () => this.claimLeaseFenced(rawId, auth));
  }

  private claimLeaseFenced(rawId: string, auth: { deviceId: DeviceId | null }): SyncLeaseDecision {
    const id = SourceId(rawId);
    const { deviceId, source } = this.requireLeaseCaller(id, auth);
    const device = getDevice(this.deps.db, deviceId);
    if (device) this.assertModeSupport(device, source.type, source.multiDeviceMode);
    const mode = this.modeFor(source);
    if (!this.deps.syncLease || (mode !== "handoff" && mode !== "replicated")) {
      return { granted: true, holder: deviceId, expiresAt: 0 };
    }
    this.releaseIncompatibleWireLease(id);
    const decision = this.deps.syncLease.claim(id, deviceId);
    if (decision.granted) log.debug(`Sync lease on ${id} held by device ${deviceId}`);
    else log.debug(`Sync lease on ${id} refused to device ${deviceId}: ${decision.reason}`);
    return decision;
  }

  /** Drop every lease a device holds — it was revoked or forgotten. */
  async releaseDeviceLeases(deviceId: DeviceId): Promise<void> {
    const release = async () => {
      this.deps.syncLease?.releaseAll(deviceId);
    };
    if (this.deps.sourceWriteEpochFence)
      await this.deps.sourceWriteEpochFence.runGlobalExclusive(release);
    else await release();
  }

  releaseLease(rawId: string, auth: { deviceId: DeviceId | null }): Promise<boolean> {
    return this.withLeaseMutation(rawId, async () => {
      const id = SourceId(rawId);
      const { deviceId } = this.requireLeaseCaller(id, auth);
      return this.deps.syncLease?.release(id, deviceId) ?? false;
    });
  }

  /** Initial admission may acquire a vacant handoff lease, under the source barrier. */
  pageLeaseGate(rawId: string, auth: { deviceId: DeviceId | null }) {
    return this.withLeaseMutation(rawId, async () => this.evaluatePageLease(rawId, auth, true));
  }

  /** Must run inside the caller's write fence, not before waiting for admission. */
  pageWriteAuthority(
    rawId: string,
    auth: { deviceId: DeviceId | null },
  ): () => SourcePageWriteAuthority {
    return () => {
      // Legacy schema-only analytics pages may omit a write epoch. The
      // durable removal marker must still win after their admission wait.
      if (isSourceRemoved(this.deps.db, SourceId(rawId))) {
        throw new HttpError(
          409,
          "SOURCE_REMOVED",
          "The source was removed before this page was admitted",
        );
      }
      // Membership can disappear while HTTP admission waits for the fence.
      // A former replica must not become an ungated legacy writer on retry.
      this.cursorRowFor(rawId, auth);
      const gate = this.evaluatePageLease(rawId, auth, false);
      if (gate.rejected)
        throw new HttpError(
          409,
          "SYNC_LEASE_CHANGED",
          "The sync lease changed before this page was admitted; retry after claiming the lease",
        );
      return {
        deletionAuthority: gate.reconcile,
        reconcileAuthority: gate.reconcile,
        resetReplicaCursors: gate.resetReplicaCursors,
      };
    };
  }

  /**
   * What the lease allows a page from `auth` to do on a source: nothing (a
   * handoff source held by another device), everything, or everything but
   * its deletion channels (a replicated source whose deletion authority is
   * another member). For a replicated holder it also requires an accepted
   * tombstone to invalidate sibling cursor rows for self-healing. A host that
   * has not announced the persisted mode and, for a lease-backed mode, the
   * lease capability is refused. A holder's page renews its lease.
   */
  private evaluatePageLease(
    rawId: string,
    auth: { deviceId: DeviceId | null },
    mayClaim: boolean,
  ):
    | { rejected: true; holder?: DeviceId }
    | {
        rejected: false;
        reconcile: boolean;
        /** Resolve and invalidate sibling cursors in the tombstone transaction. */
        resetReplicaCursors?: true;
        /** The page comes from a member of a replicated source: its documents and tombstones are that member's verdicts. */
        replicated?: true;
      } {
    const ungated = { rejected: false as const, reconcile: true };
    const lease = this.deps.syncLease;
    const deviceId = auth.deviceId;
    const device = deviceId ? this.requireActiveLeaseDevice(deviceId) : undefined;
    const id = SourceId(rawId);
    const source = getSource(this.deps.db, id);
    if (!source) return ungated;
    this.assertNoModeTransition(id);
    if (!lease || !deviceId) return ungated;
    const mode = this.modeFor(source);
    if (mode !== "handoff" && mode !== "replicated") return ungated;
    const hosts = source.deviceId === deviceId || isSourceMember(this.deps.db, id, deviceId);
    if (!hosts) return ungated;
    if (!device) {
      throw new HttpError(
        409,
        "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
        `device ${deviceId} is unavailable and cannot honor the ${mode} contract for ${id}`,
      );
    }
    this.assertModeSupport(device, source.type, mode);
    if (lease.renew(id, deviceId)) {
      return mode === "replicated"
        ? {
            ...ungated,
            resetReplicaCursors: true as const,
            replicated: true as const,
          }
        : ungated;
    }
    if (mode === "handoff") {
      if (!mayClaim) return { rejected: true, holder: lease.holderOf(id)?.deviceId };
      const claimed = lease.claim(id, deviceId);
      return claimed.granted ? ungated : { rejected: true, holder: claimed.holder };
    }
    return { rejected: false, reconcile: false, replicated: true as const };
  }

  private requireLeaseCaller(
    id: SourceId,
    auth: { deviceId: DeviceId | null },
  ): { deviceId: DeviceId; source: SourceRecord } {
    if (!auth.deviceId) throw new BadRequestError("Only a device claims a sync lease");
    this.requireActiveLeaseDevice(auth.deviceId);
    const source = getSource(this.deps.db, id);
    if (!source) throw new NotFoundError("Source not found");
    this.assertNoModeTransition(id);
    if (source.deviceId !== auth.deviceId && !isSourceMember(this.deps.db, id, auth.deviceId)) {
      throw new ForbiddenError(`Device ${auth.deviceId} does not host ${id}`);
    }
    this.sourceWireAuthority([id], auth)();
    return { deviceId: auth.deviceId, source };
  }

  private requireActiveLeaseDevice(deviceId: DeviceId): DeviceRecord {
    const device = getDevice(this.deps.db, deviceId);
    if (!device || device.revokedAt !== null) {
      throw new ForbiddenError("Device is unavailable or revoked; pair it again before syncing");
    }
    return device;
  }

  private sourceForMember(source: SourceRecord, deviceId: DeviceId): SourceRecord {
    return getSourceForMember(this.deps.db, source.id, deviceId) ?? source;
  }

  private notifyMembers(source: SourceRecord): void {
    for (const deviceId of this.membersOf(source)) {
      const device = getDevice(this.deps.db, deviceId);
      if (!device || !deviceSupportsExistingSourceExecution(this.deps.db, source, device)) {
        continue;
      }
      this.deps.notifySourceChange("source.updated", deviceId, {
        source: this.sourceForMember(source, deviceId),
      });
    }
  }

  /**
   * Join requested by an operator. For a new online collector member, use
   * the descriptor's discovery hook to prove that the exact source account
   * exists there before membership is persisted. Capability advertisement
   * proves only that the collector can run the source type; it says nothing
   * about which host-local account is present.
   *
   * Offline collectors retain the established deferred-join behaviour and
   * discover-less sources keep their existing provider-specific setup flow.
   * The collector's setup audit remains the backstop for the unavoidable
   * interval between this remote check and the membership write.
   */
  async joinSourceFromAdmin(
    sourceId: SourceId,
    deviceId: DeviceId,
    memberConfig?: Record<string, unknown>,
    pairingFence?: PairingGenerationFence,
  ): Promise<SourceRecord> {
    const source = getSource(this.deps.db, sourceId);
    const device = getDevice(this.deps.db, deviceId);
    const needsPreflight =
      source !== null &&
      device !== null &&
      device.kind === "collector" &&
      this.modeFor(source) !== "exclusive" &&
      source.deviceId !== deviceId &&
      !isSourceMember(this.deps.db, sourceId, deviceId);

    if (needsPreflight) {
      await assertSourceJoinDiscoverable(source, device, this.deps.wsServer, memberConfig);
    }

    return this.joinSource(sourceId, deviceId, memberConfig, pairingFence);
  }

  /**
   * Join a device to a source another device already hosts. Refused for an
   * exclusive source (the 409 names the owner); for every other mode the
   * device becomes a member and learns the source as an add.
   */
  async joinSource(
    sourceId: SourceId,
    deviceId: DeviceId,
    memberConfig?: Record<string, unknown>,
    pairingFence?: PairingGenerationFence,
    allowDetachedRejoin = true,
  ): Promise<SourceRecord> {
    this.assertNoModeTransition(sourceId);
    const { db, writeGate: w, statusCache, syncStatus, notifySourceChange } = this.deps;
    const source = getSource(db, sourceId);
    if (!source) throw new HttpError(404, "SOURCE_NOT_FOUND", `source ${sourceId} not found`);
    const device = getDevice(db, deviceId);
    if (!device) throw new HttpError(404, "DEVICE_NOT_FOUND", `device ${deviceId} not found`);
    if (device.revokedAt !== null) {
      throw new HttpError(
        409,
        "DEVICE_REVOKED",
        `device "${device.name}" is revoked — pair it again to reclaim it, or forget it`,
      );
    }
    const mode = this.modeFor(source);
    if (source.deviceId === deviceId || isSourceMember(db, sourceId, deviceId)) {
      this.assertModeSupport(device, source.type, mode);
      if (memberConfig !== undefined) {
        const memberScopedParams = this.memberConfigContractFor(source);
        this.assertMemberConfigContract(device, source.type, memberScopedParams);
        this.assertMemberConfigPlacement(
          device,
          { type: source.type, accountId: source.accountId, memberConfig },
          memberScopedParams,
        );
        if (
          !(await w.addSourceMember(
            sourceId,
            deviceId,
            memberConfig,
            memberScopedParams,
            pairingFence,
          ))
        ) {
          throw new HttpError(404, "SOURCE_NOT_FOUND", `source ${sourceId} not found`);
        }
        const effective = this.sourceForMember(source, deviceId);
        notifySourceChange("source.updated", deviceId, { source: effective });
        return effective;
      }
      return this.sourceForMember(source, deviceId);
    }
    if (mode === "exclusive") {
      throw this.alreadyHostedError(sourceId, source.deviceId);
    }
    if (!deviceCanHostType(device, source.type)) throw cannotHostTypeError(device, source.type);
    this.assertModeSupport(device, source.type, mode);
    this.assertMemberModesSupport(source);
    if (mode === "replicated") {
      const owner = getDevice(db, source.deviceId);
      const expected = owner?.capabilities.replicaVersionPolicies?.[source.type];
      if (device.capabilities.replicaVersionPolicies?.[source.type] !== expected) {
        throw new HttpError(
          409,
          "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
          `device "${device.name}" does not support the replica version contract for source type "${source.type}"; update the device before hosting this source`,
          { sourceType: source.type, multiDeviceMode: mode, deviceId: device.id },
        );
      }
    }
    const memberScopedParams = this.memberConfigContractFor(source);
    this.assertMemberConfigContract(device, source.type, memberScopedParams);
    this.assertMemberConfigPlacement(
      device,
      { type: source.type, accountId: source.accountId, memberConfig },
      memberScopedParams,
    );
    this.assertMembersSupport(source, memberScopedParams);
    // The owner's config is the source's config; a joiner never brings one.
    if (
      !(await w.addSourceMember(
        sourceId,
        deviceId,
        memberConfig,
        memberScopedParams,
        pairingFence,
        allowDetachedRejoin,
      ))
    ) {
      this.assertNoModeTransition(sourceId);
      if (
        !allowDetachedRejoin &&
        mode === "partitioned" &&
        hasSourceStreamCleanupHistory(db, sourceId, deviceId)
      ) {
        throw new HttpError(
          409,
          "SOURCE_MEMBER_REJOIN_REQUIRED",
          `device ${deviceId} stopped contributing to ${sourceId}; explicitly enable it again before pushing`,
        );
      }
      if (isSourceStreamCleanupPending(db, sourceId, deviceId)) {
        throw new HttpError(
          409,
          "SOURCE_STREAM_CLEANUP_IN_PROGRESS",
          `device ${deviceId} is still being detached from ${sourceId}; retry after cleanup finishes`,
        );
      }
      throw new HttpError(404, "SOURCE_NOT_FOUND", `source ${sourceId} not found`);
    }
    statusCache.bump();
    syncStatus?.clearTombstone(sourceId);
    const effective = this.sourceForMember(source, deviceId);
    notifySourceChange("source.added", deviceId, { source: effective });
    log.info(`Device ${device.name} joined ${sourceId} (${mode})`);
    return effective;
  }

  /** Replace one member's local overlay without changing shared source configuration. */
  async updateMemberConfig(
    sourceId: SourceId,
    deviceId: DeviceId,
    configOverride: Record<string, unknown>,
    pairingFence?: PairingGenerationFence,
  ): Promise<SourceRecord> {
    this.assertNoModeTransition(sourceId);
    const { db, writeGate: w, statusCache, notifySourceChange } = this.deps;
    const source = getSource(db, sourceId);
    if (!source) throw new HttpError(404, "SOURCE_NOT_FOUND", `source ${sourceId} not found`);
    if (!isSourceMember(db, sourceId, deviceId)) {
      throw new HttpError(409, "DEVICE_NOT_MEMBER", `device ${deviceId} does not host ${sourceId}`);
    }
    const device = getDevice(db, deviceId);
    if (!device) throw new HttpError(404, "DEVICE_NOT_FOUND", `device ${deviceId} not found`);
    this.assertModeSupport(device, source.type, this.modeFor(source));
    const memberScopedParams = this.memberConfigContractFor(source);
    this.assertMemberConfigContract(device, source.type, memberScopedParams);
    this.assertMemberConfigPlacement(
      device,
      {
        type: source.type,
        accountId: source.accountId,
        memberConfig: configOverride,
      },
      memberScopedParams,
    );
    if (
      !(await w.updateSourceMemberConfigOverride(
        sourceId,
        deviceId,
        configOverride,
        memberScopedParams,
        pairingFence,
      ))
    ) {
      this.assertNoModeTransition(sourceId);
      if (!getSource(db, sourceId)) {
        throw new HttpError(404, "SOURCE_NOT_FOUND", `source ${sourceId} not found`);
      }
      throw new HttpError(409, "DEVICE_NOT_MEMBER", `device ${deviceId} does not host ${sourceId}`);
    }
    statusCache.bump();
    const effective = this.sourceForMember(source, deviceId);
    notifySourceChange("source.updated", deviceId, { source: effective });
    return effective;
  }

  /**
   * The `sync_state` row a caller's cursor traffic is scoped to.
   *
   * An exclusive source keeps one shared row and no membership gate — phone
   * push sources register under singleton ids (`apple-health:local` and the
   * like), so a second phone shares the first one's row until its type
   * declares a mode. For a type that declares one, a device that contributes
   * sources may only touch the sources it hosts (owner or member), on its own
   * row when the mode keeps per-device cursors and on the shared row
   * otherwise. An operator identity — a token without a device, or a
   * cli/portal/agent device — always works on the shared row. Sources the
   * gateway has no row for yet are not gated: a push source registers on its
   * first ingest, and its cursor may arrive alongside.
   */
  cursorRowFor(sourceId: string, auth: { deviceId: DeviceId | null }): string {
    this.sourceWireAuthority([sourceId], auth)();
    const parsed = trySourceId(sourceId);
    const source = parsed ? getSource(this.deps.db, parsed) : null;
    if (!source) return "";
    this.assertNoModeTransition(source.id);
    if (!auth.deviceId) return "";
    const devices = this.deps.listDevices();
    const mode = this.modeFor(source);
    const device = devices.find((d) => d.id === auth.deviceId);
    if (!device || !SOURCE_HOSTING_DEVICE_KINDS.includes(device.kind)) return "";
    if (mode === "exclusive") {
      if (source.deviceId === device.id || isSourceMember(this.deps.db, source.id, device.id)) {
        this.assertSourceExecutionContract(device, source);
      }
      return "";
    }
    if (source.deviceId !== device.id && !isSourceMember(this.deps.db, source.id, device.id)) {
      throw new HttpError(403, "FORBIDDEN", `Forbidden: device does not host ${sourceId}`);
    }
    this.assertSourceExecutionContract(device, source);
    return hasPerDeviceCursor(mode) ? device.id : "";
  }

  /** Re-read after acquiring the data fence; a queued request may predate adoption. */
  sourceAccountAuthority(sourceId: string, auth: { deviceId: DeviceId | null }): () => void {
    const wireAuthority = this.sourceWireAuthority([sourceId], auth);
    return () => {
      wireAuthority();
      if (!auth.deviceId) return;
      const device = getDevice(this.deps.db, auth.deviceId);
      if (!device || !SOURCE_HOSTING_DEVICE_KINDS.includes(device.kind)) return;
      const source = getSource(this.deps.db, SourceId(sourceId));
      if (
        source &&
        source.deviceId !== device.id &&
        !isSourceMember(this.deps.db, source.id, device.id)
      ) {
        throw new HttpError(403, "FORBIDDEN", `Forbidden: device does not host ${sourceId}`);
      }
    };
  }

  /** Re-read after acquiring the data fence; a queued request may predate adoption. */
  sourceWireAuthority(
    sourceIds: readonly string[] | null,
    auth: { deviceId: DeviceId | null },
  ): () => void {
    return () => {
      if (!auth.deviceId) return;
      const device = getDevice(this.deps.db, auth.deviceId);
      if (!device || !SOURCE_HOSTING_DEVICE_KINDS.includes(device.kind)) return;
      const sources =
        sourceIds ??
        this.deps.db
          .prepare<[], { source_id: string }>("SELECT source_id FROM source_wire_contracts")
          .all()
          .map((row) => row.source_id);
      for (const sourceId of sources) {
        const floor = sourceWireFloor(this.deps.db, sourceId);
        if (!floor) continue;
        const parsed = sourceContractWireRangeSchema.safeParse(device.capabilities.sourceContract);
        if (parsed.success && parsed.data.min <= floor && parsed.data.max >= floor) continue;
        throw new HttpError(
          409,
          "SOURCE_WIRE_CONTRACT_UNSUPPORTED",
          `Upgrade this device before syncing ${sourceId}: the source has adopted a newer sync contract`,
          {
            sourceId,
            deviceId: device.id,
            minimumVersion: floor,
            remediation: SOURCE_WIRE_UPGRADE_REMEDIATION,
          },
        );
      }
    };
  }

  pendingStructuredPage(sourceId: string, auth: { deviceId: DeviceId | null }) {
    this.requireLeaseCaller(SourceId(sourceId), auth);
    const page = getPendingSourcePage(this.deps.db, sourceId, this.cursorRowFor(sourceId, auth));
    return page ? { ...page.payload, id: page.id, cursorCommitted: page.cursorCommitted } : null;
  }

  async prepareStructuredPage(
    sourceId: string,
    input: Omit<PreparePendingSourcePage, "sourceId" | "cursorRow" | "deviceId">,
    auth: { deviceId: DeviceId | null },
  ) {
    const { deviceId } = this.requireLeaseCaller(SourceId(sourceId), auth);
    const cursorRow = this.cursorRowFor(sourceId, auth);
    const prepare = async () => {
      this.requireLeaseCaller(SourceId(sourceId), auth);
      const page = await this.deps.writeGate.preparePendingSourcePage({
        ...input,
        sourceId,
        cursorRow,
        deviceId,
      });
      if (!page) throw new ConflictError("This sync attempt was superseded; retry the source");
      return { ...page.payload, id: page.id, cursorCommitted: page.cursorCommitted };
    };
    return this.deps.sourceWriteEpochFence
      ? this.deps.sourceWriteEpochFence.run(epochScope(sourceId, cursorRow), prepare)
      : prepare();
  }

  async acknowledgeStructuredPage(
    sourceId: string,
    input: { id: string; writeEpoch: number },
    auth: { deviceId: DeviceId | null },
  ) {
    const { deviceId } = this.requireLeaseCaller(SourceId(sourceId), auth);
    const cursorRow = this.cursorRowFor(sourceId, auth);
    const acknowledge = () => {
      this.requireLeaseCaller(SourceId(sourceId), auth);
      return this.deps.writeGate.acknowledgePendingSourcePage({
        ...input,
        sourceId,
        cursorRow,
        deviceId,
      });
    };
    const acknowledged = this.deps.sourceWriteEpochFence
      ? await this.deps.sourceWriteEpochFence.run(epochScope(sourceId, cursorRow), acknowledge)
      : await acknowledge();
    return { acknowledged };
  }

  assertPendingStructuredPage(
    sourceId: string,
    id: string,
    auth: { deviceId: DeviceId | null },
  ): void {
    const page = this.pendingStructuredPage(sourceId, auth);
    if (!page || page.id !== id)
      throw new ConflictError("Pending source page was cancelled or superseded; restart the sync");
  }

  /** Adoption fences older attempts while preserving all cursors and documents. */
  async adoptSourceWireContract(
    sourceId: string,
    auth: { deviceId: DeviceId | null },
  ): Promise<void> {
    this.cursorRowFor(sourceId, auth);
    if (!auth.deviceId) return;
    const device = getDevice(this.deps.db, auth.deviceId);
    const range = sourceContractWireRangeSchema.safeParse(device?.capabilities.sourceContract);
    if (
      device?.kind !== "collector" ||
      !range.success ||
      range.data.min > SOURCE_CONTRACT_WIRE_VERSION ||
      range.data.max < SOURCE_CONTRACT_WIRE_VERSION
    )
      return;
    const source = getSource(this.deps.db, SourceId(sourceId));
    if (
      !source ||
      (source.deviceId !== device.id && !isSourceMember(this.deps.db, source.id, device.id))
    )
      return;
    if (sourceWireFloor(this.deps.db, sourceId) >= SOURCE_CONTRACT_WIRE_VERSION) return;
    const adopt = async () => {
      this.cursorRowFor(sourceId, auth);
      await this.deps.writeGate.promoteSourceWireContract(sourceId, SOURCE_CONTRACT_WIRE_VERSION);
      this.releaseIncompatibleWireLease(sourceId);
    };
    if (this.deps.sourceWriteEpochFence)
      await this.deps.sourceWriteEpochFence.runSourceExclusive(sourceId, adopt);
    else await adopt();
  }

  /** Also checked on claims: an incumbent can downgrade after adoption. */
  private releaseIncompatibleWireLease(sourceId: string): void {
    const holder = this.deps.syncLease?.holderOf(sourceId);
    if (!holder) return;
    try {
      this.sourceWireAuthority([sourceId], { deviceId: holder.deviceId })();
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== "SOURCE_WIRE_CONTRACT_UNSUPPORTED")
        throw error;
      this.deps.syncLease?.release(sourceId, holder.deviceId);
    }
  }

  /**
   * A member that leaves the source — or every device, on a re-home — no
   * longer speaks for its rows: an absence its snapshots earned must not
   * become its verdict when swept. The SQLite plane is cleared inside the
   * membership write; the row-absence store is a separate database, and a
   * failure there leaves an attribution the sweep will treat as a verdict,
   * so it is logged rather than allowed to undo the membership change.
   */
  private async forgetAnalyticsObserver(sourceId: SourceId, deviceId?: DeviceId): Promise<void> {
    try {
      await this.deps.sourceDataRemoval.forgetAbsenceObserver(sourceId, deviceId);
    } catch (error) {
      log.warn(
        `Could not detach ${deviceId ?? "every device"} from the row absences of ${sourceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Detach a device from a source. The other members stay; ownership passes
   * to the oldest remaining member when the owner leaves, and the last
   * member cannot leave (removing the source is a separate act). The
   * documents stay too, except on a partitioned source, where the detached
   * device's stream is its contribution alone and goes with it. The detached
   * collector gets a fresh member-scoped snapshot, which unregisters its
   * instance without deleting anything on its side; a push device is told
   * the source is gone for it.
   *
   * Membership, cursor retirement, write fencing, and the durable cleanup
   * journal land in one writer transaction. Cleanup follows from that
   * authority change and retries independently, so a cross-store failure
   * can leave only unowned data awaiting deletion — never a live member with
   * erased history and its old cursor.
   */
  async detachSource(
    sourceId: SourceId,
    deviceId: DeviceId,
    pairingFence?: PairingGenerationFence,
  ): Promise<{ source: SourceRecord; members: DeviceId[] } | null> {
    this.assertNoModeTransition(sourceId);
    const { db, writeGate: w, statusCache, syncStatus, notifySourceChange } = this.deps;
    const refused = sourceMemberDetachRefusal(db, sourceId, deviceId);
    if (refused) return this.refuseDetach(refused, sourceId, deviceId);
    if (!getSource(db, sourceId)) return null;
    const result = await this.withLeaseMutation(sourceId, async () => {
      const source = getSource(db, sourceId);
      if (source && this.modeFor(source) === "partitioned") {
        await this.deps.sourceDataRemoval.prepareSourceRemoval(sourceId, deviceId);
      }
      const removed = await w.removeSourceMember(sourceId, deviceId, pairingFence);
      if (removed.removed) this.deps.syncLease?.release(sourceId, deviceId);
      return removed;
    });
    // A refusal here lost a race with a concurrent detach or removal.
    if (!result.removed) return this.refuseDetach(result, sourceId, deviceId);
    statusCache.bump();
    syncStatus?.removeMember(sourceId, deviceId);
    await this.forgetAnalyticsObserver(sourceId, deviceId);
    if (getDevice(db, deviceId)?.kind === "collector") {
      this.pushSourcesSnapshotTo(deviceId);
    } else {
      notifySourceChange("source.removed", deviceId, { sourceId });
    }
    const members = this.membersOf(result.record).filter((d) => d !== deviceId);
    // A hand-over changes the record every remaining member holds.
    if (result.ownerReassignedTo) {
      this.notifyMembers(result.record);
    }
    if (result.streamCleanup) await this.streamCleanup.cleanup(result.streamCleanup);
    log.info(
      `Device ${deviceId} detached from ${sourceId}` +
        (result.ownerReassignedTo ? ` — owner is now ${result.ownerReassignedTo}` : "") +
        ` (${members.length} member(s) left)`,
    );
    return { source: result.record, members };
  }

  /** Map a detach refusal to the caller's outcome: null for a missing source, a 409 otherwise. */
  private refuseDetach(
    refusal: SourceMemberDetachRefusal,
    sourceId: SourceId,
    deviceId: DeviceId,
  ): null {
    const reason = refusal.reason;
    switch (reason) {
      case "not-found":
        return null;
      case "last-member":
        throw new HttpError(
          409,
          "LAST_MEMBER",
          `device ${deviceId} is the last host of ${sourceId} — to stop syncing it, remove the source: omnesis sources remove ${sourceId}`,
        );
      case "transition-pending":
        throw new HttpError(
          409,
          "SOURCE_MODE_TRANSITION_IN_PROGRESS",
          `source ${sourceId} has a mode transition in progress`,
        );
      case "not-member":
        throw new HttpError(
          409,
          "DEVICE_NOT_MEMBER",
          `device ${deviceId} does not host ${sourceId}`,
        );
      default:
        return assertNever(reason);
    }
  }

  /** Stop scheduling retries. Called on shutdown; sweeps in flight are not interrupted. */
  dispose(): void {
    this.streamCleanup.dispose();
    this.modeTransition?.dispose();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  listSourcesForAdmin(opts: { deviceId?: DeviceId } = {}): AdminSourceListEntry[] {
    const { statusCache, listDevices } = this.deps;
    const membersById = listAllSourceMembers(this.deps.db);
    const transitionsById = new Map(
      listPendingSourceModeTransitions(this.deps.db).map((transition) => [
        transition.sourceId,
        transition,
      ]),
    );
    const membersOf = (s: SourceRecord): DeviceId[] => [
      s.deviceId,
      ...(membersById.get(s.id) ?? []).filter((d) => d !== s.deviceId),
    ];
    const member = opts.deviceId;
    const sources = member
      ? statusCache.listSources.filter((s) => membersOf(s).includes(member))
      : statusCache.listSources;
    const devices = listDevices();
    // Across a source's rows (one per member for per-device-cursor modes)
    // the latest sync stands for the source.
    const lastSyncByKey = new Map<string, string | null>();
    for (const s of statusCache.listSyncStates) {
      const prev = lastSyncByKey.get(s.source_id) ?? null;
      const next = s.last_synced_at ?? null;
      if (prev === null || (next !== null && next > prev)) lastSyncByKey.set(s.source_id, next);
    }
    const pushHostById = new Map<string, boolean>();
    const pushTypesByDeviceId = new Map<string, Set<string>>();
    for (const d of devices) {
      pushHostById.set(d.id, d.kind === "ios" || d.kind === "android" || d.kind === "browser");
      const pushTypes = Array.isArray(d.capabilities.pushBasedSourceTypes)
        ? d.capabilities.pushBasedSourceTypes.flatMap((s) => {
            const sourceType = trySourceType(s);
            return sourceType ? [sourceType] : [];
          })
        : [];
      pushTypesByDeviceId.set(d.id, new Set(pushTypes));
    }
    const paired = devices.filter((d) => d.revokedAt === null);
    const joinCandidatesOf = (s: SourceRecord, members: DeviceId[]): DeviceId[] => {
      const mode = this.modeFor(s);
      if (mode === "exclusive") return [];
      const expectedMemberConfig = getSourceMemberConfigContract(this.deps.db, s.id);
      const allMembersSupport = members.every((id) => {
        const device = devices.find((candidate) => candidate.id === id);
        return device
          ? this.deviceSupportsPersistedSourceContract(device, s, expectedMemberConfig)
          : false;
      });
      if (!allMembersSupport) return [];
      return paired
        .filter(
          (d) =>
            !members.includes(d.id) &&
            deviceCanHostType(d, s.type) &&
            this.deviceSupportsPersistedSourceContract(d, s, expectedMemberConfig),
        )
        .map((d) => d.id);
    };
    const disputedById = countDisputedBySource(this.deps.db);
    return sources.map((s) => {
      const members = membersOf(s);
      const transition = transitionsById.get(s.id);
      return {
        ...s,
        lastSyncedAt: lastSyncByKey.get(s.id) ?? null,
        members,
        multiDeviceMode: this.modeFor(s),
        leaseHolder: liveHolder(this.deps.syncLease?.holderOf(s.id)),
        disputedDeletions: disputedById.get(s.id) ?? 0,
        joinCandidates: joinCandidatesOf(s, members),
        pushBased:
          (pushHostById.get(s.deviceId) ?? false) ||
          (pushTypesByDeviceId.get(s.deviceId)?.has(s.type) ?? false),
        modeTransition: transition
          ? {
              fromMode: transition.fromMode,
              toMode: transition.toMode,
              preparedAt: transition.preparedAt,
              lastError: transition.lastError,
            }
          : null,
      };
    });
  }

  /**
   * Create a source via the admin API path (POST /admin/sources). The
   * caller has already validated the payload's required fields.
   *
   * Rejects with `400 DEVICE_CANNOT_HOST_TYPE` when the target device
   * has declared `capabilities.hostableSourceTypes` and the requested
   * type isn't in it. Permissive when capabilities are undeclared —
   * see `deviceAdvertisesType` in server.ts for the same convention.
   */
  async createSource(input: {
    type: SourceType;
    accountId: AccountId;
    deviceId: DeviceId;
    /** See `SourceRecord.account`. Absent when the source declares nothing. */
    account?: AccountDescriptor | null;
    config?: Record<string, unknown>;
    enabled?: boolean;
    pairingFence?: PairingGenerationFence;
  }): Promise<SourceRecord> {
    const {
      db,
      writeGate: w,
      statusCache,
      syncStatus,
      syncSourceSettingsToConfig,
      notifySourceChange,
    } = this.deps;
    const sourceId = SourceId(`${input.type}:${input.accountId}`);
    this.assertRemovalFinished(sourceId);
    const requester = getDevice(db, input.deviceId);
    if (requester?.revokedAt) {
      throw new HttpError(
        409,
        "DEVICE_REVOKED",
        `device "${requester.name}" is revoked — pair it again to reclaim it, or forget it`,
      );
    }
    // Fast pre-check; the authoritative ownership check re-runs on the
    // record the writer returns, so a racing concurrent create can't slip
    // an adoption through this gap.
    const existing = getSource(db, sourceId);
    if (existing) this.assertNoModeTransition(sourceId);
    if (existing && existing.deviceId !== input.deviceId) {
      // A source several devices may serve: the add is a join, and the
      // owner's config stays the source's config — the joiner's is not applied.
      if (this.modeFor(existing) !== "exclusive") {
        return this.joinSource(sourceId, input.deviceId, undefined, input.pairingFence);
      }
      const hostKind = getDevice(db, existing.deviceId)?.kind;
      const requesterKind = getDevice(db, input.deviceId)?.kind;
      if (hostKind === "collector" || requesterKind === "collector") {
        throw this.alreadyHostedError(sourceId, existing.deviceId);
      }
      // Push-device re-home. A replacement phone paired under a NEW name
      // (same-name re-pair keeps the device id and never lands here)
      // re-registers its push sources through this endpoint; refusing
      // would strand them on the dead phone's device row with no
      // user-visible signal. Collectors are excluded on both sides —
      // that's the cursor-racing case the refusal above exists for.
      const memberScopedParams = this.memberConfigContractFor(existing);
      if (requester) {
        this.assertMemberConfigContract(requester, existing.type, memberScopedParams);
      }
      const moved = await w.moveSource(sourceId, {
        deviceId: input.deviceId,
        memberScopedParams,
        pairingFence: input.pairingFence,
      });
      if (!moved) {
        this.assertRemovalFinished(sourceId);
        throw new HttpError(409, "SOURCE_REMOVAL_IN_PROGRESS", `source ${sourceId} is unavailable`);
      }
      statusCache.bump();
      for (const loser of moved.displacedDeviceIds) {
        syncStatus?.removeMember(moved.record.id, loser);
      }
      syncStatus?.clearTombstone(moved.record.id);
      await syncSourceSettingsToConfig(moved.record.id, moved.record.config);
      notifySourceChange("source.added", moved.record.deviceId, { source: moved.record });
      log.info(
        `Push source re-homed: ${sourceId} — device ${moved.previousDeviceId} → ${moved.record.deviceId}`,
      );
      return moved.record;
    }
    const host = getDevice(db, input.deviceId);
    if (host && !deviceCanHostType(host, input.type)) {
      throw cannotHostTypeError(host, input.type);
    }
    const persistedContract = existing ? getSourceMemberConfigContract(db, existing.id) : null;
    const memberScopedParams =
      persistedContract ??
      (host ? (advertisedMemberScopedParamNames(host, input.type) ?? undefined) : []);
    if (host) {
      this.assertMemberConfigPlacement(
        host,
        { type: input.type, accountId: input.accountId, config: input.config },
        memberScopedParams,
      );
    }
    const source = await w.createSource({
      ...input,
      memberScopedParams,
      ...this.initialContractFor(input.type, input.deviceId),
    });
    if (!source) {
      this.assertRemovalFinished(sourceId);
      throw new HttpError(409, "SOURCE_REMOVAL_IN_PROGRESS", `source ${sourceId} is unavailable`);
    }
    if (source.deviceId !== input.deviceId) {
      // The pre-check above raced a concurrent create: the write is
      // create-or-get, so the row that came back belongs to whoever won.
      // Without this the loser would get a 200 claiming a source another
      // device owns — and mirror its config over the winner's.
      if (this.modeFor(source) !== "exclusive") {
        return this.joinSource(sourceId, input.deviceId, undefined, input.pairingFence);
      }
      throw this.alreadyHostedError(sourceId, source.deviceId);
    }
    statusCache.bump();
    syncStatus?.clearTombstone(source.id);
    // The writer atomically clears a completed tombstone while creating the
    // row; a pending removal returns null above.
    await syncSourceSettingsToConfig(source.id, source.config);
    notifySourceChange("source.added", source.deviceId, { source });
    log.info(`Source created: ${source.id} → device ${source.deviceId}`);
    return source;
  }

  /**
   * Clear removal tombstones for every source TYPE a device can host. Called
   * on (re-)pairing: a push source (browser) survives "Remove" with its token
   * intact, so re-pairing the device is the user's explicit "resume" — it must
   * lift the tombstone so the next push re-registers the source. Matches by
   * source type (the tombstone is keyed by full id; a device advertises types),
   * so it covers `browser`, `apple-health:local`, `health-connect:local`, etc.
   */
  async clearRemovedForDeviceTypes(hostableTypes: readonly string[]): Promise<void> {
    if (hostableTypes.length === 0) return;
    const { db, writeGate: w } = this.deps;
    const types = new Set(hostableTypes);
    for (const removedId of listRemovedSources(db)) {
      if (
        types.has(parseSourceId(removedId).sourceType) &&
        (await w.clearSourceRemovedIfCleanupDone(removedId))
      ) {
        log.info(`Removal tombstone cleared on pairing: ${removedId}`);
      }
    }
  }

  /**
   * Classify a batch of push sourceIds into those allowed to ingest and those
   * rejected (removed or paused). The authoritative gate for push clients,
   * shared by `POST /documents` and `POST /analytics/ingest`.
   *
   * A `write:*` token (the collector) bypasses pause checks, but never a
   * removal tombstone. This keeps legacy document/analytics endpoints from
   * resurrecting data after an operator removes a pull source.
   */
  gatePush(
    sourceIds: readonly string[],
    auth: { scopes: readonly Scope[] },
  ): { allowed: Set<string>; rejected: PushRejection[] } {
    const { db } = this.deps;
    const broadWriter = scopeSatisfies(auth.scopes, SCOPE_WRITE_ALL);
    const allowed = new Set<string>();
    const rejected: PushRejection[] = [];
    const seen = new Set<string>();
    for (const sid of sourceIds) {
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      // The ingest body schema admits any non-empty string as a `sourceId`,
      // and the write-scope check ahead of this one returns early for a broad
      // writer without parsing it — so a malformed id arrives here intact.
      // Classified as the client's mistake: the branding constructor throws an
      // error this layer would not otherwise classify, and the top-level
      // handler turns an unclassified throw into a sanitized 500 and an
      // "unhandled error" in the journal — a client mistake reported as a
      // gateway fault, and reported to the client as nothing at all.
      const id = trySourceId(sid);
      if (!id) throw new BadRequestError(`Invalid sourceId: ${sid}`);
      if (isSourceRemoved(db, id)) {
        rejected.push({ sourceId: sid, reason: "removed" });
        continue;
      }
      if (broadWriter) {
        allowed.add(sid);
        continue;
      }
      const existing = getSource(db, id);
      if (existing && !existing.enabled) {
        rejected.push({ sourceId: sid, reason: "paused" });
        continue;
      }
      allowed.add(sid);
    }
    return { allowed, rejected };
  }

  /**
   * Register a push source's `sources` row on first ingest.
   *
   * Pull sources get their row from the collector's bulk-upsert. A push
   * source (the browser extension, the iOS app hosting Apple Health)
   * instead authenticates with a SCOPED write token (`write:<type>`, never
   * `write:*` like the collector) and POSTs documents directly — so nothing
   * ever creates its row, and the source has data yet stays invisible in the
   * sources list / portal. This generalises what the iOS app does explicitly
   * for `apple-health:local`: any scoped push token that ingests a
   * not-yet-registered source self-registers it, tied to the pushing device,
   * so it surfaces automatically the moment data flows.
   *
   * No-op when the caller holds `write:*` (the collector owns its sources via
   * bulk-upsert), the token carries no device, the token lacks `write:<type>`
   * for the row, or the row already exists. Idempotent — safe per request.
   */
  async ensurePushSourcesRegistered(
    sourceIds: readonly string[],
    auth: { deviceId?: DeviceId | null; scopes: readonly Scope[] },
  ): Promise<void> {
    if (!auth.deviceId || scopeSatisfies(auth.scopes, SCOPE_WRITE_ALL)) return;
    const { db, writeGate: w, statusCache, syncStatus, notifySourceChange } = this.deps;
    const deviceId = auth.deviceId;
    const seen = new Set<string>();
    for (const rawId of sourceIds) {
      if (!rawId || seen.has(rawId)) continue;
      seen.add(rawId);
      const id = SourceId(rawId);
      const existing = getSource(db, id);
      if (existing) {
        // A second contributor to a source several devices may serve joins
        // it on its first push; an exclusive source's row is left alone.
        if (
          existing.deviceId !== deviceId &&
          !isSourceMember(db, id, deviceId) &&
          this.modeFor(existing) !== "exclusive" &&
          scopeSatisfies(auth.scopes, writeScope(existing.type))
        ) {
          await this.joinSource(id, deviceId, undefined, undefined, false);
        }
        continue;
      }
      // Never resurrect a source the user explicitly removed. The ingest
      // handler already filters these out via `gatePush`; this is the
      // defense-in-depth backstop so no code path can silently re-create one.
      if (isSourceRemoved(db, id)) continue;
      const { sourceType, accountId } = parseSourceId(id);
      // Only register a type this token is actually allowed to write.
      if (!scopeSatisfies(auth.scopes, writeScope(sourceType))) continue;
      const rec = await w.createSourceWithId(id, {
        type: SourceType(sourceType),
        accountId: AccountId(accountId),
        deviceId,
        config: {},
        enabled: true,
        memberScopedParams: [],
        ...this.initialContractFor(SourceType(sourceType), deviceId),
      });
      if (rec) {
        statusCache.bump();
        syncStatus?.clearTombstone(rec.id);
        notifySourceChange("source.added", rec.deviceId, { source: rec });
        log.info(`Push source auto-registered on ingest: ${rec.id} → device ${rec.deviceId}`);
      }
    }
  }

  /**
   * Collector-side bulk upsert (POST /devices/sources/bulk-upsert). Each
   * entry is independently validated; failures are collected and returned
   * alongside successes so the collector can attribute partial failure.
   */
  async bulkUpsertForDevice(
    deviceId: DeviceId,
    entries: BulkUpsertEntry[],
    pairingFence?: PairingGenerationFence,
  ): Promise<BulkUpsertResult> {
    const {
      db,
      writeGate: w,
      statusCache,
      syncStatus,
      syncSourceSettingsToConfig,
      notifySourceChange,
    } = this.deps;
    const created: Array<{ id: string; updated: boolean; memberConfigApplied?: boolean }> = [];
    const errors: Array<{ entry: unknown; error: string }> = [];
    const caller = getDevice(db, deviceId);
    if (!caller) throw new HttpError(404, "DEVICE_NOT_FOUND", `device ${deviceId} not found`);
    for (const entry of entries) {
      if (entry.type && entry.accountId) {
        const id = trySourceId(entry.id ?? `${entry.type}:${entry.accountId}`);
        if (id) this.assertRemovalFinished(id);
      }
    }
    for (const s of entries) {
      if (!s.type || typeof s.type !== "string") {
        errors.push({ entry: s, error: "type required" });
        continue;
      }
      if (!s.accountId || typeof s.accountId !== "string") {
        errors.push({ entry: s, error: "accountId required" });
        continue;
      }
      try {
        const explicitId = s.id ? SourceId(s.id) : SourceId(`${s.type}:${s.accountId}`);
        const before = getSource(db, explicitId);
        const storedMemberScopedParams = before
          ? getSourceMemberConfigContract(db, before.id)
          : null;
        const memberScopedParams = before
          ? (storedMemberScopedParams ??
            (before.multiDeviceMode === "exclusive"
              ? undefined
              : this.memberConfigContractFor(before)))
          : (advertisedMemberScopedParamNames(caller, SourceType(s.type)) ?? undefined);
        this.assertModeSupport(
          caller,
          SourceType(s.type),
          before?.multiDeviceMode ?? resolveDeviceMultiDeviceMode(caller, SourceType(s.type)),
        );
        if (before && memberScopedParams !== undefined) {
          this.assertMemberConfigContract(caller, before.type, memberScopedParams);
        }
        this.assertMemberConfigPlacement(caller, s, memberScopedParams);
        if (before) this.assertNoModeTransition(explicitId);
        let rec: SourceRecord | null;
        if (before && before.deviceId !== deviceId) {
          // Same account, second collector. For a source several devices
          // may serve this is a join (a member that is already in stays
          // in; the owner's config remains the shared truth). For an
          // exclusive source, adopting the row here would be a silent steal,
          // so reject the entry; moving a source is `omnesis sources move`.
          if (isSourceMember(db, explicitId, deviceId)) {
            await this.joinSource(explicitId, deviceId, s.memberConfig, pairingFence);
          } else if (this.modeFor(before) !== "exclusive") {
            await this.joinSource(explicitId, deviceId, s.memberConfig, pairingFence);
          } else {
            errors.push({
              entry: s,
              error: this.alreadyHostedError(explicitId, before.deviceId).message,
            });
            continue;
          }
          created.push({
            id: before.id,
            updated: false,
            ...(s.memberConfig !== undefined ? { memberConfigApplied: true } : {}),
          });
          continue;
        }
        if (before) {
          // Conditional on ownership inside the write transaction: if a
          // concurrent re-home moved the row after the read above, nothing
          // is written and the actual owner comes back for the check below.
          if (s.memberConfig !== undefined) {
            rec = await w.updateSourceForMember(
              explicitId,
              deviceId,
              { config: s.config, enabled: s.enabled },
              s.memberConfig,
              memberScopedParams!,
              pairingFence,
            );
          } else {
            const moved = await w.moveSource(explicitId, {
              config: s.config,
              enabled: s.enabled,
              expectDeviceId: deviceId,
              memberScopedParams,
              pairingFence,
            });
            rec = moved?.record ?? null;
          }
        } else if (s.id) {
          rec = await w.createSourceWithId(explicitId, {
            type: SourceType(s.type),
            accountId: AccountId(s.accountId),
            deviceId,
            config: s.config,
            memberConfigOverride: s.memberConfig,
            memberScopedParams,
            account: s.account,
            enabled: s.enabled,
            ...this.initialContractFor(SourceType(s.type), deviceId),
            pairingFence,
          });
        } else {
          rec = await w.createSource({
            type: SourceType(s.type),
            accountId: AccountId(s.accountId),
            deviceId,
            config: s.config,
            memberConfigOverride: s.memberConfig,
            memberScopedParams,
            account: s.account,
            enabled: s.enabled,
            ...this.initialContractFor(SourceType(s.type), deviceId),
            pairingFence,
          });
        }
        if (!rec) throw new Error(`source ${explicitId} is being removed`);
        if (rec.deviceId !== deviceId) {
          // The pre-check raced a concurrent create or re-home: the row
          // that came back belongs to another device (the conditional
          // update and create-or-get both leave foreign rows untouched).
          // Reporting success here would claim a source this caller
          // doesn't own — and mirror its config over the owner's.
          if (this.modeFor(rec) !== "exclusive") {
            if (
              !(await w.addSourceMember(
                explicitId,
                deviceId,
                s.memberConfig,
                memberScopedParams,
                pairingFence,
              ))
            ) {
              throw new Error(`source ${explicitId} is being removed`);
            }
            statusCache.bump();
            syncStatus?.clearTombstone(rec.id);
            const effective = this.sourceForMember(rec, deviceId);
            notifySourceChange("source.added", deviceId, { source: effective });
            created.push({
              id: rec.id,
              updated: false,
              ...(s.memberConfig !== undefined ? { memberConfigApplied: true } : {}),
            });
            log.info(
              `Device ${deviceId} joined ${explicitId} (${this.modeFor(rec)}) after add race`,
            );
            continue;
          }
          errors.push({
            entry: s,
            error: this.alreadyHostedError(explicitId, rec.deviceId).message,
          });
          continue;
        }
        created.push({
          id: rec.id,
          updated: !!before,
          ...(s.memberConfig !== undefined ? { memberConfigApplied: true } : {}),
        });
        statusCache.bump();
        syncStatus?.clearTombstone(rec.id);
        if (before) this.notifyMembers(rec);
        // Create operations atomically clear completed tombstones; updates
        // never race a separate tombstone-clear write.
        // Mirror per-source settings to ~/.config/omnesis/omnesis.json so
        // the file stays in lockstep with the DB row's `config` column.
        // Sources whose required `params` live in the file (e.g. the
        // vault path for note sources, the phone number for chat-import
        // sources) depend on this — without it, reconcileConfig prunes
        // those params on the next gateway restart and the source can't
        // instantiate.
        await syncSourceSettingsToConfig(rec.id, rec.config);
      } catch (err) {
        if (isStalePairingWriteError(err)) throw err;
        errors.push({ entry: s, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { count: created.length, sources: created, errors };
  }

  /**
   * Update a source (PATCH /admin/sources/:id). Returns null when the
   * source isn't found so the caller can map to 404.
   */
  async updateSource(
    id: SourceId,
    patch: {
      config?: Record<string, unknown>;
      enabled?: boolean;
      deviceId?: DeviceId;
      multiDeviceMode?: MultiDeviceMode;
      pairingFence?: PairingGenerationFence;
    },
  ): Promise<SourceRecord | null> {
    const {
      db,
      writeGate: w,
      statusCache,
      syncStatus,
      syncSourceSettingsToConfig,
      notifySourceChange,
    } = this.deps;
    const current = getSource(db, id);
    if (patch.multiDeviceMode !== undefined && patch.multiDeviceMode !== current?.multiDeviceMode) {
      if (!current) return null;
      if (
        patch.config !== undefined ||
        patch.enabled !== undefined ||
        patch.deviceId !== undefined
      ) {
        throw new HttpError(
          400,
          "MODE_TRANSITION_MUST_BE_ISOLATED",
          "change multiDeviceMode in a separate request from config, enabled, or deviceId",
        );
      }
      if (
        current.multiDeviceMode !== "exclusive" ||
        (patch.multiDeviceMode !== "partitioned" && patch.multiDeviceMode !== "replicated")
      ) {
        throw new HttpError(
          409,
          "SOURCE_MODE_TRANSITION_UNSUPPORTED",
          `source mode transition ${current.multiDeviceMode} → ${patch.multiDeviceMode} is not supported`,
          { fromMode: current.multiDeviceMode, toMode: patch.multiDeviceMode },
        );
      }
      const owner = getDevice(db, current.deviceId);
      if (owner && owner.revokedAt !== null) {
        throw new HttpError(
          409,
          "DEVICE_REVOKED",
          `device "${owner.name}" is revoked — pair it again to reclaim it, or forget it`,
        );
      }
      if (owner) this.assertModeSupport(owner, current.type, patch.multiDeviceMode);
      const memberScopedParams = this.memberConfigContractFor(current);
      if (owner) this.assertMemberConfigContract(owner, current.type, memberScopedParams);
      if (!this.modeTransition) {
        throw new ServiceUnavailableError("source mode transition adoption is unavailable");
      }
      try {
        await this.modeTransition.transition(
          id,
          patch.multiDeviceMode,
          current.deviceId,
          memberScopedParams,
          this.initialReplicaVersionPolicyFor(
            current.type,
            current.deviceId,
            patch.multiDeviceMode,
          ),
          patch.pairingFence,
        );
      } catch (error) {
        if (error instanceof SourceModeTransitionPrepareError) {
          throw this.modeTransitionPrepareError(error);
        }
        throw error;
      }
      return getSource(db, id)!;
    }
    this.assertNoModeTransition(id);
    let validatedMemberScopedParams: readonly string[] | undefined;
    if (patch.config !== undefined && current) {
      const owner = getDevice(db, current.deviceId);
      const memberScopedParams = getSourceMemberConfigContract(db, current.id);
      if (owner && memberScopedParams) {
        this.assertMemberConfigPlacement(
          owner,
          { type: current.type, accountId: current.accountId, config: patch.config },
          memberScopedParams,
        );
        validatedMemberScopedParams = memberScopedParams;
      }
    }
    const mutablePatch: {
      config?: Record<string, unknown>;
      enabled?: boolean;
      deviceId?: DeviceId;
      memberScopedParams?: readonly string[];
      pairingFence?: PairingGenerationFence;
    } = {
      config: patch.config,
      enabled: patch.enabled,
      deviceId: patch.deviceId,
      memberScopedParams: validatedMemberScopedParams,
      pairingFence: patch.pairingFence,
    };
    if (patch.deviceId !== undefined) {
      // A deviceId patch is the explicit re-home path, so it validates the
      // target the way a join does: the device must exist, be paired, and
      // be able to host the source's type. Without this a well-formed-but-
      // wrong deviceId would move the source into the void — losing
      // collector torn down, gaining device nonexistent.
      const target = getDevice(db, patch.deviceId);
      if (!target) {
        throw new HttpError(404, "DEVICE_NOT_FOUND", `device ${patch.deviceId} not found`);
      }
      if (target.revokedAt !== null) {
        throw new HttpError(
          409,
          "DEVICE_REVOKED",
          `device "${target.name}" is revoked — pair it again to reclaim it, or forget it`,
        );
      }
      const source = getSource(db, id);
      if (isSourceStreamCleanupPending(db, id, patch.deviceId)) {
        throw new HttpError(
          409,
          "SOURCE_STREAM_CLEANUP_IN_PROGRESS",
          `device ${patch.deviceId} is still being detached from ${id}; retry after cleanup finishes`,
        );
      }
      if (source && !deviceCanHostType(target, source.type)) {
        throw cannotHostTypeError(target, source.type);
      }
      if (source) {
        this.assertModeSupport(target, source.type, source.multiDeviceMode);
        const memberScopedParams = this.memberConfigContractFor(source);
        this.assertMemberConfigContract(target, source.type, memberScopedParams);
        mutablePatch.memberScopedParams = memberScopedParams;
      }
    }
    // A move re-seats the whole membership on the target: every other
    // member loses the source, so they are read before the write and torn
    // down after it.
    const before = patch.deviceId !== undefined ? getSource(db, id) : null;
    const formerMembers = before ? this.membersOf(before) : [];
    // The move and every losing partition's durable cleanup job commit
    // together. `moveSource` reads the displaced set inside that transaction,
    // so a join that lands after the preliminary read is fenced and queued too.
    const move = async () => {
      const current = getSource(db, id);
      if (
        patch.deviceId !== undefined &&
        current &&
        current.deviceId !== patch.deviceId &&
        this.modeFor(current) === "partitioned"
      ) {
        // Check all existing streams, not a preliminary member roster: a join
        // can race the writer's displaced-member transaction. The source fence
        // blocks new ingests until authority has moved. This conservatively
        // includes the retained destination stream, without guessing ownership.
        await this.deps.sourceDataRemoval.prepareSourceRemoval(id);
      }
      return w.moveSource(id, mutablePatch);
    };
    const moved =
      patch.deviceId === undefined ? await move() : await this.withLeaseMutation(id, move);
    if (!moved) {
      this.assertNoModeTransition(id);
      if (patch.deviceId !== undefined && isSourceStreamCleanupPending(db, id, patch.deviceId)) {
        throw new HttpError(
          409,
          "SOURCE_STREAM_CLEANUP_IN_PROGRESS",
          `device ${patch.deviceId} is still being detached from ${id}; retry after cleanup finishes`,
        );
      }
      return null;
    }
    const updated = moved.record;
    statusCache.bump();
    if (moved.previousDeviceId !== updated.deviceId) {
      await this.forgetAnalyticsObserver(id);
      // Explicit re-home (PATCH deviceId). The gaining device learns the
      // source as an add unless it already hosted it as a member. Every
      // device that lost the source gets a fresh per-device snapshot: that
      // unregisters its instance and stops its sync loop without touching
      // documents or on-disk credentials (unlike `source.removed`, whose
      // collector handler deletes data).
      if (!formerMembers.includes(updated.deviceId)) {
        notifySourceChange("source.added", updated.deviceId, {
          source: this.sourceForMember(updated, updated.deviceId),
        });
      }
      const losers = new Set(moved.displacedDeviceIds);
      losers.delete(updated.deviceId);
      for (const loser of losers) {
        syncStatus?.removeMember(id, loser);
        this.pushSourcesSnapshotTo(loser);
      }
      await Promise.all(moved.streamCleanups.map((job) => this.streamCleanup.cleanup(job)));
      const from = getDevice(db, moved.previousDeviceId);
      const to = getDevice(db, updated.deviceId);
      log.info(
        `Source moved: ${id} — ${from?.name ?? moved.previousDeviceId} → ${to?.name ?? updated.deviceId}`,
      );
    } else {
      this.notifyMembers(updated);
    }
    if (patch.config !== undefined) {
      await syncSourceSettingsToConfig(id, updated.config);
    }
    return updated;
  }

  /**
   * Start a source over (POST /admin/sources/:id/resync). Without a device
   * the whole source is wiped — every document, row and cursor — and a sync
   * is triggered wherever "Sync now" would reach. With a device, which must
   * be a member of a source whose members sync on their own cursors, only
   * that device starts over: on a partitioned source its stream is wiped
   * with its cursor (the siblings' documents are untouched); on a
   * replicated source only its cursor is reset — its re-bootstrap re-upserts
   * the shared documents and the reconcile authority handles the rest. The
   * device's cursor row is left in place with no cursor, so it bootstraps
   * instead of adopting the shared cursor. The sync is then triggered on
   * that device alone, if it is online. Returns what was wiped and what each
   * member the sync command reached did with it.
   *
   * A source whose data only ever arrives by push is refused before anything
   * is wiped: there is nothing to fetch it again from. The device that
   * answers for that is the one whose slice is reset — the owner for the
   * whole source, the named member for its own stream or cursor.
   */
  async resync(
    id: SourceId,
    rawDeviceId?: string,
  ): Promise<{ scope: "source" | "stream" | "cursor" } & ResyncDispatch> {
    const { db, writeGate: w, statusCache, sourceDataRemoval, wsServer } = this.deps;
    if (!wsServer) throw new ServiceUnavailableError("no WS server");
    const source = getSource(db, id);
    if (!source) throw new HttpError(404, "SOURCE_NOT_FOUND", `source ${id} not found`);
    this.assertNoModeTransition(id);
    if (rawDeviceId === undefined) {
      const host = getDevice(db, source.deviceId);
      if (host && isPushOnly(host, source.type)) throw pushOnlyResyncError(id, host);
      await sourceDataRemoval.deleteSource(id);
      statusCache.bump();
      log.info(`Resync of ${id}: the source was wiped`);
      return {
        scope: "source",
        ...(await this.dispatchResync(wsServer, id, this.syncTargets(id))),
      };
    }
    const deviceId = tryDeviceId(rawDeviceId);
    const member = deviceId ? getDevice(db, deviceId) : null;
    if (!deviceId || !member) {
      throw new HttpError(404, "DEVICE_NOT_FOUND", `device ${rawDeviceId} not found`);
    }
    if (source.deviceId !== deviceId && !isSourceMember(db, id, deviceId)) {
      throw new HttpError(409, "DEVICE_NOT_MEMBER", `device ${deviceId} does not host ${id}`);
    }
    if (isPushOnly(member, source.type)) throw pushOnlyResyncError(id, member);
    const mode = this.modeFor(source);
    if (!hasPerDeviceCursor(mode)) {
      throw new HttpError(
        400,
        "RESYNC_NOT_PER_DEVICE",
        `${id} syncs as ${mode}: its members share one cursor, so there is no per-device resync`,
      );
    }
    const scope = mode === "partitioned" ? "stream" : "cursor";
    if (scope === "stream") {
      await sourceDataRemoval.deleteStream(id, deviceId, { resetCursor: true });
    } else {
      await w.resetMemberCursor(id, deviceId);
    }
    statusCache.bump();
    log.info(`Resync of ${id} for device ${deviceId}: its ${scope} was reset`);
    return { scope, ...(await this.dispatchResync(wsServer, id, [deviceId])) };
  }

  /**
   * Send `source.sync` with `restart` to every online device among `targets`
   * and sort them by their answer (see {@link ResyncDispatch}). A device is
   * counted as started only when it says it started a sync: an answer
   * without counts is taken as started, from a device that does not count;
   * a device that does not know `restart` answers a source mid-sync as
   * skipped; a device on which the source is paused answers it as disabled.
   * A device that is offline, or whose connection failed or refused the
   * command, is left out and syncs on its own schedule — its next run reads
   * the reset cursor anyway.
   */
  private async dispatchResync(
    wsServer: DeviceWsServer,
    id: SourceId,
    targets: readonly DeviceId[],
  ): Promise<ResyncDispatch> {
    const dispatch: ResyncDispatch = { deviceIds: [], restarting: [], skipped: [], disabled: [] };
    for (const deviceId of targets) {
      if (!wsServer.isConnected(deviceId)) continue;
      let answer: WsResponsePayload<"source.sync">;
      try {
        answer = await wsServer.sendCommand(deviceId, "source.sync", {
          sourceId: id,
          restart: true,
        });
      } catch (err) {
        log.warn(
          `Sync dispatch to device ${deviceId} for ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!answer.ok) {
        log.warn(
          `Device ${deviceId} refused the sync of ${id}: ${answer.error ?? "no reason given"}`,
        );
        continue;
      }
      if (answer.triggered === undefined || answer.triggered > 0) {
        dispatch.deviceIds.push(deviceId);
      } else if ((answer.restarting ?? 0) > 0) {
        dispatch.restarting.push(deviceId);
      } else if ((answer.disabled ?? 0) > 0) {
        log.info(`Device ${deviceId} did not start the sync of ${id}: the source is paused there`);
        dispatch.disabled.push(deviceId);
      } else {
        log.info(`Device ${deviceId} did not start the sync of ${id}: already syncing there`);
        dispatch.skipped.push(deviceId);
      }
    }
    return dispatch;
  }

  /**
   * Push this device's authoritative source list over WS. Collectors treat
   * the snapshot as the full statement of what they should host — a source
   * absent from it is unregistered locally (sync loop stopped, instance
   * dropped) while documents and credentials stay put. Mirrors the
   * on-connect push in WsEventHandler.handleConnected.
   */
  private pushSourcesSnapshotTo(deviceId: DeviceId): void {
    const { db, wsServer } = this.deps;
    if (!wsServer) return;
    if (getDevice(db, deviceId)?.kind !== "collector") return;
    const device = getDevice(db, deviceId);
    const sources = listSourcesForMember(db, deviceId).filter(
      (source) => device !== null && deviceSupportsExistingSourceExecution(db, source, device),
    );
    void wsServer.sendCommand(deviceId, "sources.snapshot", { sources }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not connected")) {
        // Offline is fine: the device receives the same snapshot on reconnect.
        log.debug(`sources.snapshot skipped (device ${deviceId} offline) — resyncs on reconnect`);
      } else {
        // A lost teardown is exactly the failure the snapshot exists to
        // prevent — surface it.
        log.warn(`Failed to push sources.snapshot to device ${deviceId}: ${msg}`);
      }
    });
  }

  /**
   * Remove a source (DELETE /admin/sources/:id).
   *
   * Splits into a fast phase the caller waits for and a slow phase it does
   * not. The fast phase is what makes the source *gone* — the row is deleted,
   * a durable tombstone is written, the config block is erased and the
   * collector is told to unmount — so by the time this resolves the source has
   * stopped syncing and stopped accepting pushes.
   *
   * Purging what it ingested is the slow phase, and it runs detached. It is
   * bounded by the size of the corpus and by the indexer, which owns the
   * usearch write handle and will not interrupt a backfill to service a
   * delete; on a large mailbox that is minutes — too long to hold a response
   * open, and long enough that an operator needs to be told it is happening.
   * The tombstone's `cleanup_done_at` carries that state: `listPendingRemovals`
   * reports the source as still removing until it clears, and
   * `resumePendingRemovals` finishes the job if a restart interrupts it.
   *
   * Returns null when the source wasn't present, so the caller maps to
   * 404 with the correct error text.
   */
  async deleteSource(
    id: SourceId,
    pairingFence?: PairingGenerationFence,
  ): Promise<{ source: SourceRecord } | null> {
    this.assertNoModeTransition(id);
    const {
      writeGate: w,
      statusCache,
      syncStatus,
      wsServer,
      syncSourceSettingsToConfig,
    } = this.deps;
    const removed = await this.withLeaseMutation(id, async () => {
      if (getSource(this.deps.db, id)) {
        await this.deps.sourceDataRemoval.prepareSourceRemoval(id);
      }
      const result = await w.removeSource(id, pairingFence);
      if (result) this.deps.syncLease?.forgetSource(id);
      return result;
    });
    if (!removed) {
      this.assertNoModeTransition(id);
      return null;
    }
    const { source, memberDeviceIds: members } = removed;
    // Durable removal marker. For a push source (browser, Apple Health,
    // Health Connect) this is what makes removal *stick*: the device keeps
    // POSTing, but ingest now rejects it and auto-register refuses to
    // resurrect the row, until an explicit re-enable clears the tombstone.
    // Pull sources use broad collector tokens, but the same tombstone still
    // rejects their late writes. A collector can re-register only after this
    // cleanup finishes, at which point registration clears the tombstone.
    //
    // `removeSource` established `cleanupPending` atomically with deleting the
    // live row, so a concurrent re-add cannot slip between those two states.
    // The sweep below clears it only after every derived store is purged.
    statusCache.bump();
    syncStatus?.remove(id);
    try {
      await syncSourceSettingsToConfig(id, null);
    } catch (error) {
      // The tombstone is authoritative even when its config mirror cannot
      // be updated. Dispatch and cleanup must still follow durable removal.
      log.warn(
        `Could not remove source settings for ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Best-effort notify the collector so it tears down its in-memory mount.
    // Only possible when a WS server is wired; the sweep runs regardless
    // (it's what actually clears the data).
    if (wsServer) {
      const outcomes = await Promise.allSettled(
        members.map(async (deviceId) =>
          wsServer.sendCommand(deviceId, "source.removed", { sourceId: id }, 5_000),
        ),
      );
      outcomes.forEach((outcome, i) => {
        if (outcome.status !== "rejected") return;
        const msg =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        if (msg.includes("not connected")) {
          log.debug(`source.removed skipped (device ${members[i]} offline) — sweep still runs`);
        } else {
          log.warn(`source.removed dispatch to ${members[i]} failed for ${id}: ${msg}`);
        }
      });
    }

    log.info(`Source removed: ${id} (device ${source.deviceId}); purging its data`);
    void this.sweepRemovedSource(id);
    return { source };
  }

  /**
   * Ids whose removal has been recorded but whose data purge has not finished.
   * Surfaced so a client can keep showing the source while it drains, instead
   * of having it vanish and reappear in document counts.
   */
  listPendingRemovals(): PendingRemovalEntry[] {
    return listPendingSourceRemovals(this.deps.db).map((r) => {
      const { sourceType, accountId } = parseSourceId(r.id);
      return { id: r.id, type: sourceType, accountId, removedAt: r.removedAt, state: "removing" };
    });
  }

  /** Retained removal authority lets a reconnecting phone withdraw stale local opt-ins. */
  listRemovedSourceIds(): SourceId[] {
    return listRemovedSources(this.deps.db);
  }

  /**
   * Resume any sweep that was interrupted, called once at boot.
   *
   * A gateway that stops mid-purge leaves a tombstone with no completion and a
   * source's documents half-deleted. Nothing else would ever finish that work:
   * the source row is already gone, so no sync, scheduler tick or user action
   * touches those rows again.
   */
  resumePendingRemovals(): void {
    this.streamCleanup.resumePending();
    this.modeTransition?.resumePending();
    const pending = listPendingSourceRemovals(this.deps.db);
    if (pending.length === 0) return;
    log.info(`Resuming ${pending.length} unfinished source removal(s)`);
    for (const { id } of pending) void this.sweepRemovedSource(id);
  }

  /**
   * Re-run a failed sweep later, backing off so a source that cannot be swept
   * yet does not spin. The delay is capped rather than unbounded: the usual
   * cause is an indexing cycle that has to finish first, and once it does the
   * retry must land promptly rather than an hour later.
   *
   * The timer is unref'd — a pending retry must never be the reason the
   * process stays alive.
   */
  private scheduleSweepRetry(id: SourceId): void {
    if (this.retryTimers.has(id)) return;
    const failures = (this.sweepFailures.get(id) ?? 0) + 1;
    this.sweepFailures.set(id, failures);
    const delayMs = Math.min(SWEEP_RETRY_BASE_MS * 2 ** (failures - 1), SWEEP_RETRY_MAX_MS);
    log.info(`Retrying the post-removal sweep for ${id} in ${Math.round(delayMs / 1000)}s`);
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      // Keep the authority check inside the sweep as defense in depth if an
      // operator repairs the tombstone directly while this timer is pending.
      void this.sweepRemovedSource(id);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(id, timer);
  }

  /**
   * Delete everything a removed source left behind: analytics, documents and
   * `source_stats`, the cognitive state grounded on those documents, and the
   * search index entries.
   *
   * Written to be safe to run twice. Resumption cannot tell an interrupted
   * sweep from a running one, and each step is a delete of rows selected at the
   * time it runs, so a second pass over a drained source is a series of no-ops.
   */
  private async sweepRemovedSource(id: SourceId): Promise<void> {
    if (this.sweeping.has(id)) return;
    this.sweeping.add(id);
    // The sweep is kicked off from inside a request handler, so without this
    // it would inherit that request's `user` priority through AsyncLocalStorage
    // and keep it for the whole multi-minute purge — starving the interactive
    // work the priority is meant to protect.
    return runWithPriority("background", () => this.runSweep(id));
  }

  private async runSweep(id: SourceId): Promise<void> {
    const { db, writeGate: w, statusCache, sourceDataRemoval, indexWriteGate } = this.deps;
    const startedMs = Date.now();
    // The tombstone is the sweep's authority to delete. Normal registration
    // is blocked until cleanup finishes; re-checking between steps remains a
    // defense against direct database repair clearing that authority mid-run.
    const stillOurs = (): boolean => {
      if (isSourceCleanupPending(db, id)) return true;
      log.info(`Post-removal sweep for ${id} abandoned — the source was registered again`);
      return false;
    };
    try {
      if (!stillOurs()) return;
      // Capture the ids before the sweep: `deleteAllBySource` removes the rows
      // wholesale and reports only a count, so this is the last moment the
      // cognitive state grounded on them can be identified.
      const doomedDocIds = db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE source_id = ?")
        .all(id)
        .map((r) => r.id);
      // Retract derived private text while document ids still exist. If this
      // step fails, retry sees the same ids; deleting documents first would
      // make a crash lose the only durable join to those derivatives.
      if (!stillOurs()) return;
      await purgeCognitiveStateThroughGate(db, w, doomedDocIds);
      if (!stillOurs()) return;
      // Bump the source epoch before the async analytics purge. Any old ingest
      // that lands after this point fails its exact-epoch check; one already in
      // progress serializes before the purge and is removed by it.
      const orphanSweep = await w.deleteAllBySource(id);
      if (orphanSweep > 0) {
        log.info(`Post-removal sweep for ${id}: cleared ${orphanSweep} orphan rows`);
      }
      // Catch any derivative created after the first purge but before the base
      // document transaction committed. New annotation writes also reject the
      // removal tombstone; this second pass covers every other cognition arm.
      await purgeCognitiveStateThroughGate(db, w, doomedDocIds);
      if (!stillOurs()) return;
      await sourceDataRemoval.purgeAnalyticsForSource(id);
      // The index deletion routes through the indexer worker (see
      // `workerCoordinatedIndexWriteGate`), which owns the live usearch write
      // handle. It does not wait for an in-flight indexing job.
      if (!stillOurs()) return;
      if (indexWriteGate) {
        await indexWriteGate.deleteIndexBySource(id);
      }
      await w.markSourceCleanupDone(id);
      this.sweepFailures.delete(id);
      log.info(`Post-removal sweep for ${id} finished in ${Date.now() - startedMs}ms`);
    } catch (err) {
      // Leaves `cleanup_done_at` NULL, so the source keeps reporting as
      // removing — and schedules its own retry. Waiting for the next boot is
      // not enough: a sweep can fail for reasons that clear on their own (a
      // worker restarting, a transient index error), and without a retry the
      // source would sit in `removing` indefinitely with no way to finish it
      // short of restarting the gateway.
      log.warn(
        `Post-removal sweep for ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleSweepRetry(id);
    } finally {
      this.sweeping.delete(id);
      // Nothing here may throw: this runs in a promise nobody awaits, and an
      // unhandled rejection takes the process down. `bump()` reaches the DB,
      // which can be closed already if the sweep outlived a shutdown.
      try {
        statusCache.bump();
      } catch {
        // The next reader refreshes the cache anyway.
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Read-side passthroughs (routes only call services).
  // ───────────────────────────────────────────────────────────────────────

  getById(id: string) {
    return getSource(this.deps.db, id as ReturnType<typeof SourceId>);
  }

  /** Source-meta map keyed by both full sourceId and source-type. */
  getMeta() {
    return getSourceMeta(this.deps.db);
  }

  /** Current write epoch of one cursor row (`""` = shared, else a member device's own). */
  getWriteEpoch(id: string, cursorRow = ""): number {
    return getWipeEpoch(this.deps.db, id, cursorRow);
  }

  /**
   * Display sync status for every source, from all three places a source
   * can be known: the in-memory registry (a sync running right now), the
   * persisted sync state (what the last run left behind), and the source
   * registry itself (configured but never synced). A source present in only
   * one of them still gets a row — a never-synced source has no persisted
   * state, and a removed-but-still-running one has no registry entry.
   */
  listSyncStatuses(): DisplaySyncStatus[] {
    const inMem = this.deps.syncStatus?.list() ?? [];
    const persisted = this.deps.statusCache.listSyncStates;
    const registered = this.deps.statusCache.listSources;

    const inMemBy = new Map(inMem.map((s) => [s.sourceId, s]));
    const persistedBy = new Map<string, StoredSyncState[]>();
    for (const p of persisted) {
      const rows = persistedBy.get(p.source_id);
      if (rows) rows.push(p);
      else persistedBy.set(p.source_id, [p]);
    }
    const registeredBy = new Map(registered.map((r) => [r.id, r]));
    const permissionBy = new Map<string, MobilePermissionReportRow[]>();
    for (const row of listMobilePermissionHealth(this.deps.db)) {
      const existing = permissionBy.get(row.sourceId);
      if (existing) existing.push(row);
      else permissionBy.set(row.sourceId, [row]);
    }

    const ids = new Set<string>();
    for (const s of inMem) ids.add(s.sourceId);
    for (const p of persisted) ids.add(p.source_id);
    for (const r of registered) ids.add(r.id);

    // A persisted row with an unparseable source_id is skipped rather than
    // thrown on: this list backs both the sync-status view and the health
    // report, and one malformed row must not take down the surfaces whose
    // job is to show that something is wrong.
    const statuses: DisplaySyncStatus[] = [];
    const now = Date.now();
    for (const id of ids) {
      const sourceId = trySourceId(id);
      if (!sourceId) {
        log.warn(`Skipping sync status for unparseable source id: ${id}`);
        continue;
      }
      statuses.push(
        this.deriveSourceStatus(
          sourceId,
          inMemBy.get(sourceId),
          persistedBy.get(id) ?? [],
          registeredBy.get(sourceId),
          permissionBy.get(sourceId) ?? [],
          now,
        ),
      );
    }
    return statuses;
  }

  /**
   * Display sync status for one source, from its live rows; `null` when the
   * gateway knows nothing about it.
   */
  syncStatusFor(id: SourceId): DisplaySyncStatus | null {
    const inMem = this.deps.syncStatus?.get(id);
    const rows = listSyncStatesForSource(this.deps.db, id);
    const registered = this.getById(id) ?? undefined;
    if (!inMem && rows.length === 0 && !registered) return null;
    return this.deriveSourceStatus(
      id,
      inMem,
      rows,
      registered,
      listMobilePermissionHealthForSource(this.deps.db, id),
      Date.now(),
    );
  }

  /**
   * One source's display status from its live report, its persisted cursor
   * rows and its registration. The row with the latest sync or error stands
   * for the source: members of a replicated source sync on their own rows
   * while the shared row may hold only metadata, so the shared row wins ties
   * and never an actual sync or error. With several members — reporting live or persisted on
   * their own rows — the status carries one entry per member, so the
   * breakdown survives a gateway restart.
   */
  private deriveSourceStatus(
    sourceId: SourceId,
    inMem: SourceSyncStatus | undefined,
    rows: readonly StoredSyncState[],
    registered: SourceRecord | undefined,
    permissions: readonly MobilePermissionReportRow[],
    now: number,
  ): DisplaySyncStatus {
    // A row's stamp is its latest sync or error, so a member whose first
    // sync failed still stands for the source over a metadata-only shared row.
    const stampOf = (p: StoredSyncState | undefined): string =>
      p ? [p.last_synced_at ?? "", p.errored_at ?? ""].sort().at(-1)! : "";
    let persisted: StoredSyncState | undefined;
    for (const p of rows) {
      const stamp = stampOf(p);
      const prevStamp = stampOf(persisted);
      if (!persisted || stamp > prevStamp || (stamp === prevStamp && p.device_id === "")) {
        persisted = p;
      }
    }
    const permission = aggregateMobilePermissionHealth(permissions);
    const status = deriveDisplayStatus(
      sourceId,
      inMem,
      persisted,
      registered,
      now,
      registered?.enabled === true ? permission?.health : undefined,
    );
    const memberReports = this.deps.syncStatus?.listMembers(sourceId) ?? [];
    const issuesBy = listSourceSyncIssues(this.deps.db, sourceId);
    const issues = [...issuesBy.values()].flat();
    if (issues.length > 0) {
      status.issues = issues;
      status.issuesSince = Math.min(...issues.map((issue) => issue.since));
    }
    const reportBy = new Map(memberReports.map((r) => [r.deviceId ?? "", r]));
    // Only rows and reports with a device are members; the shared row and an
    // anonymous report describe the source, not a member.
    const memberIds = new Set<string>([...reportBy.keys()].filter((id) => id !== ""));
    for (const p of rows) if (p.device_id !== "") memberIds.add(p.device_id);
    for (const permission of permissions) memberIds.add(permission.deviceId);
    for (const deviceId of issuesBy.keys()) memberIds.add(deviceId);
    // A legacy member may be offline or refused before publishing any status.
    // Its durable membership still needs to explain why it cannot contribute.
    if (registered && (issuesBy.size > 0 || sourceWireFloor(this.deps.db, sourceId) > 0)) {
      memberIds.add(registered.deviceId);
      for (const member of listSourceMembers(this.deps.db, sourceId))
        memberIds.add(member.deviceId);
    }
    const applyWireRefusal = (row: DisplaySyncStatus, deviceId: string): boolean => {
      if (row.state === "paused") return false;
      try {
        this.sourceWireAuthority([sourceId], { deviceId: DeviceId(deviceId) })();
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== "SOURCE_WIRE_CONTRACT_UNSUPPORTED")
          throw error;
        row.state = "error";
        row.errorMessage = error.message;
        row.remediation = SOURCE_WIRE_UPGRADE_REMEDIATION;
        delete row.progress;
        return true;
      }
      return false;
    };
    if (memberIds.size > 1) {
      // Which member keeps a disputed item alive is part of that member's
      // status: it is the device whose replica has not seen the deletion.
      const restoredBy =
        registered?.multiDeviceMode === "replicated"
          ? countRestoredByMember(this.deps.db, sourceId)
          : new Map<string, number>();
      // A member without a row of its own adopts the shared row, as its
      // syncs do — never a sibling's, whose error would then be read as this
      // member's.
      const sharedRow = rows.find((p) => p.device_id === "");
      status.members = [...memberIds].map((deviceId) => {
        const restoredClaims = restoredBy.get(deviceId) ?? 0;
        return {
          ...deriveDisplayStatus(
            sourceId,
            reportBy.get(deviceId),
            rows.find((p) => p.device_id === deviceId) ?? sharedRow,
            registered,
            now,
            permissions.find((permission) => permission.deviceId === deviceId)?.health,
          ),
          deviceId: DeviceId(deviceId),
          ...(issuesBy.has(deviceId)
            ? {
                issues: issuesBy.get(deviceId)!,
                issuesSince: Math.min(...issuesBy.get(deviceId)!.map((issue) => issue.since)),
              }
            : {}),
          ...(restoredClaims > 0 ? { restoredClaims } : {}),
        };
      });
      for (const member of status.members) {
        if (applyWireRefusal(member, member.deviceId!)) applyWireRefusal(status, member.deviceId!);
      }
      const deletersBy =
        restoredBy.size > 0
          ? listDeletersByRestorer(this.deps.db, sourceId)
          : new Map<string, string[]>();
      const names = new Map<string, string | null>();
      const deviceName = (id: string): string | null => {
        if (!names.has(id)) {
          const parsed = tryDeviceId(id);
          const name = parsed ? getDevice(this.deps.db, parsed)?.name?.trim() : undefined;
          names.set(id, name || null);
        }
        return names.get(id) ?? null;
      };
      for (const member of status.members) {
        const count = member.restoredClaims ?? 0;
        const deletedBy = [
          ...new Set(
            (deletersBy.get(member.deviceId!) ?? [])
              .map(deviceName)
              .filter((name): name is string => name !== null),
          ),
        ];
        member.notices = buildSourceNotices(
          member,
          count > 0 ? { dispute: { count, deletedBy } } : {},
        );
      }
      return status;
    } else if (registered) {
      applyWireRefusal(status, registered.deviceId);
    }
    status.notices = buildSourceNotices(status);
    return status;
  }
}
