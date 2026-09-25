// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Public shapes for the gateway-side direct APNs client. The client itself
 * lives in `direct-apns.ts`; the HTTP/2 transport is split into
 * `apns-http2.ts` so tests can inject a fake without standing up a real
 * HTTP/2 server.
 *
 * Gateway-side config comes from `omnesis.json` under `gateway.apns`.
 */

export type ApnsEnvironment = "sandbox" | "production";

/**
 * Operator-supplied gateway config. The `keyPath` is read lazily on
 * first send so a misconfigured gateway can still boot — `notify-ios`
 * dispatches surface the read error as a `spawn-error` firing rather
 * than crashing the gateway.
 */
export interface ApnsConfig {
  /** Absolute path to the .p8 auth key issued by Apple Developer. */
  keyPath: string;
  /** 10-char Apple key id printed alongside the .p8 download. */
  keyId: string;
  /** Apple Developer team id (10-char alphanumeric). */
  teamId: string;
  /**
   * Default APNs topic. Sent as the `apns-topic` header. Each `send()`
   * call can override per-notification (the iOS app reports the
   * bundleId of its current build during APNs registration; the
   * dispatcher prefers that value when present so a single gateway
   * can serve Debug + TestFlight installs simultaneously).
   */
  bundleId: string;
  /** Default environment. Overridable per notification. */
  environment: ApnsEnvironment;
}

/** Addressing for one content-free APNs wake. */
export interface ApnsWake {
  /** Hex device token as registered by the iOS app. */
  deviceToken: string;
  /** Overrides config.bundleId for this notification. */
  bundleId?: string;
  /** Overrides config.environment for this notification. */
  environment?: ApnsEnvironment;
}

/**
 * Result returned by `ApnsClient.send()`. APNs uses HTTP status codes
 * + a JSON body with a `reason` string for the failure mode; we
 * surface both so the dispatcher can react (clear-token on
 * Unregistered / BadDeviceToken; retry on TooManyProviderTokenUpdates).
 */
export type ApnsSendResult =
  | { ok: true; statusCode: 200; apnsId: string | null }
  | {
      ok: false;
      statusCode: number;
      reason: string;
      rawBody: string;
      /** Either Apple-reported `Unregistered` or `BadDeviceToken`. */
      unregistered: boolean;
    };
