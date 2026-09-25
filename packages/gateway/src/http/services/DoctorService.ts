// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's own health check, backing `GET /admin/doctor`.
 *
 * `omnesis doctor` answers the same questions by fetching a dozen gateway
 * endpoints over HTTP and folding the responses into a `DoctorData` bundle.
 * This service folds the identical bundle straight from in-process state,
 * then hands it to the same `evaluateDoctor()` in `@omnesis/core/doctor`.
 * Sharing the evaluator is the point: a verdict the portal's Debug page
 * shows and a verdict the CLI prints are the same computation over the same
 * inputs, so the two can never disagree about what "healthy" means.
 *
 * Scope note: every check here describes *this gateway and the host it runs
 * on*. A collector on another machine has its own filesystem, keyring, and
 * service units, none of which this process can see. DeviceDoctorService asks
 * the collector process to evaluate those host-local checks instead.
 */

import { statSync } from "node:fs";
import { createLogger } from "@omnesis/core";
import {
  collectSecurityDataInWorker,
  evaluateDoctor,
  PROCESS_VITALS_WINDOW_SECONDS,
} from "@omnesis/core/doctor";
import { computeIndexStats, type IndexStatsDeps } from "../../indexer/stats.js";
import { deviceVersionState } from "../../device-version.js";
import { GATEWAY_VERSION } from "../../version.js";
import { deviceNeedsPairing, type StatusCache } from "./StatusCache.js";
import type {
  DiskUsageSnapshot,
  DoctorData,
  DoctorReport,
  SweepsResult,
  WhoAmIResult,
} from "@omnesis/core/doctor";
import type { ConfigStore } from "../../config-store.js";
import type { InferenceOverview, TlsLifecycleSnapshot } from "@omnesis/core";
import type { SystemInfo } from "../../system-info.js";
import type { ProcessVitalsSnapshot } from "../../process-vitals.js";
import type { SourceService } from "./SourceService.js";
import type { DeviceWsServer } from "../../ws.js";
import type { PushPlan } from "@omnesis/core/push";
import type { ReleaseCheckSnapshot } from "@omnesis/core/release-check";
import type { DeviceRecord } from "@omnesis/types";
import type { AgentDeviceAuthorization } from "../../access/agent-device-authorization.js";

const log = createLogger("gateway:http").child("doctor");

export interface DoctorServiceDeps {
  configDir?: string;
  dbPath?: string;
  configStore?: ConfigStore;
  statusCache: StatusCache;
  sourceService: SourceService;
  wsServer?: DeviceWsServer;
  indexStats: IndexStatsDeps;
  getSystemInfo?: () => SystemInfo;
  getInferenceOverview?: () => InferenceOverview;
  /** Last successful install-aware release check, or null before one succeeds. */
  getReleaseCheck?: () => ReleaseCheckSnapshot | null;
  /** The served certificate's lifecycle; absent in compositions without TLS wiring. */
  getTlsLifecycle?: () => TlsLifecycleSnapshot | null;
  processVitals?: { snapshot(windowSeconds: number): ProcessVitalsSnapshot };
  /** Resolve the same app-bound push plan exposed by GET /admin/devices. */
  pushPlanForDevice?: (device: DeviceRecord) => PushPlan | null;
  /** The same per-agent authorization verdicts GET /admin/devices carries. */
  agentAuthorizations?: () => ReadonlyMap<string, AgentDeviceAuthorization>;
  /**
   * Sweep-file health. Absent in compositions without a sweep store, which
   * renders as no Sweeps section rather than as a passing one.
   */
  sweeps?: () => SweepsResult;
  /** The gateway's whole on-disk footprint; absent reports as no breakdown. */
  getDiskUsage?: () => DiskUsageSnapshot | null;
}

export class DoctorService {
  /**
   * The security scan currently in flight, if any. Every caller of a scan
   * already under way joins it rather than starting a second: the walk is
   * expensive, the answer is a snapshot both callers would accept, and the
   * portal re-runs the report each time the operator returns to the Doctor
   * tab. Without this, tab-switching fans out concurrent full walks of the
   * same tree.
   */
  private inFlightSecurity: Promise<Pick<DoctorData, "security" | "securityError">> | null = null;

  constructor(private readonly deps: DoctorServiceDeps) {}

  /**
   * Run every check and return the report. `whoami` is request-scoped —
   * the caller passes the identity resolved from the current request — so
   * the auth section describes the caller rather than the gateway.
   */
  async report(whoami: WhoAmIResult): Promise<DoctorReport> {
    const data = await this.collect(whoami);
    return evaluateDoctor(data);
  }

