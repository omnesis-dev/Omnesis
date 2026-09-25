// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Types for the Omnesis doctor — a read-only operational health check.
 *
 * A caller gathers the state below into a single `DoctorData` bundle, then
 * runs the pure `evaluateDoctor()` over it to produce a `DoctorReport`.
 * Keeping the bundle and the evaluator separate from how the data was
 * obtained is what lets different producers share one set of checks:
 * `omnesis doctor` folds the bundle from gateway HTTP responses, the gateway's
 * own `/admin/doctor` route folds it from in-process state, and a paired
 * collector folds the evidence local to its host. It also lets the checks be
 * unit-tested against hand-written fixtures with no daemon at all.
 *
 * Wire shapes below are deliberately partial views of the gateway's
 * responses — the checks only read the fields they classify on, so the
 * interfaces name exactly those and nothing more. Shared types are used
 * where one already exists (InferenceOverview, IndexStats); the rest are
 * narrow local mirrors of the route-handler return shapes.
 */

import type { InferenceOverview } from "../models/backends.js";
import type { DeviceUpdateState, SyncRemediation } from "@omnesis/types";
import type { SecretStoreStatus } from "../secret-store.js";
import type { ClientVersionState } from "../client-version.js";
import type { IndexStats, SourceReadAccessResult } from "@omnesis/source-sdk";
import type { MobilePermissionCapability } from "@omnesis/types/mobile-permission-health";
import type { ReleaseCheckSnapshot } from "../release-check.js";
import type { TlsLifecycleSnapshot } from "../tls-material.js";

/** A single diagnostic outcome. */
export type CheckStatus = "pass" | "warn" | "fail" | "not-applicable";

/** The process/host whose local doctor data is being evaluated. */
export type DoctorTarget = "gateway" | "collector";

export interface DoctorCheck {
  /** Stable machine id, e.g. `gateway.reachable`. */
  id: string;
  /** Human section heading, e.g. `Gateway`. */
  section: string;
  status: CheckStatus;
  /** One-line result message. */
  message: string;
  /** Remediation hint — present on `warn`/`fail`, omitted otherwise. */
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  summary: { errors: number; warnings: number };
  checks: DoctorCheck[];
}

export interface SecurityPermissionEntry {
  path: string;
  relativePath: string;
  kind: "directory" | "file" | "symlink" | "other" | "missing";
  expectedMode: number | null;
  actualMode: number | null;
  ok: boolean;
  fixed: boolean;
  error?: string;
}

export interface SecurityDiskEncryptionStatus {
  platform: NodeJS.Platform;
  status: "on" | "off" | "unknown" | "unsupported";
  detail: string;
}

export interface SecurityServiceDirective {
  key: string;
  expected: string;
  actual: string | null;
  ok: boolean;
}

export interface SecurityServiceUnit {
  component: "gateway" | "collector";
  platform: "darwin" | "linux";
  path: string;
  installed: boolean;
  directives: SecurityServiceDirective[];
}

/**
 * How one installed unit tells its daemon to reach the keyring.
 *
 * A unit names a backend and, for the passphrase backend, a source to read
 * the passphrase from. The two are written at install time and consumed at
 * boot, so nothing else notices when a unit names one without the other — the
 * daemon starts, selects a backend it cannot open, and fails later on the
 * first encrypted store it touches.
 */
export interface SecurityKeyringWiring {
  component: "gateway" | "collector";
  /**
   * `user` — the per-user unit the default install writes. `system` — the
   * hardened system unit, which one host can carry alongside a user unit for
   * the same component, so this is what keeps the two apart.
   */
  scope: "user" | "system";
  path: string;
  /** Backend named by `OMNESIS_SECRET_STORE`, or null when the unit names none. */
  backend: string | null;
  /**
   * Where the daemon would read the passphrase from: a systemd credential, a
   * file named by `OMNESIS_KEYRING_PASSPHRASE_FILE`, the passphrase inlined in
   * `OMNESIS_KEYRING_PASSPHRASE`, or null when the unit declares no source.
   */
  passphraseSource: "credential" | "file" | "inline" | null;
}

/**
 * Whether this process can see the install's key material at all — the one
 * field that separates "nothing is armed" from "what is armed is out of
 * reach". Every other keyring reading in this report collapses the two, so
 * this one qualifies all of them.
 */
