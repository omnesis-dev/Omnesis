// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export interface StartupShutdownOptions {
  drain: () => Promise<void>;
  finish: (exitCode: number) => void;
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
      try {
        options.finish(code);
      } catch {
        // A terminal callback must not create another unhandled rejection.
      } finally {
        resolveCompletion();
      }
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
