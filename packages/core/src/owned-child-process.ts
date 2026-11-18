// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, type ChildProcess } from "node:child_process";
import { spawnWindowsJob, type WindowsJobProcess } from "./windows-job.js";
import { ownedProcessCleanupReceipt } from "./owned-process-cleanup.js";

export interface OwnedChildProcess {
  child: ChildProcess;
  ready: Promise<void>;
  /** Actual child close on POSIX; authenticated whole-Job closure on Windows. */
  joined: Promise<void>;
  readonly joinedConfirmed: boolean;
  stop(): Promise<void>;
}

const STOP_GRACE_MS = 5_000;

/** Own the process before publishing streams; stdout EOF never substitutes for closure. */
export function spawnOwnedChildProcess(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; stopSignal?: "SIGTERM" | "SIGKILL" },
  deps: {
    platform?: NodeJS.Platform;
    spawnChild?: typeof spawn;
    spawnJob?: typeof spawnWindowsJob;
  } = {},
): OwnedChildProcess {
  const { stopSignal = "SIGTERM", ...spawnOptions } = options;
  const windows = (deps.platform ?? process.platform) === "win32";
  const child = windows
    ? (deps.spawnJob ?? spawnWindowsJob)(command, args, { ...spawnOptions, completion: "root" })
    : (deps.spawnChild ?? spawn)(command, [...args], {
        ...spawnOptions,
        stdio: ["pipe", "pipe", "pipe"],
      });
  let closed = false;
  let stopping: Promise<void> | undefined;
  // An error event reports an operation failure; physical close remains independent.
  const stopErrors: unknown[] = [];
  let stopRequested = false;
  let uncertain = false;
  function stopFailure(): AggregateError {
    const marked = stopErrors.find((error) => ownedProcessCleanupReceipt(error) !== undefined);
    const receipt = ownedProcessCleanupReceipt(marked);
    const error = new AggregateError(stopErrors, "Owned child process stop failed", {
      cause: marked,
    });
    return receipt ? Object.assign(error, { cleanupFailure: receipt.failure }) : error;
  }
  function recordStopError(error: unknown): void {
    uncertain ||= ownedProcessCleanupReceipt(error) !== undefined;
    stopErrors.push(error);
  }
  child.on("error", (error) => {
    if ((stopRequested && !stopErrors.length) || ownedProcessCleanupReceipt(error))
      recordStopError(error);
  });
  const rawJoin = windows
    ? (child as WindowsJobProcess).jobClosed
    : new Promise<void>((resolve) => child.once("close", () => resolve()));
  const joined = rawJoin.then(
    () => {
      closed = true;
      if (uncertain) throw stopFailure();
    },
    (error: unknown) => {
      throw Object.assign(
        new Error("Owned child process cleanup is unconfirmed", { cause: error }),
        {
          cleanupFailure: error,
        },
      );
    },
  );
  void joined.catch(() => {});

  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        if (!closed) {
          stopRequested = true;
          try {
            child.kill(stopSignal);
          } catch (error) {
            recordStopError(error);
          }
          // The native Windows owner already bounds cancellation and verifies
          // its entire cohort. POSIX retains the existing signal escalation.
          if (!windows && stopSignal !== "SIGKILL") {
            timer = setTimeout(() => {
              if (closed) return;
              try {
                child.kill("SIGKILL");
              } catch (error) {
                recordStopError(error);
              }
            }, STOP_GRACE_MS);
            timer.unref();
          }
        }
        await joined;
        if (stopErrors.length) throw stopFailure();
      } finally {
        clearTimeout(timer);
      }
    })();
    void stopping.catch(() => {});
    return stopping;
  }

  const rawReady = windows
    ? (child as WindowsJobProcess).jobReady
    : new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
  const ready = rawReady.catch(async (error: unknown) => {
    await stop();
    throw error;
  });
  void ready.catch(() => {});
  return {
    child,
    ready,
    joined,
    get joinedConfirmed() {
      return closed && !uncertain;
    },
    stop,
  };
}
