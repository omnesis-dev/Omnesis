// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export interface RollingLimit {
  limit: number;
  windowMs: number;
}

export interface RelayAbuseLimits {
  enrol: RollingLimit;
  verify: RollingLimit;
  invalidWake: RollingLimit;
  globalEnrol: RollingLimit;
  renewalEnrol: RollingLimit;
  carrierFailures: RollingLimit;
  maxTrackedSources: number;
}

export type AbuseDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "source_rate" | "carrier_failure_penalty" | "global_circuit";
      retryAfterMs: number;
    };

interface SourceState {
  enrol: number[];
  verify: number[];
  invalidWake: number[];
  carrierFailures: number[];
  verifiedUntil: number;
}

/** Process-local, bounded admission control. Source identifiers never leave this object. */
export class RelayAbuseGuard {
  private readonly sources = new Map<string, SourceState>();
  private readonly unverifiedSources = new Set<string>();
  private readonly globalEnrol: number[] = [];
  private readonly renewalEnrol: number[] = [];
  private readonly sourcePruneIntervalMs: number;
  private nextSourcePruneAt = 0;

  constructor(private readonly limits: RelayAbuseLimits) {
    this.sourcePruneIntervalMs = Math.min(
      limits.enrol.windowMs,
      limits.verify.windowMs,
      limits.invalidWake.windowMs,
      limits.carrierFailures.windowMs,
    );
  }

  admitEnrol(source: string, now: number): AbuseDecision {
    const state = this.sourceState(source, now);
    const failure = inspectWindow(state.carrierFailures, this.limits.carrierFailures, now);
    if (!failure.allowed) return { ...failure, reason: "carrier_failure_penalty" };
    return consumeWindow(state.enrol, this.limits.enrol, now, "source_rate");
  }

  admitVerify(source: string, now: number): AbuseDecision {
    const state = this.sourceState(source, now);
    return consumeWindow(state.verify, this.limits.verify, now, "source_rate");
  }

  admitInvalidWake(source: string, now: number): AbuseDecision {
    const state = this.sourceState(source, now);
    return consumeWindow(state.invalidWake, this.limits.invalidWake, now, "source_rate");
  }

  reserveGlobalEnrol(now: number): AbuseDecision {
    return consumeWindow(this.globalEnrol, this.limits.globalEnrol, now, "global_circuit");
  }

  reserveRenewalEnrol(now: number): AbuseDecision {
    return consumeWindow(this.renewalEnrol, this.limits.renewalEnrol, now, "global_circuit");
  }

  recordCarrierChallengeFailure(source: string, now: number): void {
    const state = this.sourceState(source, now);
    consumeWindow(state.carrierFailures, this.limits.carrierFailures, now, "source_rate");
  }

  recordCarrierChallengeSuccess(source: string, now: number): void {
    const state = this.sources.get(source);
    if (!state) return;
    pruneWindow(state.carrierFailures, this.limits.carrierFailures.windowMs, now);
    state.carrierFailures.shift();
    this.touchSource(source, state, now);
  }

  recordVerificationSuccess(source: string, now: number): void {
    const state = this.sources.get(source);
    if (!state) return;
    state.verifiedUntil = now + this.limits.verify.windowMs;
    this.unverifiedSources.delete(source);
    this.touchSource(source, state, now);
  }

  private sourceState(source: string, now: number): SourceState {
    const existing = this.sources.get(source);
    if (existing) {
      this.touchSource(source, existing, now);
      return existing;
    }
    if (now >= this.nextSourcePruneAt) {
      this.pruneSources(now);
      this.nextSourcePruneAt = now + this.sourcePruneIntervalMs;
    }
    if (this.sources.size >= this.limits.maxTrackedSources) {
      const eviction =
        this.unverifiedSources.values().next().value ?? this.sources.keys().next().value;
      if (eviction !== undefined) this.deleteSource(eviction);
    }
    const created: SourceState = {
      enrol: [],
      verify: [],
      invalidWake: [],
      carrierFailures: [],
      verifiedUntil: 0,
    };
    this.sources.set(source, created);
    this.unverifiedSources.add(source);
    return created;
  }

  private touchSource(source: string, state: SourceState, now: number): void {
    this.sources.delete(source);
    this.sources.set(source, state);
    if (state.verifiedUntil <= now) {
      state.verifiedUntil = 0;
      this.unverifiedSources.delete(source);
      this.unverifiedSources.add(source);
    }
  }

  private deleteSource(source: string): void {
    this.sources.delete(source);
    this.unverifiedSources.delete(source);
  }

  private pruneSources(now: number): void {
    for (const [source, state] of this.sources) {
      pruneWindow(state.enrol, this.limits.enrol.windowMs, now);
      pruneWindow(state.verify, this.limits.verify.windowMs, now);
      pruneWindow(state.invalidWake, this.limits.invalidWake.windowMs, now);
      pruneWindow(state.carrierFailures, this.limits.carrierFailures.windowMs, now);
      if (state.verifiedUntil <= now) state.verifiedUntil = 0;
      if (
        state.enrol.length === 0 &&
        state.verify.length === 0 &&
        state.invalidWake.length === 0 &&
        state.carrierFailures.length === 0
      ) {
        this.deleteSource(source);
      }
    }
    this.unverifiedSources.clear();
    for (const [source, state] of this.sources) {
      if (state.verifiedUntil === 0) this.unverifiedSources.add(source);
    }
  }
}

function consumeWindow(
  events: number[],
  limit: RollingLimit,
  now: number,
  reason: "source_rate" | "global_circuit",
): AbuseDecision {
  const inspected = inspectWindow(events, limit, now);
  if (!inspected.allowed) return { ...inspected, reason };
  events.push(now);
  return { allowed: true };
}

function inspectWindow(
  events: number[],
  limit: RollingLimit,
  now: number,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  pruneWindow(events, limit.windowMs, now);
  if (events.length < limit.limit) return { allowed: true };
  return { allowed: false, retryAfterMs: Math.max(1, events[0]! + limit.windowMs - now) };
}

function pruneWindow(events: number[], windowMs: number, now: number): void {
  let expired = 0;
  const cutoff = now - windowMs;
  while (expired < events.length && events[expired]! <= cutoff) expired += 1;
  if (expired > 0) events.splice(0, expired);
}
