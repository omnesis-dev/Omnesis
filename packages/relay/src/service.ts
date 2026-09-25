// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@omnesis/core";

import { digestSecret, type RateLimitDecision, type RelayStore } from "./store.js";
import { RelayMetrics } from "./metrics.js";
import { CarrierDispatchError, systemClock } from "./types.js";
import type { Clock, RandomSource, RelayCarrier, RelayPlatform, RelayTarget } from "./types.js";
import type { AbuseDecision, RelayAbuseGuard } from "./abuse.js";

const log = createLogger("relay");

export const RELAY_CHALLENGE_TTL_MS = 2 * 60_000;
export const RELAY_MAX_PENDING_CHALLENGES = 1_000;
const NEW_ENROLMENT_CAPACITY_SHARE = 0.9;
export const RELAY_PRUNE_INTERVAL_MS = 60_000;
export const RELAY_CREDENTIAL_PREFIX = "omnrelay_v1_";

const systemRandom: RandomSource = {
  bytes: randomBytes,
  uuid: randomUUID,
};

export type RelayServiceErrorCode =
  | "identity_not_covered"
  | "carrier_unavailable"
  | "challenge_rejected"
  | "credential_rejected"
  | "rate_limited"
  | "capacity_unavailable"
  | "carrier_failed";

export class RelayServiceError extends Error {
  constructor(
    readonly code: RelayServiceErrorCode,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "RelayServiceError";
  }
}

export interface RelayServiceOptions {
  store: RelayStore;
  carriers: readonly RelayCarrier[];
  clock?: Clock;
  random?: RandomSource;
  metrics?: RelayMetrics;
  pruneIntervalMs?: number | null;
  abuseGuard?: RelayAbuseGuard;
  challengeTtlMs?: number;
  maxPendingChallenges?: number;
}

export class RelayService {
  private readonly store: RelayStore;
  private readonly carriers: ReadonlyMap<RelayPlatform, RelayCarrier>;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly metrics: RelayMetrics;
  private readonly pruneTimer: ReturnType<typeof setInterval> | null;
  private readonly abuseGuard: RelayAbuseGuard | null;
  private readonly challengeTtlMs: number;
  private readonly maxPendingChallenges: number;

  constructor(opts: RelayServiceOptions) {
    this.store = opts.store;
    this.carriers = new Map(opts.carriers.map((carrier) => [carrier.platform, carrier]));
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? systemRandom;
    this.metrics = opts.metrics ?? new RelayMetrics();
    this.abuseGuard = opts.abuseGuard ?? null;
    this.challengeTtlMs = opts.challengeTtlMs ?? RELAY_CHALLENGE_TTL_MS;
    this.maxPendingChallenges = opts.maxPendingChallenges ?? RELAY_MAX_PENDING_CHALLENGES;
    const pruneIntervalMs = opts.pruneIntervalMs ?? RELAY_PRUNE_INTERVAL_MS;
    this.pruneTimer =
      opts.pruneIntervalMs === null
        ? null
        : setInterval(() => this.observePrune(), pruneIntervalMs);
    this.pruneTimer?.unref();
  }

  async enrol(target: RelayTarget, source?: string): Promise<{ challengeId: string }> {
    this.enforceAbuse(
      "enrol",
      this.abuseGuard && source ? this.abuseGuard.admitEnrol(source, this.clock.now()) : null,
    );
    const carrier = this.carriers.get(target.platform);
    if (!carrier) {
      this.metrics.enrol(target.platform, "rejected");
      throw new RelayServiceError(
        "carrier_unavailable",
        `relay has no ${target.platform} carrier configured`,
      );
    }
    if (!carrier.covers(target.appId)) {
      this.metrics.enrol(target.platform, "rejected");
      throw new RelayServiceError(
        "identity_not_covered",
        `relay credentials do not cover app identity '${target.appId}'`,
      );
    }

    this.observePrune();
    const now = this.clock.now();
    const renewal = this.store.hasActiveCredentialForTarget(target);
    const challengeId = this.random.uuid();
    const nonce = this.random.bytes(32).toString("base64url");
    const created = this.store.tryCreateChallenge(
      {
        id: challengeId,
        target,
        nonceHash: digestSecret(nonce),
        createdAt: now,
        expiresAt: now + this.challengeTtlMs,
      },
      renewal
        ? this.maxPendingChallenges
        : Math.max(1, Math.floor(this.maxPendingChallenges * NEW_ENROLMENT_CAPACITY_SHARE)),
    );
    if (!created) {
      this.metrics.abuseRejected("enrol", "challenge_capacity");
      throw new RelayServiceError("capacity_unavailable", "relay enrolment capacity is exhausted");
    }
    const globalDecision = renewal
      ? this.abuseGuard?.reserveRenewalEnrol(this.clock.now())
      : this.abuseGuard?.reserveGlobalEnrol(this.clock.now());
    if (globalDecision && !globalDecision.allowed) {
      this.store.deleteChallenge(challengeId);
      this.enforceAbuse("enrol", globalDecision);
    }
    const startedAt = this.clock.now();
    try {
      await carrier.sendChallenge(target, nonce);
      if (this.abuseGuard && source) {
        this.abuseGuard.recordCarrierChallengeSuccess(source, this.clock.now());
      }
      this.metrics.carrier(target.platform, "success", "none", this.clock.now() - startedAt);
    } catch (err) {
      const reason = this.observeCarrierError(target.platform, err);
      this.metrics.carrier(target.platform, "failure", reason, this.clock.now() - startedAt);
      this.metrics.enrol(target.platform, "failed");
      this.store.deleteChallenge(challengeId);
      if (this.abuseGuard && source) {
        this.abuseGuard.recordCarrierChallengeFailure(source, this.clock.now());
      }
      log.warn(`challenge dispatch failed for ${target.platform}`);
      throw new RelayServiceError("carrier_failed", "carrier rejected the enrolment challenge");
    }
    return { challengeId };
  }

