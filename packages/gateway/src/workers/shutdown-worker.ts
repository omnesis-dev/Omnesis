// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Worker } from "node:worker_threads";

/**
 * Join the thread, including termination after its resource-drained acknowledgement.
 * Native model calls can outlive their JS timeout; terminating before their
 * owner has disposed them can crash the host process. Those workers must wait
 * for acknowledgement, with the outer gateway process shutdown as the final bound.
 */
export async function shutdownWorker(
  worker: Worker,
  requestShutdown: () => void,
  onTimeout: () => void,
  options: { waitForNativeDrain?: boolean } = {},
): Promise<void> {
  if (worker.threadId === -1) return;
  let termination: Promise<number> | undefined;
  let rejectExit!: (error: unknown) => void;
  const terminate = () => {
    if (termination) return;
    try {
      termination = worker.terminate();
      // Attach immediately: a termination failure must reject disposal, not
      // become an unhandled rejection while the exit event is outstanding.
      void termination.catch(rejectExit);
    } catch (error) {
      rejectExit(error);
    }
  };
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const onExit = () => resolveExit();
  const onMessage = (message: { type?: string }) => {
    if (message?.type === "shutdownComplete") terminate();
  };
  worker.once("exit", onExit);
  worker.on("message", onMessage);
  const fallback = setTimeout(() => {
    onTimeout();
    if (!options.waitForNativeDrain) terminate();
  }, 5_000);
  fallback.unref?.();
  try {
    try {
      requestShutdown();
    } catch (error) {
      if (options.waitForNativeDrain) {
        // A failed transport says nothing about native resource lifetime.
        // Only an acknowledgement or an observed exit permits completion.
        if (worker.threadId === -1) resolveExit();
        else if (!termination) rejectExit(error);
      } else {
        terminate();
      }
    }
    await exited;
    await termination;
  } finally {
    clearTimeout(fallback);
    worker.off("exit", onExit);
    worker.off("message", onMessage);
  }
}
