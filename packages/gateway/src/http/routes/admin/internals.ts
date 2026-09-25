// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, WS_INVALID_INPUT } from "@omnesis/core";
import { type DeviceId, type SourceId } from "@omnesis/types";
import { BadGatewayError, ServiceUnavailableError, ValidationError } from "../../errors.js";
import { clientAddress, isLoopbackClient, isLoopbackIp } from "../../client-ip.js";
import { WsCommandError, type DeviceWsServer } from "../../../ws.js";
import type { TlsLifecycleService } from "../../../tls-lifecycle/service.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { Context } from "hono";
import type Database from "better-sqlite3";
import type { SyncStatusRegistry } from "../../../sync-status.js";
import type { AuthFlowRegistry } from "../../../auth-flows.js";
import type { ImportFlowRegistry } from "../../../import-flows.js";
import type { WriteGate } from "../../../write-gate.js";
import type { AccessService } from "../../../access/service.js";
import type { MetricsRegistry } from "../../../metrics.js";
import type { SchedulerMetricsSnapshot } from "../../../scheduler/index.js";
import type { StatusCache } from "../../services/StatusCache.js";
import type { SourceService } from "../../services/SourceService.js";
import type { DeviceService } from "../../services/DeviceService.js";
import type { PushRegistrationService } from "../../services/PushRegistrationService.js";
import type { DoctorService } from "../../services/DoctorService.js";
import type { DeviceDoctorService } from "../../services/DeviceDoctorService.js";
import type { PairingService } from "../../services/PairingService.js";
import type { WatermarkService } from "../../services/WatermarkService.js";
import type { SourceUrlRecanonicalizationService } from "../../../domain/SourceUrlRecanonicalization.js";

export type Db = Database.Database;

export const log = createLogger("gateway:http").child("routes:admin");

/**
 * Dependency bundle for the admin route mounts. Each per-subdomain mount
 * (`mountObservabilityRoutes`, `mountDeviceRoutes`, …) takes the same
 * bundle so the façade in `admin.ts` can compose them with one call. The
 * sub-mounts only read the fields they need.
 */
export type TlsLifecyclePort = Pick<TlsLifecycleService, "snapshot" | "activateFromDisk" | "renew">;

