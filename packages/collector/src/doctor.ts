// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { statfs } from "node:fs/promises";
import { arch, freemem, platform, totalmem } from "node:os";
import { createLogger } from "@omnesis/core";
import {
  collectSecurityDataInWorker,
  evaluateDoctor,
  type ConfigStatusResult,
  type DoctorData,
  type ProcessVitalsResult,
  type SecurityData,
  type SyncStatusEntry,
  type SystemInfoResult,
} from "@omnesis/core/doctor";
import { DoctorLocalStores } from "./doctor-local-stores.js";
import { DoctorReadAccess, type DoctorReadAccessSource } from "./doctor-read-access.js";
import type { WsEventPayload, WsResponsePayload } from "@omnesis/core";
import type { GatewayWsClient } from "@omnesis/gateway-client";
import type { SourceStatus } from "./source-lifecycle.js";
import type { SyncRemediation } from "@omnesis/types";

const log = createLogger("collector:doctor");
const GENERIC_DOCTOR_ERROR =
  "The collector could not complete its health check. Inspect its local logs and retry.";
const GENERIC_SECURITY_ERROR =
  "The collector security audit did not complete. Inspect its local logs and retry.";
const COLLECTOR_DOCTOR_TIMEOUT_MS = 60_000;

export interface CollectorDoctorDeps {
  configDir: string;
  getIdentity: () => ReturnType<GatewayWsClient["getIdentity"]>;
  getConfigStatus: () => ConfigStatusResult;
  getSourceStatuses: () => SourceStatus[];
  getReadAccessSources: () => DoctorReadAccessSource[];
  getProcessVitals: () => ProcessVitalsResult;
  emitResult: (payload: WsEventPayload<"device.doctor.result">) => void;
  collectSecurity?: () => Promise<SecurityData>;
  getSystemInfo?: () => Promise<SystemInfoResult>;
  /** Internal budget override for deterministic timeout tests. */
  runTimeoutMs?: number;
}

/**
 * Collector side of the two-message doctor handshake. The command is only a
 * receipt; the worker-backed scan finishes later and emits a correlated event.
 * Replaying the same run id is safe across reconnects.
 */
export class CollectorDoctor {
  private activeRunId: string | null = null;
  private lastResult: WsEventPayload<"device.doctor.result"> | null = null;
  private readonly runTimeoutMs: number;
  private readonly readAccess = new DoctorReadAccess();
  private readonly localStores = new DoctorLocalStores();

  constructor(private readonly deps: CollectorDoctorDeps) {
    this.runTimeoutMs = deps.runTimeoutMs ?? COLLECTOR_DOCTOR_TIMEOUT_MS;
  }

  start(runId: string): WsResponsePayload<"device.doctor"> {
    if (this.activeRunId === runId) return { accepted: true };
    if (this.lastResult?.runId === runId) {
      queueMicrotask(() => this.deps.emitResult(this.lastResult!));
      return { accepted: true };
    }
    if (this.activeRunId) {
      return { accepted: false, reason: "Another health check is already running." };
    }

    // The command could only arrive on an authenticated socket. Preserve that
    // fact across the slow host probes: a reconnect during collection clears
    // the client's live identity, but does not retroactively reject this run.
    const identity = this.deps.getIdentity();
    this.activeRunId = runId;
    void this.run(runId, identity);
    return { accepted: true };
  }

