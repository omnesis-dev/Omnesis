// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { OwnedProcessShutdownFence, ownedProcessCleanupReceipt } from "@omnesis/core";

/** A provider failure cannot discharge an explicitly uncertain native process. */
export class AuthSubprocessExit {
  private uncertainty: unknown;
  private readonly fence = new OwnedProcessShutdownFence(
    () =>
      process.stderr.write("[auth-subprocess] native cleanup is unverified; retaining process\n"),
    [
      {
        receipt: () => this.uncertainty,
        // The auth API returned an error rather than a retained closure proof.
        // A pending marker alone cannot establish eventual physical cleanup.
        settle: () => Promise.reject(this.uncertainty),
      },
    ],
  );

  async preserveCleanupFailure(error: unknown): Promise<void> {
    if (!ownedProcessCleanupReceipt(error)) return;
    this.uncertainty ??= error;
    await this.finish(1);
  }

  get cleanupUncertain(): boolean {
    return this.uncertainty !== undefined;
  }

  async beforeFinalEvent(): Promise<void> {
    if (this.cleanupUncertain) await this.finish(1);
  }

  finish(code: number): Promise<never> {
    return this.fence.finish(() => process.exit(code));
  }
}