export interface AdminRoutesDeps {
  db: Db;
  writeGate: WriteGate;
  sourceUrlRecanonicalization: SourceUrlRecanonicalizationService;
  /** Read the live unified config. */
  getConfig?: () => OmnesisConfig;
  /** Live push-plan facts and carrier identity resolution. */
  pushPlan?: {
    getRelaySettings(): { enabled: boolean; url: string; visible?: boolean };
    getFcmProjectId(): Promise<string | undefined>;
  };
  statusCache: StatusCache;
  /**
   * The access layer, for the one admin surface that reports on it: whether a
   * paired agent device can still reach the corpus on its own.
   */
  accessService: AccessService;
  sourceService: SourceService;
  deviceService: DeviceService;
  pushRegistrationService: PushRegistrationService;
  indexDb?: Db;
  wsServer?: DeviceWsServer;
  authFlows?: AuthFlowRegistry;
  importFlows?: ImportFlowRegistry;
  metrics?: MetricsRegistry;
  processVitals?: {
    snapshot(windowSeconds: number): import("../../../process-vitals.js").ProcessVitalsSnapshot;
  };
  scheduler?: {
    snapshot(windowSeconds: number): SchedulerMetricsSnapshot;
    pauseBackground(): void;
    resumeBackground(): void;
    isBackgroundPaused(): boolean;
    kickPeriodicAndWait(taskName: string, timeoutMs?: number): Promise<unknown>;
    quiescePeriodics(): void;
  };
  backgroundJobs?: import("../../../background-jobs/index.js").BackgroundJobsRegistry;
  /**
   * Search snapshot handle for `/admin/search-snapshot/refresh`. When
   * unset (snapshot isolation disabled in config), the route returns
   * 503. Kept as a narrow interface so the route doesn't import the
   * concrete handle class.
   */
  searchSnapshot?: {
    refresh(): Promise<number>;
    stats(): {
      readonly openedAt: number;
      readonly refreshCount: number;
      readonly lastRefreshAt: number | null;
      readonly lastRefreshDurationMs: number;
      readonly refreshErrors: number;
    };
  };
  /**
   * Default pairing-code TTL applied when `/admin/devices/pair` body
   * omits an explicit `ttlMs`. Sourced from `gateway.timings.pairingTtl`
   * via `runtime-settings.ts`. Body-supplied values still win.
   */
  pairingTtlMs?: number;
  /**
   * Externally-reachable HTTPS base URL of this gateway (no trailing
   * slash), sourced from `gateway.publicBaseUrl` via `runtime-settings.ts`.
   * Forwarded in the `auth.begin` command so a source's `authFlow` builds
   * its OAuth redirect URI as `${publicBaseUrl}/oauth/callback` instead of
   * relying on a same-machine localhost callback. Unset → providers keep
   * the local-only `localhost:3003` fallback.
   */
  publicBaseUrl?: string;
  /**
   * SHA-256 fingerprint (lowercase hex, no colons) of the TLS leaf cert
   * the gateway is currently serving. Echoed in `/admin/devices/pair` so
   * the CLI can include it in the V3 QR payload — iOS pins it on first
   * connect (TOFU). A function is read per request, so a certificate
   * activated after boot is what new pairings pin. Optional only so unit
   * tests that build a server without TLS wiring can omit it; the field is
   * always populated by `index.ts` at runtime.
   */
  tlsFingerprintSha256?: string | (() => string);
  /** The served certificate's lifecycle; absent in compositions without TLS wiring. */
  tlsLifecycle?: TlsLifecyclePort;
  systemTrustPairingOrigins?: readonly string[] | (() => readonly string[]);
  /** Hosts the served certificate covers with a publicly trusted chain, at any port. */
  publiclyTrustedPairingHosts?: () => readonly string[];
  /** The port the gateway listens on: where a phone reaches a discovered host address. */
  gatewayPort?: number;
  /** The `.local` name the gateway advertises with only real LAN addresses, or null. */
  advertisedPairingHost?: () => string | null;
  /** When the served certificate will next be replaced by the gateway, or null. */
  certificateRenewsAt?: () => Date | null;
  resolveCollectorDeviceId: (requested?: string) => Promise<DeviceId | Response>;
  /**
   * Source-type-aware variant — filters online collectors to those
   * advertising the given sourceType in `capabilities.hostableSourceTypes`.
   * Used by `/admin/sources/add` so the user isn't prompted to pick
   * between collectors that physically can't host the source.
   */
  resolveCollectorDeviceIdForType: (
    requested: string | undefined,
    sourceType: string,
  ) => Promise<DeviceId | Response>;
  /**
   * Reauth variant — looks up which device already hosts source(s) for
   * the given accountId and dispatches there. Avoids the "which collector
   * has my gmail account?" footgun in multi-collector setups.
   */
  resolveCollectorDeviceIdForReauth: (
    requested: string | undefined,
    accountId: string,
    sourceType?: string,
  ) => Promise<DeviceId | Response>;
  deviceForSource: (id: SourceId) => DeviceId | null;
  pairingService: PairingService;
  /** Backs `GET /admin/doctor`. */
  doctorService: DoctorService;
  /** Backs the durable collector-local fleet doctor routes. */
  deviceDoctorService: DeviceDoctorService;
  /** Portal-session-only gateway-host update orchestration. */
  hostFleetUpdateService?: import("../../services/HostFleetUpdateService.js").HostFleetUpdateService;
  /** Shared current-version fleet service used by device routes and host-update planning. */
  fleetUpdateService?: import("../../services/FleetUpdateService.js").FleetUpdateService;
  watermarkService: WatermarkService;
}

/**
 * Common shape for the WS-proxy admin routes:
 *   - resolve the target device (404/503/400 from the resolver)
 *   - require a wsServer (else 503 — gateway-side dep not configured)
 *   - dispatch + map any error to 502 BadGateway (remote dep rejected)
 */
export async function wsProxy<T extends Record<string, unknown>>(
  c: Context,
  requestedDevice: string | undefined,
  resolveCollectorDeviceId: AdminRoutesDeps["resolveCollectorDeviceId"],
  wsServer: DeviceWsServer | undefined,
  op: (deviceId: DeviceId) => Promise<T>,
): Promise<Response> {
  const deviceId = await resolveCollectorDeviceId(requestedDevice);
  if (typeof deviceId !== "string") return deviceId;
  if (!wsServer) throw new ServiceUnavailableError("no WS server");
  try {
    const result = await op(deviceId);
    return c.json({ deviceId, ...result });
  } catch (err) {
    // A device that refused the input is answering the caller, not failing:
    // the request is what needs changing.
    if (err instanceof WsCommandError && err.code === WS_INVALID_INPUT) {
      throw new ValidationError(err.reason);
    }
    throw new BadGatewayError(err instanceof Error ? err.message : String(err));
  }
}

export { isLoopbackIp };

/** Best-effort client address for rate limiting and audit lines; see `client-ip.ts`. */
export function clientIp(c: Context): string {
  return clientAddress((name) => c.req.header(name), c.env);
}

/**
 * Whether the request originated on the gateway host; the rate limiters
 * exempt such callers. See `client-ip.ts` for what that requires when a
 * reverse proxy is trusted.
 */
export function isLoopbackRequest(c: Context): boolean {
  return isLoopbackClient((name) => c.req.header(name), c.env);
}