export type SecurityKeyringAccess =
  | { readable: true }
  | { readable: false; path: string; detail: string };

export interface SecurityKeyringData {
  keyName: string;
  store: SecretStoreStatus;
  present: boolean;
  valid: boolean;
}

export interface SecurityGatewayIsolation {
  /**
   * Whether the gateway service runs under a dedicated OS user rather than
   * a human login account. Classification is unit-file inspection only (no
   * live process check).
   *
   * `dedicated-user` — a system-level unit with `DynamicUser=`, or a `User=`
   * naming a confirmed system account.
   * `login-user` — any other installed gateway unit: the default user-level
   * systemd unit or launchd agent, or a system unit running as a human
   * login account.
   * `unknown` — a system unit names a `User=` the host's account database
   * cannot classify. Reported rather than assumed in either direction,
   * since guessing "dedicated" would call an unisolated install secure.
   * `not-installed` — no gateway unit was found at all.
   * `not-applicable` — the audit describes a collector host, where gateway
   * process isolation is deliberately outside the component's remit.
   */
  status: "dedicated-user" | "login-user" | "unknown" | "not-installed" | "not-applicable";
  detail: string;
  /** Hardened system-unit path that was inspected (Linux; null elsewhere). */
  systemUnitPath: string | null;
}

export interface SecurityRecoveryEscrowStatus {
  /**
   * `exported` — a well-formed recovery envelope is present.
   * `missing`  — no envelope has been exported.
   * `corrupt`  — a file exists at the envelope path but is not a valid v1 escrow.
   */
  status: "exported" | "missing" | "corrupt";
  detail: string;
  path: string;
}

export interface SecurityData {
  configDir: string;
  fixPermissions: boolean;
  permissionEntries: SecurityPermissionEntry[];
  permissionScanTruncated: boolean;
  diskEncryption: SecurityDiskEncryptionStatus;
  serviceUnits: SecurityServiceUnit[];
  gatewayIsolation: SecurityGatewayIsolation;
  keyring: SecurityKeyringData;
  /** Whether the install's key material could be read at all. */
  keyringAccess: SecurityKeyringAccess;
  /** Keyring wiring read back from each installed, readable unit file. */
  keyringWiring: SecurityKeyringWiring[];
  recoveryEscrow: SecurityRecoveryEscrowStatus;
  databaseEncryption: {
    status: "on" | "off" | "partial" | "blocked" | "not-applicable";
    detail: string;
    required: boolean;
    stores: Array<{
      keyName: string;
      present: boolean;
      valid: boolean;
      encrypted: boolean;
    }>;
  };
}

// ── Narrow wire-shape mirrors (only the fields doctor reads) ────────────

/** `GET /whoami`. */
export interface WhoAmIResult {
  tokenId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  scopes: string[];
}

/** `GET /config`. The gateway version lives here. */
export interface ConfigResult {
  version: number;
}

/** `GET /admin/config/status` — config-store load health. */
export interface ConfigStatusResult {
  ok: boolean;
  version: number;
  lastLoadedAt: number;
  lastWrittenAt: number | null;
  lastError: { at: number; message: string } | null;
}

/** One entry of `GET /admin/devices` (Page<Device>). */
export interface DeviceEntry {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  /** Revoked while still hosting sources: dormant until paired again. */
  needsPairing?: boolean;
  /** When the device was paired, epoch milliseconds; absent from older gateways. */
  pairedAt?: number | null;
  /** When the device last connected, epoch milliseconds; null if it never has. */
  lastSeenAt?: number | null;
  /** Product version the device last reported, or null if it never has. */
  version?: string | null;
  /**
   * The gateway's verdict on that version. Absent from a gateway that
   * predates the version ledger, which the fleet check reads as `unknown`
   * rather than as a fault of the device.
   */
  versionState?: ClientVersionState;
  /** Set when the device is revoked: no access, no push target, sources dormant. */
  revokedAt?: number | null;
  pushTransport?: "direct-apns" | "direct-fcm" | "relay" | "socket" | null;
  /** The app-bound plan explains why a phone without a selected transport is unavailable. */
  pushPlan?:
    | { transport: "direct-apns" | "direct-fcm" | "relay" }
    | {
        transport: "unavailable";
        reasonCode?: "relay-disabled" | "relay-url-unavailable" | "no-direct-credential";
        reason: string;
      }
    | null;
  /** Full admin-device responses carry registrations; in-process doctor uses booleans. */
  apnsRegistration?: unknown | null;
  fcmRegistration?: unknown | null;
  hasApnsRegistration?: boolean;
  hasFcmRegistration?: boolean;
  notificationDeliveryHealth?:
    | "healthy"
    | "not-determined"
    | "permission-denied"
    | "scheduled-summary"
    | "alerts-disabled"
    | null;
  notificationDeliveryHealthUpdatedAt?: number | null;
  /** The version an update asked this device to reach; null when nothing is owed. */
  desiredVersion?: string | null;
  /** Where that update stands; null if none was ever made. */
  updateState?: DeviceUpdateState | null;
  /** One line about it: the failure, or the restart still owed. */
  updateDetail?: string | null;
  /** For an agent device, the harness it is connected to. */
  harness?: string | null;
  /** For an agent device, whether its corpus access needs a human to re-authorize it. */
  agentAuthorization?:
    | { status: "authorized" }
    | { status: "needs-reauthorization"; remedy: string };
}

