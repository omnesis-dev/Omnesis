// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { type DeviceCapability, type DeviceId, type Scope, type TokenId } from "@omnesis/types";
import { GATEWAY_VERSION } from "../../version.js";
import { lookupSession } from "../../data/repositories/TokenRepository.js";
import { applyPendingSelfInfo } from "../../write-gate.js";
import type Database from "better-sqlite3";
import type { WriteGate } from "../../write-gate.js";
import type { StatusCache } from "./StatusCache.js";

type Db = Database.Database;

const log = createLogger("gateway:http").child("auth");

export interface AuthServiceDeps {
  db: Db;
  writeGate: WriteGate;
  statusCache: StatusCache;
  /**
   * Portal session-cookie TTL (ms). Sourced from
   * `gateway.timings.sessionTtl` via `runtime-settings.ts`. Falls
   * back to 30d when omitted (test path).
   */
  sessionTtlMs?: number;
  /**
   * Minimum interval between sliding-session refresh writes. Sourced from
   * `gateway.timings.sessionRefreshThrottle`; defaults to 1h.
   */
  sessionRefreshThrottleMs?: number;
  /**
   * Pair-redeem helper. Resolves the pending name + creates or replaces a
   * device row, returning either the device or a 409 error response. The
   * gateway-level helper handles offline-replace + name-collision logic;
   * the service is just the consumer.
   */
  createOrReplaceDeviceForPair: (
    pendingName: string,
    kind: "portal",
    capabilities: DeviceCapability,
  ) => Promise<{ device: { id: DeviceId; name: string } } | { error: string; status: 409 }>;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 30 * ONE_DAY_MS;
export const DEFAULT_SESSION_REFRESH_THROTTLE_MS = 60 * 60 * 1000;

export function sessionRefreshThrottleMs(
  sessionTtlMs: number,
  configuredThrottleMs: number = DEFAULT_SESSION_REFRESH_THROTTLE_MS,
): number {
  return Math.max(1, Math.min(configuredThrottleMs, Math.floor(sessionTtlMs / 2)));
}

export function shouldRefreshSessionActivity(
  lastActiveAt: number | null,
  nowMs: number,
  throttleMs: number,
): boolean {
  return lastActiveAt === null || lastActiveAt <= nowMs - throttleMs;
}

export function scheduleSessionRefresh(
  writeGate: Pick<WriteGate, "refreshSessionActivity">,
  sessionId: string,
  lastActiveAt: number | null,
  sessionTtlMs: number = DEFAULT_SESSION_TTL_MS,
  configuredThrottleMs?: number,
): boolean {
  const throttleMs = sessionRefreshThrottleMs(sessionTtlMs, configuredThrottleMs);
  if (!shouldRefreshSessionActivity(lastActiveAt, Date.now(), throttleMs)) return false;
  void writeGate.refreshSessionActivity(sessionId, sessionTtlMs, throttleMs).catch(() => {
    /* beacon */
  });
  return true;
}

export interface LoginSuccess {
  ok: true;
  scopes: readonly Scope[];
  sessionId: string;
}

export interface LoginFailure {
  ok: false;
  error: string;
  status: 400 | 401 | 409;
}

export type LoginResult = LoginSuccess | LoginFailure;

export interface SessionInfo {
  authenticated: boolean;
  scopes?: readonly Scope[];
  refreshCookie?: boolean;
}

/**
 * Auth flows backing the portal cookie session. The service returns plain
 * data; the route handler shapes the cookie header so the cookie format
 * stays in one place close to the response.
 */
export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async login(
    rawTokenOrCode: string,
    opts: { deviceName?: string; installId?: string } = {},
  ): Promise<LoginResult> {
    const { writeGate: w, statusCache, createOrReplaceDeviceForPair } = this.deps;
    const raw = rawTokenOrCode.trim();
    if (!raw) {
      return { ok: false, error: "Token or pairing code required", status: 400 };
    }

    let tokenId: TokenId;
    let scopes: readonly Scope[];
    if (/^[0-9a-fA-F]{10}$/.test(raw)) {
      // Consume the code only if it was minted for the portal. A device code
      // (cli/ios/…) is left intact and reported as a generic miss, so a portal
      // login attempt can't burn a non-portal pairing code.
      const pending = await w.consumePairing(raw.toUpperCase(), "portal");
      if (!pending) {
        return { ok: false, error: "Invalid or expired pairing code", status: 401 };
      }
      // The portal is static files this gateway serves, so its build is this
      // build. Stamping it here is what keeps a portal row from reading as
      // "unknown" forever — it never opens a device socket of its own.
      const portalCaps: DeviceCapability = { platform: "web", version: GATEWAY_VERSION };
      // A nameless portal pairing (no admin name on the code) would otherwise
      // resolve to the shared canonical `portal` device name and collapse every
      // browser onto one row — each new login then replaces that row and
      // cascade-deletes the previous browser's session. The browser-supplied
      // stable name becomes the device's `suggestedName` so distinct browsers
      // keep distinct rows; `resolveDeviceName` still lets an explicit admin
      // name on the code win over it.
      const suggestedName = opts.deviceName?.trim();
      if (suggestedName) portalCaps.suggestedName = suggestedName;
      // The browser's install identity is the adoption key on re-login, so
      // a renamed portal device keeps its row.
      const installId = opts.installId?.trim();
      if (installId) portalCaps.installId = installId;
      const result = await createOrReplaceDeviceForPair(pending.name, "portal", portalCaps);
      if ("error" in result) return { ok: false, error: result.error, status: result.status };
      const device = result.device;
      // #284 — apply any self annotation staged on the pairing code.
      await applyPendingSelfInfo(w, device.id, pending);
      const minted = await w.createToken(device.id, pending.scopes, "paired");
      tokenId = minted.id;
      scopes = pending.scopes;
      statusCache.bump();
      log.info(`Portal paired via code: ${device.name} id=${device.id}`);
    } else {
      const tokenInfo = await w.validateToken(raw);
      if (!tokenInfo) {
        return { ok: false, error: "Invalid token", status: 401 };
      }
      tokenId = tokenInfo.id;
      scopes = tokenInfo.scopes;
    }

    const ttlMs = this.deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    const sessionId = await w.createSession(tokenId, scopes, ttlMs);
    return { ok: true, scopes, sessionId };
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId) {
      await this.deps.writeGate.deleteSession(sessionId);
    }
  }

  /**
   * Resolve session-cookie state for the portal. Expired sessions are
   * purged in the background so subsequent requests don't keep tripping
   * the same lookup.
   */
  getSession(sessionId: string | undefined): SessionInfo {
    if (!sessionId) return { authenticated: false };
    const { db, writeGate: w } = this.deps;
    const { info: session, expired } = lookupSession(db, sessionId);
    if (!session) {
      if (expired) {
        void w.purgeExpiredSession(sessionId).catch(() => {
          /* beacon */
        });
      }
      return { authenticated: false };
    }
    const refreshCookie = scheduleSessionRefresh(
      w,
      sessionId,
      session.lastActiveAt,
      this.deps.sessionTtlMs,
      this.deps.sessionRefreshThrottleMs,
    );
    return { authenticated: true, scopes: session.scopes, refreshCookie };
  }
}
