// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { CaptureEmission } from "./lifecycle.js";

export interface CaptureHandoffDeps {
  /** Start durable persistence as soon as an emission enters the in-tab queue. */
  persist: (emission: CaptureEmission) => Promise<void>;
  /** Remove an emission's recovery copy when its authorization is cancelled. */
  discard?: (emission: CaptureEmission) => Promise<void>;
  send: (emission: CaptureEmission) => Promise<boolean>;
  setTimer: (fn: () => void, delayMs: number) => number;
  onStalled: (attempts: number) => void;
  onRecovered: () => void;
  retryDelaysMs?: readonly number[];
}

interface PendingHandoff {
  identity: string;
  emission: CaptureEmission;
  persistence: Promise<void>;
}

/**
 * One retry pump between a content script and the MV3 worker. It keeps a visit
 * and the newest re-extract per URL, so a worker outage cannot spawn unbounded
 * timers or retain an unbounded sequence of obsolete page snapshots.
 */
export class CaptureHandoffQueue {
  private readonly pending = new Map<string, PendingHandoff>();
  private readonly retryDelays: readonly number[];
  private active = false;
  private retryTimer: number | null = null;
  private failures = 0;
  private generation = 0;
  private stopped = false;
  private inFlight: PendingHandoff | null = null;
  private readonly outstanding = new Set<PendingHandoff>();

  constructor(private readonly deps: CaptureHandoffDeps) {
    this.retryDelays = deps.retryDelaysMs ?? [1_000, 5_000, 30_000];
  }

  enqueue(emission: CaptureEmission): void {
    if (this.stopped) return;
    const identity =
      emission.kind === "visit"
        ? `${emission.kind}:${emission.normalizedUrl}:${emission.visitedAt}`
        : `${emission.kind}:${emission.normalizedUrl}`;
    const previous = this.pending.get(identity);
    const next = { identity, emission, persistence: this.startPersistence(emission) };
    this.outstanding.add(next);
    this.pending.set(identity, next);
    if (previous && previous !== this.inFlight) {
      void next.persistence.then(() => this.discardEntries([previous])).catch(() => undefined);
    }
    void this.pump();
  }

  /** Drop queued/retrying work while allowing a later pairing to enqueue anew. */
  cancelPending(): void {
    this.generation += 1;
    const cancelled = [...this.outstanding];
    this.pending.clear();
    this.retryTimer = null;
    this.failures = 0;
    this.discardEntries(cancelled);
  }

  /** Permanently stop this content-script instance. */
  shutdown(): void {
    this.stopped = true;
    this.cancelPending();
  }

  private startPersistence(emission: CaptureEmission): Promise<void> {
    const persistence = this.deps.persist(emission);
    // Persistence is intentionally started before this entry becomes active;
    // attach a handler now so a rejected write never becomes an unhandled
    // promise while an earlier capture is still retrying.
    void persistence.catch(() => undefined);
    return persistence;
  }

  private discardEntries(entries: Iterable<PendingHandoff>): void {
    for (const entry of entries) {
      this.outstanding.delete(entry);
      if (!this.deps.discard) continue;
      void entry.persistence
        .catch(() => undefined)
        .then(() => this.deps.discard?.(entry.emission))
        .catch(() => undefined);
    }
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.active || this.retryTimer !== null) return;
    const entry = this.pending.entries().next().value as [string, PendingHandoff] | undefined;
    if (!entry) return;
    const [key, pending] = entry;
    const { emission } = pending;
    const generation = this.generation;
    this.active = true;
    this.inFlight = pending;
    let persisted = false;
    try {
      await pending.persistence;
      persisted = true;
      if (this.stopped || generation !== this.generation) return;
      if (!(await this.deps.send(emission))) throw new Error("capture was not acknowledged");
      if (this.stopped || generation !== this.generation) return;
      if (this.pending.get(key) === pending) {
        this.pending.delete(key);
        this.discardEntries(
          [...this.outstanding].filter((candidate) => candidate.identity === key),
        );
      } else {
        this.discardEntries([pending]);
      }
      this.failures = 0;
      this.deps.onRecovered();
    } catch {
      // An ambiguous send needs no new write: the original durable record is
      // already the recovery source. Rewriting it could resurrect an obsolete
      // snapshot after a newer capture was acknowledged and removed.
      if (
        !this.stopped &&
        generation === this.generation &&
        !persisted &&
        this.pending.get(key) === pending
      ) {
        pending.persistence = this.startPersistence(emission);
      }
      if (!this.stopped && generation === this.generation) {
        this.failures += 1;
        if (this.failures > this.retryDelays.length) this.deps.onStalled(this.failures);
        const delay = this.retryDelays[Math.min(this.failures - 1, this.retryDelays.length - 1)];
        this.retryTimer = this.deps.setTimer(() => {
          if (this.stopped || generation !== this.generation) return;
          this.retryTimer = null;
          void this.pump();
        }, delay);
      }
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
      this.active = false;
      if (!this.stopped && this.retryTimer === null && this.pending.size > 0) void this.pump();
    }
  }
}