  private async collect(whoami: WhoAmIResult): Promise<DoctorData> {
    const { configStore, statusCache, sourceService, wsServer } = this.deps;
    const agentAuthorizations = this.deps.agentAuthorizations?.();
    // The security walk can take seconds. Finish it before sampling operational
    // state so the report reflects the freshest source/device snapshot.
    const security = await this.collectSecurity();

    return {
      // The gateway is answering, so reachability and auth are settled
      // facts rather than probes: a request that got this far had a valid
      // admin-scoped token.
      target: "gateway",
      operationalChecks: true,
      health: { reachable: true, version: GATEWAY_VERSION },
      authError: false,
      whoami,
      config: { version: configStore?.getStatus().version ?? 0 },
      configStatus: configStore?.getStatus() ?? null,
      devices: statusCache.listDevices.map((d) => ({
        ...(agentAuthorizations?.has(d.id)
          ? { agentAuthorization: agentAuthorizations.get(d.id) }
          : {}),
        id: d.id,
        name: d.name,
        kind: d.kind,
        // Transport presence remains available to report consumers, but the
        // evaluator does not use a single WS sample as a health verdict.
        online: wsServer?.isConnected(d.id) ?? false,
        revokedAt: d.revokedAt,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
        needsPairing: deviceNeedsPairing(d, statusCache.sourceHostingDeviceIds.has(d.id)),
        version: d.version,
        versionState: deviceVersionState(d),
        pushTransport: d.pushTransport,
        pushPlan: this.deps.pushPlanForDevice?.(d) ?? null,
        hasApnsRegistration: d.apnsRegistration !== null,
        hasFcmRegistration: d.fcmRegistration !== null,
        notificationDeliveryHealth: d.notificationDeliveryHealth ?? null,
        notificationDeliveryHealthUpdatedAt: d.notificationDeliveryHealthUpdatedAt ?? null,
        desiredVersion: d.desiredVersion,
        updateState: d.updateState,
        updateDetail: d.updateDetail,
        harness: d.capabilities?.agentIntegration?.harness ?? null,
      })),
      sources: sourceService.listSourcesForAdmin().map((s) => ({
        id: s.id,
        type: s.type,
        accountId: s.accountId,
        deviceId: s.deviceId,
        enabled: s.enabled,
        pushBased: s.pushBased,
        lastSyncedAt: s.lastSyncedAt,
        disputedDeletions: s.disputedDeletions,
      })),
      syncStatus: sourceService.listSyncStatuses().map((s) => ({
        sourceId: s.sourceId,
        state: s.state,
        lastSyncAt: s.lastSyncAt,
        errorMessage: s.errorMessage,
        remediation: s.remediation,
        issues: s.issues,
        issuesSince: s.issuesSince,
        staleHint: s.staleHint,
        // Carried, or the permission checks that read it can never fire on
        // this surface — they would run only through the CLI, which passes its
        // rows verbatim, and a check that silently cannot run is worse than
        // one that is not written.
        permissionHealth: s.permissionHealth,
      })),
      models: this.deps.getInferenceOverview
        ? { inference: this.deps.getInferenceOverview() }
        : null,
      systemInfo: this.deps.getSystemInfo?.() ?? null,
      indexStats: computeIndexStats(this.deps.indexStats),
      overall: {
        dbSizeBytes: this.dbSizeBytes(),
        diskUsage: this.deps.getDiskUsage?.() ?? null,
        release: this.deps.getReleaseCheck?.() ?? null,
        tls: this.deps.getTlsLifecycle?.() ?? null,
      },
      processVitals: this.deps.processVitals?.snapshot(PROCESS_VITALS_WINDOW_SECONDS) ?? null,
      sweeps: this.deps.sweeps?.() ?? null,
      ...security,
    };
  }

  private dbSizeBytes(): number | null {
    const { dbPath } = this.deps;
    if (!dbPath) return null;
    try {
      return statSync(dbPath).size;
    } catch {
      return null;
    }
  }

  /**
   * Audit the host's security posture in a worker, joining a scan already
   * under way rather than starting a second.
   *
   * Returns the two `DoctorData` slots together so a failure carries its
   * reason: the evaluator reports "could not audit" when `securityError` is
   * set, rather than letting the whole section disappear from a report that
   * would then read as healthy. With no config directory there is nothing
   * to audit and nothing to explain, so both stay empty.
   */
  private async collectSecurity(): Promise<Pick<DoctorData, "security" | "securityError">> {
    const { configDir } = this.deps;
    if (!configDir) return { security: null, securityError: null };

    this.inFlightSecurity ??= this.runSecurityWorker(configDir).finally(() => {
      this.inFlightSecurity = null;
    });
    return this.inFlightSecurity;
  }

  private runSecurityWorker(
    configDir: string,
  ): Promise<Pick<DoctorData, "security" | "securityError">> {
    return collectSecurityDataInWorker({ configDir, component: "gateway" })
      .then((security) => ({ security, securityError: null }))
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn(`Security posture scan unavailable: ${reason}`);
        return { security: null, securityError: reason };
      });
  }
}
