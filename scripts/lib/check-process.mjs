// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  WindowsProcessTree,
  killWindowsProcessTree,
} from "../../packages/core/src/windows-process-tree.ts";
import { requestChildShutdown } from "../../packages/core/src/parent-shutdown.ts";

const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const TERM_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;

async function signalChildTree(child, signal) {
  if (process.platform === "win32" && typeof child.pid === "number") {
    if (signal !== "SIGKILL" && (await requestChildShutdown(child))) return;
    await killWindowsProcessTree(child.pid);
    return;
  }
  try {
    if (process.platform !== "win32" && typeof child.pid === "number") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child has already exited.
    }
  }
}

// A check parent can exit before its gateways. Keep ownership until the
// process group is gone; zombie processes no longer consume test resources.
export function childGroupIsAlive(child) {
  if (!child.spawnfile || !child.pid) return false;
  if (process.platform === "win32") {
    try {
      process.kill(child.pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }
  try {
    const rows = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
    return rows.split("\n").some((row) => {
      const [pgid, state] = row.trim().split(/\s+/);
      return Number(pgid) === child.pid && state && !state.startsWith("Z");
    });
  } catch {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }
}

// Birth identities keep a recorded PID from targeting an unrelated replacement.
// Record descendants before signalling: an exiting supervisor may reparent a
// gateway that deliberately owns a separate process group.
function childTreeTracker(child) {
  const tracked = new Map();
  const identity = (pid, row) => {
    if (process.platform !== "linux") return row.birth;
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ")[19];
    } catch {
      return null;
    }
  };
  const remaining = () => {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
      encoding: "utf8",
    });
    const rows = new Map();
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (match)
        rows.set(Number(match[1]), {
          parent: Number(match[2]),
          group: Number(match[3]),
          state: match[4],
          birth: match[5],
        });
    }
    let added;
    do {
      added = false;
      for (const [pid, row] of rows) {
        const parent = rows.get(row.parent);
        const parentTracked =
          parent &&
          tracked.has(row.parent) &&
          identity(row.parent, parent) === tracked.get(row.parent);
        if (!tracked.has(pid) && (row.group === child.pid || parentTracked)) {
          const birth = identity(pid, row);
          if (birth) {
            tracked.set(pid, birth);
            added = true;
          }
        }
      }
    } while (added);
    return [...tracked].flatMap(([pid, birth]) => {
      const row = rows.get(pid);
      return row && !row.state.startsWith("Z") && identity(pid, row) === birth
        ? [{ pid, birth, row }]
        : [];
    });
  };
  return {
    remaining,
    signal(signal) {
      for (const { pid, birth, row } of remaining()) {
        if (identity(pid, row) !== birth) continue;
        try {
          process.kill(pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    },
  };
}

export function waitForChild(
  child,
  {
    signalEmitter = process,
    signalFn = signalChildTree,
    termGraceMs = TERM_GRACE_MS,
    killGraceMs = KILL_GRACE_MS,
    groupIsAlive = childGroupIsAlive,
    windowsTree = process.platform === "win32" && child.spawnfile && child.pid
      ? new WindowsProcessTree(child.pid, {
          rootIsAlive: () => child.exitCode === null && child.signalCode === null,
        })
      : null,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let forwardedSignal;
    let childExited = false;
    let termTimer;
    let killTimer;
    let snapshotTimer;
    const handlers = new Map();
    const signalWork = new Set();
    const tree =
      process.platform !== "win32" && child.spawnfile && child.pid ? childTreeTracker(child) : null;
    let refreshWork;
    const refreshWindowsTree = () => {
      if (!windowsTree) return Promise.resolve();
      if (refreshWork) return refreshWork;
      const pending = (async () => {
        for (;;) {
          try {
            await windowsTree.refresh();
            return;
          } catch (error) {
            process.stderr.write(
              `Cannot verify the owned Windows process tree; retaining the check lane: ${error.message}\n`,
            );
            await sleep(500);
          }
        }
      })();
      refreshWork = pending;
      void pending.then(() => {
        if (refreshWork === pending) refreshWork = undefined;
      });
      return pending;
    };
    const treeReady = refreshWindowsTree();
    const treeAlive = async () => {
      if (windowsTree) {
        if (childExited && !windowsTree.alive) return false;
        await refreshWindowsTree();
        return windowsTree.alive;
      }
      return tree ? tree.remaining().length > 0 : groupIsAlive(child);
    };
    const signalTree = async (signal) => {
      if (windowsTree) {
        await treeReady;
        await refreshWindowsTree();
        if (signal !== "SIGKILL" && (await requestChildShutdown(child))) return;
        await windowsTree.kill();
        return;
      }
      // Snapshot and signal recorded descendants before the direct supervisor
      // receives the signal and can orphan them.
      tree?.signal(signal);
      await signalFn(child, signal);
    };
    const signalOwnedTree = (signal) => {
      const pending = signalTree(signal).catch((error) => {
        process.stderr.write(
          `Cannot stop the owned check tree; retaining the check lane: ${error.message}\n`,
        );
      });
      signalWork.add(pending);
      void pending.then(() => signalWork.delete(pending));
      return pending;
    };

    const cleanup = () => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (snapshotTimer) clearInterval(snapshotTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      for (const [signal, handler] of handlers) {
        signalEmitter.removeListener(signal, handler);
      }
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onError = (error) => fail(error);
    const finishExit = async (code, signal) => {
      childExited = true;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      await treeReady;
      await Promise.all([...signalWork]);
      if (await treeAlive()) {
        await signalOwnedTree("SIGTERM");
        const deadline = Date.now() + termGraceMs;
        while (await treeAlive()) {
          if (Date.now() >= deadline) await signalOwnedTree("SIGKILL");
          await sleep(Math.min(killGraceMs, 100));
        }
      }
      if (snapshotTimer) clearInterval(snapshotTimer);
      if (refreshWork) await refreshWork;
      await Promise.all([...signalWork]);
      cleanup();
      if (forwardedSignal) {
        reject(new Error(`Check terminated after ${forwardedSignal}`));
      } else if (signal) {
        reject(new Error(`Check terminated by ${signal}`));
      } else {
        resolve(code ?? 1);
      }
    };
    const onExit = (code, signal) => {
      void finishExit(code, signal).catch(fail);
    };

    for (const signal of TERMINATION_SIGNALS) {
      const handler = () => {
        if (forwardedSignal) return;
        forwardedSignal = signal;
        void signalOwnedTree(signal);
        if (childExited) return;
        termTimer = setTimeout(() => {
          void signalOwnedTree("SIGKILL");
          if (childExited) return;
          killTimer = setTimeout(() => {
            process.stderr.write(
              `Check has not exited after ${signal} and SIGKILL; retaining the check lane until it stops\n`,
            );
          }, killGraceMs);
        }, termGraceMs);
      };
      handlers.set(signal, handler);
      signalEmitter.on(signal, handler);
    }

    child.once("error", onError);
    child.once("exit", onExit);
    if (windowsTree) {
      snapshotTimer = setInterval(() => {
        void refreshWindowsTree();
      }, 500);
      snapshotTimer.unref();
    }
  });
}
