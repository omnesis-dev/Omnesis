// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { createLogger, toErrorMessage } from "@omnesis/core";
import { GatewayRequestRefused } from "./google-device-pairing.js";
import { GatewayTlsIdentityRefused } from "./pinned-key.js";
import {
  connectivityFailure,
  deadlineFailure,
  directCandidateSchema,
  type DirectCandidate,
} from "./direct-path.js";

const log = createLogger("cloud-relay:path");

type PathTransition = "local" | "lost" | "blocked";

/** How often a running adapter looks for the gateway's own network. */
export const PATH_CHECK_INTERVAL_MS = 15_000;
/** One home address gets this long to complete TCP, TLS and the authenticated reply. */
export const PATH_PROBE_MS = 750;
/**
 * A check that only timed out is repeated this soon before the home route is given up. One reply
 * that a busy gateway delivered late then costs nothing, and a route that really went silent is
 * still released a few seconds after the check that first missed it.
 */
export const PATH_CONFIRM_MS = 3_000;

/** The network itself answered that the address is not there. One such answer settles it. */
const UNREACHABLE = ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];

const key = (candidate: DirectCandidate): string => `${candidate.address}:${candidate.port}`;
const busy = (error: unknown): boolean =>
  error instanceof GatewayRequestRefused &&
  error.status !== undefined &&
  (error.status === 429 || (error.status >= 500 && error.status <= 599));

/**
 * Remembers whether this device is on the gateway's own network, so a connection opened away
 * from it goes straight to the relay instead of first waiting on addresses that cannot answer.
 * Probes are authenticated application requests over the saved TLS identity, never IP trust.
 */
export class AdaptiveGatewayPath {
  private hints: DirectCandidate[];
  private preferred?: string;
  private readonly shutdown = new AbortController();
  private readonly listeners = new Set<(event: PathTransition) => void>();
  private readonly reported = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private confirm?: ReturnType<typeof setTimeout>;
  private running = false;
  private closed = false;
  private local = false;
  private misses = 0;
  private refused?: Error;
  private retryTls = false;
  constructor(
    private readonly options: {
      candidates: DirectCandidate[];
      probe(candidate: DirectCandidate, signal: AbortSignal): Promise<unknown>;
      /** `dial` names the home addresses worth trying first; empty means the canonical route. */
      refresh?(
        saved: DirectCandidate[],
        signal: AbortSignal,
        dial: DirectCandidate[],
      ): Promise<DirectCandidate[]>;
      reverify?(signal: AbortSignal): Promise<void>;
      /** Called when the gateway reports different home addresses than the saved ones. */
      persist?(candidates: DirectCandidate[]): Promise<void>;
    },
  ) {
    this.hints = this.validate(options.candidates);
  }