/** One entry of `GET /admin/sources` (Page<AdminSource>). */
export interface SourceEntry {
  id: string;
  type: string;
  accountId: string;
  deviceId: string;
  enabled: boolean;
  pushBased?: boolean;
  lastSyncedAt?: string | null;
  /**
   * Items one replica member reported deleted that another still holds;
   * kept until the members agree. Absent from a gateway that predates it.
   */
  disputedDeletions?: number;
}

/**
 * One entry of `GET /admin/sync/status` (Page<SyncStatusEntry>).
 *
 * `state` mirrors the gateway's `DisplaySyncState`. Two of its members are
 * derived rather than persisted: `rate-limited` (throttled but healthy, and
 * self-clearing) and `auth-expiring` (still syncing, but consent lapses
 * soon — distinct from the already-broken `needs-auth`).
 */
export interface SyncStatusEntry {
  issues?: import("@omnesis/types").SyncIssueStatus[];
  issuesSince?: number;
  sourceId: string;
  state:
    | "idle"
    | "syncing"
    | "synced"
    | "error"
    | "paused"
    | "needs-auth"
    | "rate-limited"
    | "auth-expiring"
    | "stale"
    | "permission-degraded"
    | "background-access-missing"
    | "unavailable";
  lastSyncAt: string | null;
  errorMessage?: string;
  /** The structured remedy reported with an `error`, when the failure named one. */
  remediation?: SyncRemediation;
  /** Source-authored remediation sentence; present only when state is `stale`. */
  staleHint?: string;
  permissionHealth?: {
    state:
      | "healthy"
      | "permission-degraded"
      | "background-access-missing"
      | "unavailable"
      | "unknown";
    reportStale: boolean;
    validUntil: number;
    capabilities: MobilePermissionCapability[];
  };
}

/** `GET /admin/models` (ModelsOverview) — only the inference slice is read. */
export interface ModelsResult {
  inference: InferenceOverview;
}

/** Host resource information (`GET /admin/system-info` on the gateway). */
export interface SystemInfoResult {
  platform: string;
  arch: string;
  totalRamGb: number;
  freeRamGb: number;
  modelsDir: string;
  modelsDirFreeGb: number;
  /** Collector-local data volume; absent from legacy gateway responses. */
  dataDir?: string;
  dataDirFreeGb?: number;
}

/** `GET /index/stats`. `state`/`model.present` live alongside `IndexStats`. */
export interface IndexStatsResult extends Partial<IndexStats> {
  enabled: boolean;
  state?: string;
  model?: { present: boolean; name?: string } | null;
}

/** One named part of the gateway's on-disk footprint. */
export interface DiskUsageStore {
  /** Stable key (`documents`, `index`, `analytics`, `other`, …). */
  id: string;
  /** Display name, chosen by the gateway so every client says the same thing. */
  label: string;
  bytes: number;
}

/**
 * Everything the gateway keeps on disk: each store with its sidecars, the
 * directories under the config dir that hold its other data, and whatever
 * else sits there. `stores` is ordered for display and omits empty parts;
 * `totalBytes` is their sum.
 */
export interface DiskUsageSnapshot {
  totalBytes: number;
  /** ISO time the measurement finished. */
  measuredAt: string;
  stores: DiskUsageStore[];
}