  private async run(
    runId: string,
    identity: ReturnType<GatewayWsClient["getIdentity"]>,
  ): Promise<void> {
    let result: WsEventPayload<"device.doctor.result">;
    const controller = new AbortController();
    try {
      result = await withTimeout(
        this.collect(runId, identity, controller.signal),
        this.runTimeoutMs,
        `Collector doctor run ${runId} timed out after ${this.runTimeoutMs}ms`,
      );
    } catch (err) {
      log.warn(
        `Collector doctor run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      result = { runId, error: GENERIC_DOCTOR_ERROR };
    } finally {
      controller.abort();
    }
    this.lastResult = result;
    if (this.activeRunId === runId) this.activeRunId = null;
    this.deps.emitResult(result);
  }

  private async collect(
    runId: string,
    identity: ReturnType<GatewayWsClient["getIdentity"]>,
    signal: AbortSignal,
  ): Promise<WsEventPayload<"device.doctor.result">> {
    const [systemInfo, securityResult, sourceReadAccess, localStores] = await Promise.all([
      (this.deps.getSystemInfo ?? (() => collectorSystemInfo(this.deps.configDir)))().catch(
        (err: unknown) => {
          log.warn(
            `Could not inspect collector storage: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        },
      ),
      (
        this.deps.collectSecurity ??
        (() =>
          collectSecurityDataInWorker({
            configDir: this.deps.configDir,
            component: "collector",
          }))
      )()
        .then((security) => ({ security, error: null as string | null }))
        .catch((err: unknown) => {
          log.warn(
            `Collector security audit unavailable: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { security: null, error: GENERIC_SECURITY_ERROR };
        }),
      this.readAccess.collect(this.deps.getReadAccessSources(), signal),
      this.localStores.collect(this.deps.getReadAccessSources(), signal),
    ]);
    const configStatus = sanitizeConfigStatus(this.deps.getConfigStatus());
    const data: DoctorData = {
      target: "collector",
      operationalChecks: true,
      health: { reachable: identity !== null },
      authError: identity === null,
      whoami: identity
        ? {
            tokenId: null,
            deviceId: identity.deviceId,
            deviceName: identity.deviceName,
            scopes: identity.scopes,
          }
        : null,
      config: { version: configStatus.version },
      configStatus,
      devices: null,
      sources: null,
      syncStatus: this.deps.getSourceStatuses().map(toDoctorSyncStatus),
      sourceReadAccess: sourceReadAccess.map((entry) => ({
        ...entry,
        ...(entry.remediation ? { remediation: sanitizeSyncRemediation(entry.remediation) } : {}),
      })),
      models: null,
      systemInfo,
      indexStats: null,
      overall: null,
      processVitals: this.deps.getProcessVitals(),
      sweeps: null,
      security: securityResult.security
        ? sanitizeCollectorSecurityData(securityResult.security)
        : null,
      securityError: securityResult.error,
      localStores,
      // The remedies in this report run on this collector, which the reader
      // knows by its device name.
      host: identity?.deviceName ?? null,
    };
    return { runId, report: evaluateDoctor(data) };
  }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sanitizeConfigStatus(status: ConfigStatusResult): ConfigStatusResult {
  return status.lastError
    ? {
        ...status,
        lastError: {
          at: status.lastError.at,
          message: "The latest collector configuration could not be loaded.",
        },
      }
    : status;
}

/** Remove absolute host details before the evaluated findings cross the socket. */
function sanitizeCollectorSecurityData(security: SecurityData): SecurityData {
  const diskDetail =
    security.diskEncryption.status === "on"
      ? "Full-disk encryption is enabled on this collector."
      : security.diskEncryption.status === "off"
        ? "Full-disk encryption is not enabled on this collector."
        : security.diskEncryption.status === "unsupported"
          ? "Full-disk encryption cannot be inspected on this collector platform."
          : "Full-disk encryption could not be proven on this collector.";
  const keyringDetail = security.keyring.store.available
    ? security.keyring.store.secure
      ? "The selected OS keyring backend is available."
      : "The selected secret backend is available but is not OS-protected."
    : "The selected keyring backend is unavailable.";
  return {
    ...security,
    configDir: "<collector-config>",
    permissionEntries: security.permissionEntries.map((entry) => ({
      ...entry,
      path: entry.relativePath,
      ...(entry.error ? { error: "The entry could not be inspected." } : {}),
    })),
    diskEncryption: { ...security.diskEncryption, detail: diskDetail },
    serviceUnits: security.serviceUnits.map((unit) => ({
      ...unit,
      path: `${unit.component} ${unit.platform} service`,
    })),
    keyringAccess: security.keyringAccess.readable
      ? security.keyringAccess
      : {
          readable: false,
          path: "<collector-key-material>",
          detail: "Collector key material is not readable by this process.",
        },
    keyring: {
      ...security.keyring,
      store: { ...security.keyring.store, detail: keyringDetail },
    },
    keyringWiring: security.keyringWiring.map((unit) => ({
      ...unit,
      path: `${unit.component} ${unit.scope} service`,
    })),
    // The blocked arm carries the error that stopped the key inventory,
    // which can name the keyring directory; the evaluator's remedy says what
    // to do, so the detail only needs to say which condition it was.
    databaseEncryption:
      security.databaseEncryption.status === "blocked"
        ? {
            ...security.databaseEncryption,
            detail: security.databaseEncryption.required
              ? "Live storage encryption is required, but the install root key is unavailable."
              : "The collector's key material could not be inspected.",
          }
        : security.databaseEncryption,
    recoveryEscrow: {
      ...security.recoveryEscrow,
      path: "<collector-recovery-envelope>",
      detail:
        security.recoveryEscrow.status === "corrupt"
          ? "The collector recovery envelope is malformed."
          : "Collector recovery-envelope status was inspected locally.",
    },
  };
}

export async function collectorSystemInfo(configDir: string): Promise<SystemInfoResult> {
  const volume = await statfs(configDir);
  const dataDirFreeGb = (Number(volume.bavail) * Number(volume.bsize)) / 1024 ** 3;
  return {
    platform: platform(),
    arch: arch(),
    totalRamGb: totalmem() / 1024 ** 3,
    freeRamGb: freemem() / 1024 ** 3,
    // Kept for the shared wire mirror; collector evaluation reads dataDir.
    modelsDir: configDir,
    modelsDirFreeGb: dataDirFreeGb,
    dataDir: configDir,
    dataDirFreeGb,
  };
}

function toDoctorSyncStatus(status: SourceStatus): SyncStatusEntry {
  const state: SyncStatusEntry["state"] =
    status.state === "disabled"
      ? "paused"
      : status.state === "idle" && status.lastSyncAt
        ? "synced"
        : status.state;
  return {
    sourceId: status.sourceId,
    state,
    lastSyncAt: status.lastSyncAt ?? null,
    ...(status.lastError ? { errorMessage: status.lastError } : {}),
    ...(status.remediation ? { remediation: sanitizeSyncRemediation(status.remediation) } : {}),
  };
}

/** Keep remediation useful while removing its host-specific executable path. */
function sanitizeSyncRemediation(remediation: SyncRemediation): SyncRemediation {
  const executable = remediation.executable;
  const sanitize = (value: string): string =>
    executable ? value.split(executable).join("<collector-executable>") : value;
  return {
    summary: sanitize(remediation.summary),
    steps: remediation.steps.map(sanitize),
    restartRequired: remediation.restartRequired,
  };
}
