// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { OwnedProcessShutdownFence, type OwnedProcessCleanup } from "@omnesis/core";
import { OptionalServiceCleanup } from "../optional-service-cleanup.js";

/** Shared ownership across bootstrap and runtime. Tracked startup must unwind
 * before the fence's final recheck, because it can still enroll a late child. */
export class StartupOwnership {
  readonly fence: OwnedProcessShutdownFence;
  private readonly owners: OwnedProcessCleanup[] = [];
  private readonly failure = new OptionalServiceCleanup("Gateway startup", () => undefined);
  private readonly operations: OwnedProcessCleanup;
  private closingPartial = false;

  constructor(
    private readonly options: {
      drainOperations: () => Promise<void>;
      onUncertain: (error: unknown) => void;
      onCleanupFailure: (error: unknown) => void;
    },
  ) {
    this.owners.push(this.failure);
    this.operations = { receipt: () => undefined, settle: options.drainOperations };
    this.fence = new OwnedProcessShutdownFence(options.onUncertain, this.owners);
  }

  own<T extends OwnedProcessCleanup>(owner: T): T {
    this.owners.push(owner);
    if (this.closingPartial) this.join(owner);
    return owner;
  }

  captureFailure(error: unknown): void {
    this.failure.captureFailure(error);
  }

  abort(): void {
    // Join without awaiting inside the tracked runtime operation itself.
    // Awaiting this proof there would create a startup -> shutdown -> startup cycle.
    void this.fence.join(this.operations);
  }

  /** Full runtime shutdown has its own ordered joins. Before that exists,
   * close every enrolled owner and immediately close any late enrollment. */
  closePartial(): void {
    this.closingPartial = true;
    for (const owner of this.owners) this.join(owner);
  }

  private join(owner: OwnedProcessCleanup): void {
    void this.fence.join(owner).catch((error: unknown) => {
      try {
        this.options.onCleanupFailure(error);
      } catch {
        // Reporting must not create a new unhandled rejection during shutdown.
      }
    });
  }
}

export interface StartupShutdownOptions {
  drain: () => Promise<void>;
  finish: (exitCode: number) => void | Promise<void>;
  timeoutMs: number;
  onFailure: (error: unknown) => void;
  onTimeout: () => void;
}

/** All signals share one bounded drain. Neither cleanup nor diagnostic failures
 * reject it: a rejected shutdown can recursively re-enter the global fatal handler. */
export function createStartupShutdown(
  options: StartupShutdownOptions,
): (exitCode?: number) => Promise<void> {
  let completion: Promise<void> | undefined;
  return (exitCode = 0): Promise<void> => {
    if (completion) return completion;
    let resolveCompletion!: () => void;
    completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    let settled = false;
    const finish = (code: number, report?: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        report?.();
      } catch {
        // Diagnostics must not prevent the terminal action.
      }
      // A retained owned-process proof may outlive the ordinary drain budget.
      // Do not report shutdown complete while that terminal fence still waits.
      void Promise.resolve()
        .then(() => options.finish(code))
        .then(resolveCompletion, resolveCompletion);
    };
    const timer = setTimeout(() => finish(1, options.onTimeout), options.timeoutMs);
    timer.unref?.();
    // Defer invocation so synchronous throws and re-entrant signals observe the
    // already-published shared completion just like asynchronous drain failures.
    void Promise.resolve()
      .then(() => options.drain())
      .then(
        () => finish(exitCode),
        (error: unknown) => finish(1, () => options.onFailure(error)),
      );
    return completion;
  };
}
