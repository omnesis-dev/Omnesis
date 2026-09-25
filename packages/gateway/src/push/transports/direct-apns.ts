// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Apple Push Notification service client. One process-wide instance is
 * created in `index.ts` when `gateway.apns` is configured in `omnesis.json`.
 * The push broadcaster uses it to send content-free wakes to paired iOS
 * devices that selected direct APNs delivery.
 *
 * Auth: token-based via a JWT signed with the .p8 key on disk
 * (`signApnsJwt`). The JWT is cached for ~45 minutes; Apple rejects
 * requests with a JWT older than ~one hour.
 *
 * Transport: HTTP/2, abstracted behind `ApnsTransport` so tests can
 * inject a fake.
 *
 * This client direct-dispatches to api.push.apple.com — that requires
 * a .p8 key issued under the Apple team that owns the iOS app's
 * bundle id. Self-hosted gateways pairing with the *official* App
 * Store app cannot mint such a key (Apple restricts issuance to the
 * bundle-id owner) and need a relay alternative.
 */

import { readFile } from "node:fs/promises";

import { createLogger, type Logger } from "@omnesis/core";
import { APNS_WAKE_JSON } from "@omnesis/core/push";

import { signApnsJwt } from "./apns-jwt.js";
import { Http2ApnsTransport, type ApnsTransport } from "./apns-http2.js";
import type { ApnsConfig, ApnsSendResult, ApnsWake } from "./apns-types.js";

const log: Logger = createLogger("gateway:apns:client");

const AUTHORITY_PRODUCTION = "https://api.push.apple.com";
const AUTHORITY_SANDBOX = "https://api.sandbox.push.apple.com";
/** Apple-required: JWT must be <1 hour old. We refresh well before that. */
const JWT_MAX_AGE_MS = 45 * 60_000;

const UNREGISTERED_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

export interface ApnsClientOptions {
  config: ApnsConfig;
  /** Override transport for tests. Defaults to a fresh Http2ApnsTransport. */
  transport?: ApnsTransport;
  /** Override clock for tests. */
  now?: () => number;
  /**
   * Override the APNs authority (origin only, e.g.
   * `http://127.0.0.1:5123`). When set, both the production and
   * sandbox hosts are replaced by this value — every send is routed
   * here regardless of the per-notification environment.
   *
   * This is infrastructure for two cases:
   *   - end-to-end tests that stand up a fake APNs server (see
   *     `packages/collector/src/e2e/fake-apns.ts`) and need the real
   *     HTTP/2 transport pointed at a local origin, and
   *   - an on-host APNs proxy/relay a future operator might run.
   *
   * Sourced from `gateway.apns.baseUrl` in `omnesis.json` or the
   * `OMNESIS_APNS_BASE_URL` env var; unset in normal operation.
   */
  baseUrl?: string;
}

export class ApnsClient {
  private readonly config: ApnsConfig;
  private readonly transport: ApnsTransport;
  private readonly ownsTransport: boolean;
  private readonly now: () => number;
  private readonly baseUrl: string | null;
  private keyPemPromise: Promise<string> | null = null;
  private cachedJwt: { token: string; mintedAtMs: number } | null = null;

  constructor(opts: ApnsClientOptions) {
    this.config = opts.config;
    if (opts.transport) {
      this.transport = opts.transport;
      this.ownsTransport = false;
    } else {
      this.transport = new Http2ApnsTransport();
      this.ownsTransport = true;
    }
    this.now = opts.now ?? (() => Date.now());
    this.baseUrl = opts.baseUrl ? opts.baseUrl.replace(/\/+$/, "") : null;
  }

  /** Build the single carrier-visible wake envelope. */
  static buildPayload(): string {
    return APNS_WAKE_JSON;
  }

  /**
   * Send one notification. Always resolves with a result — never
   * throws for an APNs-side rejection. Throws only for transport-
   * level failures (network unreachable, JWT signing error) so the
   * dispatcher can record those as `spawn-error` firings.
   */
  async send(n: ApnsWake): Promise<ApnsSendResult> {
    return this.sendBody(n, ApnsClient.buildPayload());
  }

  private async sendBody(n: ApnsWake, body: string): Promise<ApnsSendResult> {
    const env = n.environment ?? this.config.environment;
    const bundleId = n.bundleId ?? this.config.bundleId;
    const authority =
      this.baseUrl ?? (env === "production" ? AUTHORITY_PRODUCTION : AUTHORITY_SANDBOX);
    const jwt = await this.getJwt();
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      "apns-topic": bundleId,
      "apns-push-type": "alert",
    };
    const resp = await this.transport.request({
      authority,
      path: `/3/device/${n.deviceToken}`,
      headers,
      body,
    });

    if (resp.statusCode === 200) {
      return {
        ok: true,
        statusCode: 200,
        apnsId: resp.headers["apns-id"] ?? null,
      };
    }

    const reason = extractReason(resp.body);
    return {
      ok: false,
      statusCode: resp.statusCode,
      reason,
      rawBody: resp.body,
      unregistered: UNREGISTERED_REASONS.has(reason),
    };
  }

  async dispose(): Promise<void> {
    if (this.ownsTransport) {
      await this.transport.dispose();
    }
  }

  /**
   * Cached JWT. Read the .p8 once (lazily), then re-sign every
   * `JWT_MAX_AGE_MS`.
   */
  private async getJwt(): Promise<string> {
    const cached = this.cachedJwt;
    if (cached && this.now() - cached.mintedAtMs < JWT_MAX_AGE_MS) {
      return cached.token;
    }
    const keyPem = await this.getKeyPem();
    const mintedAtMs = this.now();
    const token = signApnsJwt({
      keyPem,
      keyId: this.config.keyId,
      teamId: this.config.teamId,
      nowSeconds: Math.floor(mintedAtMs / 1000),
    });
    this.cachedJwt = { token, mintedAtMs };
    return token;
  }

  private getKeyPem(): Promise<string> {
    if (!this.keyPemPromise) {
      this.keyPemPromise = readFile(this.config.keyPath, "utf8").catch((err) => {
        // Clear so a fixed-up config without a gateway restart can succeed
        // on the next send.
        this.keyPemPromise = null;
        log.warn(
          `failed to read APNs key at ${this.config.keyPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      });
    }
    return this.keyPemPromise;
  }
}

function extractReason(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    if (typeof parsed.reason === "string") return parsed.reason;
  } catch {
    // empty body or non-JSON — APNs may return an empty response on some
    // 5xx errors. Fall through to "".
  }
  return "";
}

/**
 * Re-export so consumers can pull the public surface from a single
 * entrypoint.
 */
export type { ApnsConfig, ApnsEnvironment, ApnsSendResult, ApnsWake } from "./apns-types.js";