  /** The home addresses to try, the one that last answered first. */
  candidates(): DirectCandidate[] {
    const first = (value: DirectCandidate): number => Number(key(value) !== this.preferred);
    return this.hints
      .map((value) => ({ ...value }))
      .sort((left, right) => first(left) - first(right));
  }
  /** Whether the last check reached the gateway on its own network. */
  isLocal(): boolean {
    return this.local;
  }
  assertUsable(): void {
    if (this.refused) throw this.refused;
  }
  onTransition(listener: (event: PathTransition) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => {
      void this.check();
    }, PATH_CHECK_INTERVAL_MS);
    this.timer.unref();
  }
  close(): void {
    this.closed = true;
    this.shutdown.abort();
    clearInterval(this.timer);
    clearTimeout(this.confirm);
    this.listeners.clear();
  }
  /** Another machine holds this home address here. Said once per address, then silently skipped. */
  reportRefusedHint(candidate: DirectCandidate): void {
    if (this.reported.has(key(candidate))) return;
    this.reported.add(key(candidate));
    log.info(
      `Home address ${key(candidate)} belongs to another machine on this network; using the relay`,
    );
  }
  async check(): Promise<void> {
    if (this.closed || this.running || (this.refused && !this.retryTls)) return;
    this.running = true;
    clearTimeout(this.confirm);
    try {
      // Only a classified TLS refusal on an opted-in key pairing reaches this path.
      // Application traffic stays blocked until exact-device canonical verification and this pass succeed.
      if (this.refused && !(await this.reverified())) return;
      let found = await this.sweep(this.hints);
      const learned = await this.refreshed(found.winner);
      if (!found.winner && learned.length > 0) {
        const again = await this.sweep(learned);
        found = { winner: again.winner, settled: found.settled && again.settled };
      }
      this.refused = undefined;
      this.retryTls = false;
      this.settle(found);
    } catch (error) {
      if (this.closed) return;
      const blocked = this.refused !== undefined;
      this.retryTls =
        error instanceof GatewayTlsIdentityRefused && this.options.reverify !== undefined;
      this.refused = new Error(
        this.retryTls
          ? "Gateway TLS identity was refused. Strict verification will be retried."
          : "Gateway identity or authentication was refused. Repair pairing before reconnecting.",
      );
      if (!blocked) this.emit("blocked");
    } finally {
      this.running = false;
    }
  }
  /** Availability is not successful authentication: an outage keeps the block and retries later. */
  private async reverified(): Promise<boolean> {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(5000)]);
    try {
      await this.options.reverify!(signal);
      signal.throwIfAborted();
      return true;
    } catch (error) {
      if (
        connectivityFailure(error) ||
        deadlineFailure(signal, error) ||
        (signal.aborted && error === signal.reason) ||
        busy(error)
      )
        return false;
      throw error;
    }
  }
  /**
   * Ask every home address at once and take the first that authenticates. `settled` says the
   * network itself ruled each one out, as opposed to some of them merely not answering in time.
   */
  private async sweep(
    hints: DirectCandidate[],
  ): Promise<{ winner?: DirectCandidate; settled: boolean }> {
    const won = new AbortController();
    let settled = true;
    let fatal: { error: unknown } | undefined;
    const attempts = hints.map(async (candidate) => {
      const attempt = AbortSignal.any([
        this.shutdown.signal,
        won.signal,
        AbortSignal.timeout(PATH_PROBE_MS),
      ]);
      try {
        await this.options.probe(candidate, attempt);
        attempt.throwIfAborted();
        return candidate;
      } catch (error) {
        if (error instanceof GatewayTlsIdentityRefused) this.reportRefusedHint(candidate);
        else if (connectivityFailure(error)) {
          if (!UNREACHABLE.includes(String((error as { code: unknown }).code))) settled = false;
        } else if (
          deadlineFailure(attempt, error) ||
          (attempt.aborted && error === attempt.reason) ||
          busy(error)
        )
          settled = false;
        else fatal ??= { error };
        throw error;
      }
    });
    const winner = await Promise.any(attempts).catch(() => undefined);
    won.abort();
    this.shutdown.signal.throwIfAborted();
    if (winner === undefined && fatal) throw fatal.error;
    return { winner, settled };
  }
  /** Returns the home addresses the gateway reported that were not known before. */
  private async refreshed(winner?: DirectCandidate): Promise<DirectCandidate[]> {
    if (!this.options.refresh) return [];
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(5000)]);
    const known = this.hints;
    let next: DirectCandidate[];
    try {
      next = await this.options.refresh(
        known.map((value) => ({ ...value })),
        signal,
        winner ? [winner] : [],
      );
    } catch (error) {
      this.shutdown.signal.throwIfAborted();
      if (
        connectivityFailure(error) ||
        deadlineFailure(signal, error) ||
        (signal.aborted && error === signal.reason)
      )
        return [];
      throw error;
    }
    this.shutdown.signal.throwIfAborted();
    next = this.validate(next);
    if (JSON.stringify(next) === JSON.stringify(known)) return [];
    this.hints = next;
    await this.options.persist?.(next).catch((error: unknown) => {
      log.warn(`Could not save the gateway's home addresses: ${toErrorMessage(error)}`);
    });
    return next.filter((value) => !known.some((old) => key(old) === key(value)));
  }
  private settle(found: { winner?: DirectCandidate; settled: boolean }): void {
    if (found.winner) {
      this.preferred = key(found.winner);
      this.misses = 0;
      this.local = true;
      // Every success, not only the first: a connection that fell back to the relay during a
      // brief miss is moved home by the next one.
      this.emit("local");
      return;
    }
    if (!this.local) return;
    this.misses++;
    if (!found.settled && this.misses < 2) {
      if (this.timer) {
        this.confirm = setTimeout(() => {
          void this.check();
        }, PATH_CONFIRM_MS);
        this.confirm.unref();
      }
      return;
    }
    this.local = false;
    this.misses = 0;
    this.emit("lost");
  }
  private emit(event: PathTransition): void {
    for (const listener of this.listeners) listener(event);
  }
  private validate(value: DirectCandidate[]): DirectCandidate[] {
    return z.array(directCandidateSchema).max(8).parse(value);
  }
}
