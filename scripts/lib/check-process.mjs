// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const TERM_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;

function signalChildTree(child, signal) {
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
  if (process.platform === "win32" || !child.spawnfile || !child.pid) return false;
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
  } = {},
) {
  return new Promise((resolve, reject) => {
    let forwardedSignal;
    let childExited = false;
    let termTimer;
    let killTimer;
    const handlers = new Map();
    const tree =
      process.platform !== "win32" && child.spawnfile && child.pid ? childTreeTracker(child) : null;
    const treeAlive = () => (tree ? tree.remaining().length > 0 : groupIsAlive(child));
    const signalTree = (signal) => {
      // Snapshot and signal recorded descendants before the direct supervisor
      // receives the signal and can orphan them.
      tree?.signal(signal);
      signalFn(child, signal);
    };

    const cleanup = () => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
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
    const onExit = async (code, signal) => {
      childExited = true;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (treeAlive()) {
        signalTree("SIGTERM");
        const deadline = Date.now() + termGraceMs;
        while (treeAlive()) {
          if (Date.now() >= deadline) signalTree("SIGKILL");
          await sleep(Math.min(killGraceMs, 100));
        }
      }
      cleanup();
      if (forwardedSignal) {
        reject(new Error(`Check terminated after ${forwardedSignal}`));
      } else if (signal) {
        reject(new Error(`Check terminated by ${signal}`));
      } else {
        resolve(code ?? 1);
      }
    };

    for (const signal of TERMINATION_SIGNALS) {
      const handler = () => {
        if (forwardedSignal) return;
        forwardedSignal = signal;
        signalTree(signal);
        if (childExited) return;
        termTimer = setTimeout(() => {
          signalTree("SIGKILL");
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
  });
}
