// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { GatewayRequestRefused } from "./google-device-pairing.js";
import { GatewayTlsIdentityRefused } from "./pinned-key.js";
import {
  connectivityFailure,
  deadlineFailure,
  directCandidateSchema,
  type DirectCandidate,
} from "./direct-path.js";

type PathTransition = "local" | "lost" | "blocked";

/** Probes are authenticated application requests over the saved TLS identity, never IP trust. */
export class AdaptiveGatewayPath {
  private hints: DirectCandidate[];
  private readonly shutdown = new AbortController();
  private readonly listeners = new Set<(event: PathTransition) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private closed = false;
  private local = false;
  private refused?: Error;
  private retryTls = false;
  constructor(
    private readonly options: {
      candidates: DirectCandidate[];
      probe(candidate: DirectCandidate, signal: AbortSignal): Promise<DirectCandidate[]>;
      refresh?(saved: DirectCandidate[], signal: AbortSignal): Promise<DirectCandidate[]>;
      reverify?(signal: AbortSignal): Promise<void>;
    },
  ) {
    this.hints = this.validate(options.candidates);
  }

  candidates(): DirectCandidate[] {
    return this.hints.map((value) => ({ ...value }));
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
    }, 15_000);
    this.timer.unref();
  }
  close(): void {
    this.closed = true;
    this.shutdown.abort();
    clearInterval(this.timer);
    this.listeners.clear();
  }
  async check(): Promise<void> {
    if (this.closed || this.running || (this.refused && !this.retryTls)) return;
    this.running = true;
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(5000)]);
    try {
      if (this.refused) {
        // Only a classified TLS refusal on an opted-in key pairing reaches this path.
        // Application traffic stays blocked until exact-device canonical verification and this pass succeed.
        await this.options.reverify!(signal);
        signal.throwIfAborted();
      }
      if (this.options.refresh) {
        const refreshed = await this.options.refresh(this.candidates(), signal);
        signal.throwIfAborted();
        this.hints = this.validate(refreshed);
      }
      for (const candidate of this.hints) {
        signal.throwIfAborted();
        const attempt = AbortSignal.any([signal, AbortSignal.timeout(750)]);
        try {
          const refreshed = await this.options.probe(candidate, attempt);
          attempt.throwIfAborted();
          this.hints = this.validate(refreshed);
          this.refused = undefined;
          this.retryTls = false;
          this.local = true;
          this.emit("local");
          return;
        } catch (error) {
          signal.throwIfAborted();
          if (
            !connectivityFailure(error) &&
            !deadlineFailure(attempt, error) &&
            !(attempt.aborted && error === attempt.reason)
          )
            throw error;
        }
      }
      this.refused = undefined;
      this.retryTls = false;
      this.loseLocal();
    } catch (error) {
      if (this.closed) return;
      if (
        connectivityFailure(error) ||
        deadlineFailure(signal, error) ||
        (signal.aborted && error === signal.reason)
      ) {
        this.loseLocal();
        return;
      }
      if (
        this.retryTls &&
        error instanceof GatewayRequestRefused &&
        (error.status === 429 ||
          (error.status !== undefined && error.status >= 500 && error.status <= 599))
      ) {
        // Availability is not successful authentication: keep application traffic blocked and retry later.
        this.loseLocal();
        return;
      }
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
  private loseLocal(): void {
    if (this.local) {
      this.local = false;
      this.emit("lost");
    }
  }
  private emit(event: PathTransition): void {
    for (const listener of this.listeners) listener(event);
  }
  private validate(value: DirectCandidate[]): DirectCandidate[] {
    return z.array(directCandidateSchema).max(8).parse(value);
  }
}
