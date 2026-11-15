// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { OwnedProcessShutdownFence, ownedProcessCleanupReceipt } from "@omnesis/core";
import { releaseWatchdogExit, retainWatchdogExit } from "./event-loop-watchdog-shared.js";

interface CleanupOwner {
  cleanupFailure(): unknown;
  close(): Promise<void>;
}

/** Coordinate the collector's process exits with its retained diagnostic work. */
export class CollectorOwnedProcessShutdown {
  readonly exitHold = new Int32Array(new SharedArrayBuffer(4));
  private owner: CleanupOwner | undefined;
  private terminal: unknown;
  private readonly participant = {
    receipt: () => this.terminal ?? this.owner?.cleanupFailure(),
    settle: () => this.owner?.close() ?? Promise.resolve(),
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
    if (this.owner) throw new Error("Collector cleanup owner is already attached");
    this.owner = owner;
    this.ownershipChanged();
  }

  cleanupFailure(): unknown {
    return this.participant.receipt();
  }

  /** The producer publishes its pending receipt before this synchronous callback. */
  ownershipChanged(): void {
    if (ownedProcessCleanupReceipt(this.participant.receipt())) retainWatchdogExit(this.exitHold);
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
    return this.fence.join(this.participant);
  }

  finish(code: number): Promise<never> {
    // Closing admission is part of every exit path, including a fatal handler.
    void this.close().catch(() => {});
    return this.fence.finish(() => this.exit(code));
  }
}
