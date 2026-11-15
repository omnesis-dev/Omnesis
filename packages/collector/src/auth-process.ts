// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, type ChildProcess } from "node:child_process";
import { spawnWindowsJob, type WindowsJobProcess } from "@omnesis/core";

export interface AuthProcess {
  child: ChildProcess;
  ready: Promise<void>;
  /** Actual child close on POSIX; authenticated whole-Job closure on Windows. */
  joined: Promise<void>;
  readonly joinedConfirmed: boolean;
  stop(): Promise<void>;
}

const STOP_GRACE_MS = 5_000;

/** Own the process before publishing streams; stdout EOF never substitutes for closure. */
export function spawnAuthProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  deps: {
    platform?: NodeJS.Platform;
    spawnChild?: typeof spawn;
    spawnJob?: typeof spawnWindowsJob;
  } = {},
): AuthProcess {
  const windows = (deps.platform ?? process.platform) === "win32";
  const child = windows
    ? (deps.spawnJob ?? spawnWindowsJob)(command, args, { ...options, completion: "root" })
    : (deps.spawnChild ?? spawn)(command, [...args], {
        ...options,
        stdio: ["pipe", "pipe", "pipe"],
      });
  let closed = false;
  let stopping: Promise<void> | undefined;
  // An error event reports an operation failure; physical close remains independent.
  const stopErrors: unknown[] = [];
  let stopRequested = false;
  child.on("error", (error) => {
    if (stopRequested && !stopErrors.length) stopErrors.push(error);
  });
  const rawJoin = windows
    ? (child as WindowsJobProcess).jobClosed
    : new Promise<void>((resolve) => child.once("close", () => resolve()));
  const joined = rawJoin.then(
    () => {
      closed = true;
    },
    (error: unknown) => {
      throw Object.assign(new Error("Auth process cleanup is unconfirmed", { cause: error }), {
        cleanupFailure: error,
      });
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
            child.kill("SIGTERM");
          } catch (error) {
            stopErrors.push(error);
          }
          // The native Windows owner already bounds cancellation and verifies
          // its entire cohort. POSIX retains the existing signal escalation.
          if (!windows) {
            timer = setTimeout(() => {
              if (closed) return;
              try {
                child.kill("SIGKILL");
              } catch (error) {
                stopErrors.push(error);
              }
            }, STOP_GRACE_MS);
            timer.unref();
          }
        }
        await joined;
        if (stopErrors.length) throw new AggregateError(stopErrors, "Auth process stop failed");
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
      return closed;
    },
    stop,
  };
}
