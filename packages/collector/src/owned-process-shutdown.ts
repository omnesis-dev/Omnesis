// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  OwnedProcessShutdownFence,
  ownedProcessCleanupReceipt,
  type OwnedProcessCleanup,
} from "@omnesis/core";
import { releaseWatchdogExit, retainWatchdogExit } from "./event-loop-watchdog-shared.js";
import { collectorCleanupReceipt } from "./owned-work.js";

interface CleanupOwner {
  cleanupFailure(): unknown;
  close(): Promise<void>;
}

/** Coordinate collector exits with every independently retained cleanup owner. */
export class CollectorOwnedProcessShutdown {
  readonly exitHold = new Int32Array(new SharedArrayBuffer(4));
  private readonly owners = new Map<CleanupOwner, OwnedProcessCleanup>();
  private terminal: unknown;
  private closing: Promise<void> | undefined;
  private readonly participant = {
    receipt: () => this.terminal,
    settle: () => Promise.resolve(),
  };
  private readonly fence: OwnedProcessShutdownFence;

  constructor(
    onUncertain: (error: unknown) => void,
    private readonly exit: (code: number) => never,
    review?: () => Promise<never>,
  ) {
    this.fence = new OwnedProcessShutdownFence(onUncertain, [this.participant], review);
  }

  attach(owner: CleanupOwner): void {
    if (this.closing) throw new Error("Collector cleanup admission is closed");
    if (this.owners.has(owner)) throw new Error("Collector cleanup owner is already attached");
    this.owners.set(owner, {
      receipt: () => owner.cleanupFailure(),
      settle: () => owner.close(),
    });
    this.ownershipChanged();
  }

  cleanupFailure(): unknown {
    return collectorCleanupReceipt(
      this.terminal,
      ...[...this.owners.keys()].map((owner) => owner.cleanupFailure()),
    );
  }

  /** The producer publishes its pending receipt before this synchronous callback. */
  ownershipChanged(): void {
    if (ownedProcessCleanupReceipt(this.cleanupFailure())) retainWatchdogExit(this.exitHold);
    else releaseWatchdogExit(this.exitHold);
  }

  /** Preserve explicit startup/fatal cleanup uncertainty even without a Doctor. */
  observeFailure(error: unknown): boolean {
    if (!ownedProcessCleanupReceipt(error)) return false;
    this.terminal ??= error;
    retainWatchdogExit(this.exitHold);
    return true;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Register all independent joins before awaiting any of them. One held
    // owner must not prevent another owner from closing its own admission.
    const joins = [this.participant, ...this.owners.values()].map((owner) =>
      this.fence.join(owner),
    );
    this.closing = Promise.allSettled(joins).then((results) => {
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Collector cleanup failed");
    });
    return this.closing;
  }

  finish(code: number): Promise<never> {
    // Closing admission is part of every exit path, including a fatal handler.
    void this.close().catch(() => {});
    return this.fence.finish(() => this.exit(code));
  }
}
