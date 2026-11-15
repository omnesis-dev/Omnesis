// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { RelayError } from "./tunnels.js";
import { connectionClientAddress } from "./proxy-protocol.js";
import { forwardedClientAddress } from "./cdn-front.js";
import { clientBucket } from "./client-bucket.js";

/**
 * Where a request came from: the client a trusted reverse proxy named for it,
 * otherwise the address a trusted PROXY protocol front layer reported for its
 * connection, otherwise the TCP peer.
 */
export type AdmissionClient =
  | {
      socket?: {
        remoteAddress?: string;
        remotePort?: number;
        localAddress?: string;
        localPort?: number;
      };
    }
  | undefined;

/** The rate-limit bucket for a request's client; see {@link clientBucket}. */
export function admissionClientKey(client: AdmissionClient): string | undefined {
  const address = forwardedClientAddress(client) ?? connectionClientAddress(client?.socket);
  return address ? clientBucket(address) : undefined;
}

export interface LoginLimits {
  maxConcurrent: number;
  maxPerMinute: number;
  /** Defaults to half the global concurrency, rounded up. */
  maxConcurrentPerClient?: number;
  /** Defaults to a third of the global rate, rounded up. */
  maxPerMinutePerClient?: number;
}

/**
 * Gateways proving their keys for a routing session (about once an hour each, and all at once
 * after a relay restart) and DNS challenges for their certificates. They have their own budget,
 * so a flood of sign-ins can never stop gateways renewing their tunnels.
 */
export const DEFAULT_GATEWAY_LOGIN_LIMITS = {
  maxConcurrent: 32,
  maxPerMinute: 600,
  maxConcurrentPerClient: 4,
  maxPerMinutePerClient: 30,
} as const satisfies Required<LoginLimits>;

/** Fills each limit `limits` leaves unset from `defaults`. */
export function withLoginDefaults(
  limits: Partial<LoginLimits> | undefined,
  defaults: Required<LoginLimits>,
): Required<LoginLimits> {
  return {
    maxConcurrent: limits?.maxConcurrent ?? defaults.maxConcurrent,
    maxPerMinute: limits?.maxPerMinute ?? defaults.maxPerMinute,
    maxConcurrentPerClient: limits?.maxConcurrentPerClient ?? defaults.maxConcurrentPerClient,
    maxPerMinutePerClient: limits?.maxPerMinutePerClient ?? defaults.maxPerMinutePerClient,
  };
}

interface ClientUse {
  active: number;
  attempts: number;
}

/**
 * Global bounds include unauthenticated callers and slow request bodies. Each
 * client address also has its own smaller bounds, so one caller cannot use up
 * the global ones for everybody else.
 */
export class LoginAdmission {
  private active = 0;
  private window = -1;
  private attempts = 0;
  private readonly clients = new Map<string, ClientUse>();
  private readonly maxConcurrentPerClient: number;
  private readonly maxPerMinutePerClient: number;

  constructor(
    private readonly maxConcurrent = 8,
    private readonly maxPerMinute = 60,
    perClient: { maxConcurrent?: number; maxPerMinute?: number } = {},
  ) {
    this.maxConcurrentPerClient = perClient.maxConcurrent ?? Math.ceil(maxConcurrent / 2);
    this.maxPerMinutePerClient = perClient.maxPerMinute ?? Math.ceil(maxPerMinute / 3);
    for (const limit of [
      maxConcurrent,
      maxPerMinute,
      this.maxConcurrentPerClient,
      this.maxPerMinutePerClient,
    ]) {
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new Error("Login limits must be positive integers");
    }
  }

  static fromLimits(limits: LoginLimits | undefined): LoginAdmission {
    return new LoginAdmission(limits?.maxConcurrent, limits?.maxPerMinute, {
      maxConcurrent: limits?.maxConcurrentPerClient,
      maxPerMinute: limits?.maxPerMinutePerClient,
    });
  }

  snapshot(): {
    activeLogins: number;
    loginAttempts: number;
    maxConcurrentLogins: number;
    maxLoginsPerMinute: number;
  } {
    return {
      activeLogins: this.active,
      loginAttempts: this.window === Math.floor(Date.now() / 60_000) ? this.attempts : 0,
      maxConcurrentLogins: this.maxConcurrent,
      maxLoginsPerMinute: this.maxPerMinute,
    };
  }

  /** A sign-in attempt: counts against concurrency and the per-minute rate, globally and per client. */
  run<T>(work: () => Promise<T>, client: AdmissionClient): Promise<T> {
    return this.admit(work, client, true);
  }

  /**
   * Polling or cancelling an operation the caller already holds a secret for.
   * It holds a concurrency slot but is not a new attempt, so waiting for a
   * person to finish signing in does not use up the per-minute rate.
   */
  poll<T>(work: () => Promise<T>, client: AdmissionClient): Promise<T> {
    return this.admit(work, client, false);
  }

  private async admit<T>(work: () => Promise<T>, from: AdmissionClient, attempt: boolean) {
    this.roll();
    const key = admissionClientKey(from);
    const known = key === undefined ? undefined : this.clients.get(key);
    if (
      this.active >= this.maxConcurrent ||
      (attempt && this.attempts >= this.maxPerMinute) ||
      (known &&
        (known.active >= this.maxConcurrentPerClient ||
          (attempt && known.attempts >= this.maxPerMinutePerClient)))
    )
      throw new RelayError(429, "Login capacity reached");
    // Entries exist only for running work or this window's admitted attempts,
    // so the map is bounded by the global limits.
    const use = key === undefined ? undefined : (known ?? { active: 0, attempts: 0 });
    if (key !== undefined && !known) this.clients.set(key, use!);
    this.active++;
    if (use) use.active++;
    if (attempt) {
      this.attempts++;
      if (use) use.attempts++;
    }
    try {
      return await work();
    } finally {
      this.active--;
      if (use && --use.active === 0 && use.attempts === 0) this.clients.delete(key!);
    }
  }

  private roll(): void {
    const window = Math.floor(Date.now() / 60_000);
    if (window === this.window) return;
    this.window = window;
    this.attempts = 0;
    for (const [key, use] of this.clients) {
      if (use.active === 0) this.clients.delete(key);
      else use.attempts = 0;
    }
  }
}