  verify(challengeId: string, nonce: string, source?: string): { credential: string } {
    this.enforceAbuse(
      "verify",
      this.abuseGuard && source ? this.abuseGuard.admitVerify(source, this.clock.now()) : null,
    );
    const platform = this.store.challengePlatform(challengeId);
    const credential = `${RELAY_CREDENTIAL_PREFIX}${this.random.bytes(32).toString("base64url")}`;
    const target = this.store.verifyChallengeAndCreateCredential({
      challengeId,
      nonceHash: digestSecret(nonce),
      credentialHash: digestSecret(credential),
      now: this.clock.now(),
    });
    if (!target) {
      if (platform) this.metrics.enrol(platform, "rejected");
      throw new RelayServiceError(
        "challenge_rejected",
        "challenge is invalid, expired, already used, or the nonce did not match",
      );
    }
    if (this.abuseGuard && source) {
      this.abuseGuard.recordVerificationSuccess(source, this.clock.now());
    }
    this.metrics.enrol(target.platform, "accepted");
    return { credential };
  }

  async wake(credential: string, source?: string): Promise<void> {
    if (!validCredentialShape(credential)) {
      this.enforceAbuse(
        "wake",
        this.abuseGuard && source
          ? this.abuseGuard.admitInvalidWake(source, this.clock.now())
          : null,
      );
      this.metrics.wakeRejected("unknown_credential");
      throw new RelayServiceError("credential_rejected", "credential is invalid or revoked");
    }
    const credentialHash = digestSecret(credential);
    const target = this.store.lookupCredential(credentialHash);
    if (!target) {
      this.enforceAbuse(
        "wake",
        this.abuseGuard && source
          ? this.abuseGuard.admitInvalidWake(source, this.clock.now())
          : null,
      );
      this.metrics.wakeRejected("unknown_credential");
      throw new RelayServiceError("credential_rejected", "credential is invalid or revoked");
    }

    const decision = this.store.consumeRateLimit(credentialHash, this.clock.now());
    if (!decision.allowed) {
      this.metrics.wakeRejected("rate_limited");
      throw rateLimitError(decision);
    }

    const carrier = this.carriers.get(target.platform);
    if (!carrier || !carrier.covers(target.appId)) {
      this.metrics.wakeRejected("unknown_identity");
      this.metrics.wake(target.platform, "failed");
      throw new RelayServiceError(
        "carrier_unavailable",
        "the carrier credential no longer covers this app identity",
      );
    }
    const startedAt = this.clock.now();
    try {
      await carrier.sendWake(target);
      this.metrics.carrier(target.platform, "success", "none", this.clock.now() - startedAt);
    } catch (err) {
      if (err instanceof CarrierDispatchError && err.kind === "stale_credential") {
        const reason = err.pruneReason;
        if (reason && this.store.revokeCredential(credentialHash, this.clock.now())) {
          this.metrics.credentialPruned(target.platform, reason);
        }
      }
      const reason = this.observeCarrierError(target.platform, err);
      this.metrics.carrier(target.platform, "failure", reason, this.clock.now() - startedAt);
      this.metrics.wake(target.platform, "failed");
      log.warn(`wake dispatch failed for ${target.platform}`);
      throw new RelayServiceError("carrier_failed", "carrier rejected the wake");
    }
    this.metrics.wake(target.platform, "sent");
  }

  health(): Record<RelayPlatform, ReturnType<RelayCarrier["health"]> | null> {
    return {
      ios: this.carriers.get("ios")?.health() ?? null,
      android: this.carriers.get("android")?.health() ?? null,
    };
  }

  observeMissingSource(endpoint: "enrol" | "verify" | "wake"): void {
    this.metrics.abuseRejected(endpoint, "missing_source");
  }

  async dispose(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    await Promise.all([...this.carriers.values()].map((carrier) => carrier.dispose()));
    this.store.close();
  }

  private observePrune(): void {
    const pruned = this.store.prune(this.clock.now());
    this.metrics.unansweredChallenge("ios", pruned.unansweredChallenges.ios);
    this.metrics.unansweredChallenge("android", pruned.unansweredChallenges.android);
  }

  private observeCarrierError(platform: RelayPlatform, err: unknown): CarrierDispatchError["kind"] {
    if (err instanceof CarrierDispatchError && err.kind === "credential_mint_failed") {
      this.metrics.credentialMintFailure(platform);
    }
    return err instanceof CarrierDispatchError ? err.kind : "other";
  }

  private enforceAbuse(
    endpoint: "enrol" | "verify" | "wake",
    decision: AbuseDecision | null,
  ): void {
    if (!decision || decision.allowed) return;
    this.metrics.abuseRejected(endpoint, decision.reason);
    if (decision.reason === "global_circuit") {
      throw new RelayServiceError(
        "capacity_unavailable",
        "relay enrolment is temporarily unavailable",
        decision.retryAfterMs,
      );
    }
    throw new RelayServiceError(
      "rate_limited",
      "request source exceeded the relay admission limit",
      decision.retryAfterMs,
    );
  }
}

function validCredentialShape(credential: string): boolean {
  if (!credential.startsWith(RELAY_CREDENTIAL_PREFIX)) return false;
  const secret = credential.slice(RELAY_CREDENTIAL_PREFIX.length);
  return /^[A-Za-z0-9_-]{43}$/.test(secret);
}

function rateLimitError(decision: RateLimitDecision): RelayServiceError {
  return new RelayServiceError(
    "rate_limited",
    `credential exceeded the ${decision.limit ?? "configured"} wake rate limit`,
    decision.retryAfterMs,
  );
}