/** `GET /status` — the operational fields the doctor reads. */
export interface OverallStatusResult {
  /** The main document database file alone; `diskUsage` is the whole footprint. */
  dbSizeBytes: number | null;
  /** Absent on older gateways; null until the first measurement completes. */
  diskUsage?: DiskUsageSnapshot | null;
  /** Absent on older gateways; null until this gateway has a successful check. */
  release?: ReleaseCheckSnapshot | null;
  /** The served certificate's lifecycle (`GET /admin/tls`); absent on older gateways. */
  tls?: TlsLifecycleSnapshot | null;
}

/** `GET /admin/process-vitals` (subset). */
export interface ProcessVitalsResult {
  eventLoop?: { current: { p50Ms: number; p95Ms: number; p99Ms: number } | null };
  memory?: { current: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number } | null };
}

/**
 * `GET /admin/brain/sweeps` (subset) — what is wrong with the operator's
 * sweep files, and which sweeps are anchored where the morning digest needs
 * quiet. Null when sweeps could not be read (the briefs feature is inactive,
 * or the route is not mounted), which is not itself a fault.
 */
export interface SweepsResult {
  /** Whether the sweep lane itself is switched on (`brain.sweepsEnabled`). */
  laneEnabled: boolean;
  enabledCount: number;
  issues: { id: string; file: string; message: string }[];
  digestWindowConflicts: { id: string; at: string }[];
}

/** One local store's state, as a source reported it for the host's check. */
export interface DoctorLocalStore {
  sourceId: string;
  keyName: string;
  label: string;
  state: "encrypted" | "plaintext" | "absent" | "locked" | "unverifiable";
  detail?: string;
}

/**
 * The folded bundle handed to `evaluateDoctor`. Endpoint-backed slots are
 * nullable: on a gateway target, null means the fetch failed; on a collector,
 * gateway-only slots stay null and are explicitly classified N/A instead of
 * being interpreted as failed fetches. `health` carries whether `GET /health`
 * answered; `authError` carries a 401/403 observed on `/whoami` so the auth
 * section can FAIL loudly instead of silently reporting "no token info".
 */
export interface DoctorData {
  /** Process/host whose evidence this bundle describes. */
  target: DoctorTarget;
  /** Whether non-security operational checks were collected. */
  operationalChecks: boolean;
  /**
   * `GET /health`: whether the gateway answered, and the lockstep product
   * version it reported. `version` is absent when the probe failed or when
   * the response carried none.
   */
  health: { reachable: boolean; version?: string | null };
  /**
   * The gateway's ownership record for the config dir, read off disk when the
   * doctor targets a gateway on this machine. Explains an unreachable
   * gateway: a live owner is a process that is booting, shutting down or
   * wedged rather than absent. `null` when no lock exists; absent when the
   * target is remote.
   */
  gatewayLock?: { pid: number; startedAt: string; alive: boolean } | null;
  /** Set when /whoami returned 401/403 — the token is present but rejected. */
  authError: boolean;
  whoami: WhoAmIResult | null;
  config: ConfigResult | null;
  configStatus: ConfigStatusResult | null;
  devices: DeviceEntry[] | null;
  sources: SourceEntry[] | null;
  syncStatus: SyncStatusEntry[] | null;
  /** Fresh daemon-process checks; separate from the last sync's outcome. */
  sourceReadAccess?: Array<SourceReadAccessResult & { sourceId: string }>;
  models: ModelsResult | null;
  systemInfo: SystemInfoResult | null;
  indexStats: IndexStatsResult | null;
  overall: OverallStatusResult | null;
  processVitals: ProcessVitalsResult | null;
  sweeps: SweepsResult | null;
  security: SecurityData | null;
  /**
   * The encrypted stores the collector's sources keep on its host, as each
   * source inspected them for this run. Collector reports only; a gateway
   * report leaves it out.
   */
  localStores?: DoctorLocalStore[];
  /**
   * The name the host is known by in the fleet — a collector's device name
   * — so a remedy can say where to run it. Null when the report is about the
   * host the reader is on.
   */
  host?: string | null;
  /**
   * Why the security posture is absent, when it was asked for and could not
   * be collected. A caller that deliberately skipped the audit leaves this
   * unset and the section is simply omitted; a caller whose audit failed
   * sets it so the report says so. The distinction matters: an audit that
   * did not run must never render as an audit that passed.
   */
  securityError?: string | null;
}
