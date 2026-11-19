// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ownedProcessCleanupReceipt } from "./owned-process-cleanup.js";

export interface OwnedProcessCleanup {
  /** Read-only; pending receipts carry cleanupPending:true, terminal ones do not. */
  receipt(): unknown;
  /** Retained closure proof; admission is closed and all owned processes join before fulfillment. */
  settle(): Promise<void>;
}
interface Proof {
  promise: Promise<void>;
  state: "pending" | "fulfilled" | "rejected";
}

/** Reference the owned PID while waiting, without probing or polling any process. */
function retainProcess(): () => void {
  const timer = setInterval(() => {}, 60_000);
  return () => clearInterval(timer);
}
function waitForReview(): Promise<never> {
  return new Promise<never>(() => {});
}
function receiptState(error: unknown): "none" | "pending" | "terminal" {
  const receipt = ownedProcessCleanupReceipt(error);
  return receipt ? (receipt.pending ? "pending" : "terminal") : "none";
}

/** Pending proofs can join; explicit rejected or terminal ownership uncertainty requires review. */
export class OwnedProcessShutdownFence {
  private failure: unknown;
  private reviewing: Promise<never> | null = null;
  private readonly proofs = new Map<OwnedProcessCleanup, Proof>();
  private lock: { release(): void } | undefined;
  private released = false;
  private releaseReference: (() => void) | null = null;

  constructor(
    private readonly onUncertain: (error: unknown) => void,
    private readonly participants: readonly OwnedProcessCleanup[] = [],
    private readonly review: () => Promise<never> = waitForReview,
  ) {}

  join(participant: OwnedProcessCleanup): Promise<void> {
    const current = this.proofs.get(participant);
    if (current) return current.promise;
    const proof: Proof = {
      state: "pending",
      promise: Promise.resolve()
        .then(() => participant.settle())
        .then(
          () => {
            proof.state = "fulfilled";
            this.syncReference(this.pending());
          },
          (error: unknown) => {
            proof.state = "rejected";
            // Rejection is the retained proof's actual failure, not a transient status sample.
            const explicit = receiptState(error) !== "none";
            if (explicit) this.recordFailure(error);
            this.syncReference(this.pending());
            if (!explicit) throw error;
          },
        ),
    };
    this.proofs.set(participant, proof);
    this.syncReference(this.pending());
    return proof.promise;
  }

  private recordFailure(error: unknown): void {
    if (this.failure === undefined) {
      this.failure = error;
      this.releaseReference ??= retainProcess();
      this.onUncertain(error);
    }
  }

  private pending(): Set<OwnedProcessCleanup> {
    const pending = new Set<OwnedProcessCleanup>();
    for (const participant of new Set([...this.participants, ...this.proofs.keys()])) {
      const receipt = participant.receipt(),
        state = receiptState(receipt),
        proof = this.proofs.get(participant);
      if (state === "terminal") this.recordFailure(receipt);
      else if (state === "pending") {
        if (proof && proof.state !== "pending") this.recordFailure(receipt);
        else pending.add(participant);
      }
      if (proof?.state === "pending") pending.add(participant);
    }
    return pending;
  }

  private syncReference(pending: ReadonlySet<OwnedProcessCleanup>): void {
    if (this.failure !== undefined || pending.size > 0) this.releaseReference ??= retainProcess();
    else {
      this.releaseReference?.();
      this.releaseReference = null;
    }
  }

  releaseLock(lock: { release(): void }): void {
    this.lock ??= lock;
    const pending = this.pending();
    this.syncReference(pending);
    if (pending.size === 0) this.releaseIfReady();
  }

  private releaseIfReady(): void {
    if (this.failure === undefined && this.lock && !this.released) {
      this.lock.release();
      this.released = true;
    }
  }

  /** Recheck only after retained proof settlement; the final check and exit stay synchronous. */
  finish(exit: () => never): Promise<never> {
    const pending = this.pending();
    this.syncReference(pending);
    if (this.failure !== undefined) return (this.reviewing ??= this.review());
    if (pending.size > 0) {
      return Promise.allSettled([...pending].map((participant) => this.join(participant))).then(
        () => this.finish(exit),
      );
    }
    this.releaseIfReady();
    return exit();
  }
}
