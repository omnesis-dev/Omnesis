// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  WindowsProcessTree,
  windowsPowerShellExecutable,
  type WindowsProcessIdentity,
} from "./windows-process-tree.js";

it("pins the stock Windows PowerShell instead of resolving an update target's PATH", () => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  vi.stubEnv("PATH", "C:\\FictionalCheckout");
  try {
    expect(windowsPowerShellExecutable()).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    vi.stubEnv("SystemRoot", "relative-system-root");
    expect(() => windowsPowerShellExecutable()).toThrow("Windows system directory is unavailable");
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("Windows process birth ownership", () => {
  const root = { pid: 100, parentPid: 10, birth: "1000" };
  const child = { pid: 101, parentPid: 100, birth: "1001" };
  const grandchild = { pid: 102, parentPid: 101, birth: "1002" };

  function fixture(initial: WindowsProcessIdentity[]) {
    let rows = initial;
    let rootAlive = true;
    const killed: number[] = [];
    const kill = (pid: number) => {
      killed.push(pid);
      rows = rows.filter((row) => row.pid !== pid);
    };
    const tree = new WindowsProcessTree(root.pid, {
      snapshot: () => Promise.resolve(rows),
      snapshotSync: () => rows,
      kill: (pid) => {
        kill(pid);
        return Promise.resolve();
      },
      killSync: kill,
      rootIsAlive: () => rootAlive,
    });
    return {
      tree,
      killed,
      set: (next: WindowsProcessIdentity[]) => {
        rows = next;
      },
      setRootAlive: (alive: boolean) => {
        rootAlive = alive;
      },
    };
  }

  it("retains captured descendants after their leader exits and parents change", async () => {
    const f = fixture([grandchild, root, child]);
    await f.tree.refresh();
    f.set([{ ...child, parentPid: 1 }, grandchild]);
    await f.tree.kill();
    expect(f.killed).toEqual([grandchild.pid, child.pid]);
    expect(f.tree.alive).toBe(false);
  });

  it("retains known orphans but never adopts an unknown child after its parent row exited", async () => {
    const f = fixture([root, child]);
    await f.tree.refresh();
    f.setRootAlive(false);
    f.set([
      { ...child, parentPid: 1 },
      { pid: 103, parentPid: root.pid, birth: "1003" },
    ]);
    await f.tree.kill();
    expect(f.killed).toEqual([child.pid]);
    expect(f.tree.alive).toBe(false);
  });

  it("never targets a reused process PID or its unrelated children", async () => {
    const f = fixture([root, child]);
    await f.tree.refresh();
    f.set([
      { ...root, birth: "2000" },
      { ...child, birth: "2001" },
      { pid: 103, parentPid: root.pid, birth: "2002" },
    ]);
    await f.tree.kill();
    expect(f.killed).toEqual([]);
    expect(f.tree.alive).toBe(false);
  });

  it("rejects stale parent-PID links to children older than the root", async () => {
    const f = fixture([root, { ...child, birth: "999" }]);
    await f.tree.kill();
    expect(f.killed).toEqual([root.pid]);
  });

  it("does not guess ownership after a root vanished before observation", async () => {
    const f = fixture([child, grandchild]);
    await f.tree.kill();
    expect(f.killed).toEqual([]);
    expect(f.tree.alive).toBe(false);
  });

  it("rechecks birth identity immediately before each kill", async () => {
    const f = fixture([root, child]);
    await f.tree.refresh();
    f.set([root, { ...child, parentPid: 900, birth: "3000" }]);
    await f.tree.kill();
    expect(f.killed).toEqual([root.pid]);
  });

  it("does not kill a reused root after terminating one of its descendants", async () => {
    let rows = [root, child];
    const killed: number[] = [];
    const tree = new WindowsProcessTree(root.pid, {
      snapshot: () => Promise.resolve(rows),
      rootIsAlive: () => true,
      kill: (pid) => {
        killed.push(pid);
        rows = [{ ...root, birth: "3000" }];
        return Promise.resolve();
      },
    });
    await tree.kill();
    expect(killed).toEqual([child.pid]);
    expect(tree.alive).toBe(false);
  });

  it("has the same birth safety during synchronous process-exit cleanup", async () => {
    const f = fixture([root, child, grandchild]);
    await f.tree.refresh();
    f.set([
      { ...child, parentPid: 1 },
      { ...grandchild, parentPid: 900, birth: "3000" },
    ]);
    f.tree.killSync();
    expect(f.killed).toEqual([child.pid]);
    expect(f.tree.alive).toBe(false);
  });

  it("does not first adopt a reused root after its ChildProcess has exited", async () => {
    const f = fixture([
      { ...root, birth: "3000" },
      { ...child, birth: "3001" },
    ]);
    f.setRootAlive(false);
    await f.tree.kill();
    expect(f.killed).toEqual([]);
    expect(f.tree.alive).toBe(false);
  });

  it("adopts a reused descendant PID only when its current parent is owned", async () => {
    const f = fixture([root, child]);
    await f.tree.refresh();
    f.set([root, { ...child, birth: "3000" }]);
    await f.tree.kill();
    expect(f.killed).toEqual([child.pid, root.pid]);
    expect(f.tree.alive).toBe(false);
  });

  it("coalesces exit-observer and explicit teardown while discovering racing children", async () => {
    let rows = [root, child];
    const killed: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tree = new WindowsProcessTree(root.pid, {
      rootIsAlive: () => true,
      snapshot: () => Promise.resolve(rows),
      kill: async (pid) => {
        killed.push(pid);
        if (pid === child.pid) {
          await gate;
          rows = [root, { ...grandchild, parentPid: root.pid }];
        } else rows = rows.filter((row) => row.pid !== pid);
      },
    });
    const first = tree.kill();
    const second = tree.kill();
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    expect(killed).toEqual([child.pid, grandchild.pid, root.pid]);
    expect(tree.alive).toBe(false);
  });

  it("bounds native query seeds by current live identities across high process churn", async () => {
    let rows = [root];
    const requests: number[][] = [];
    const backend = {
      snapshotWindowsProcesses: (roots: readonly number[]) => {
        requests.push([...roots]);
        return Promise.resolve(rows);
      },
      snapshotWindowsProcessesSync: () => rows,
      killWindowsProcesses: async () => {},
      killWindowsProcessesSync: () => {},
    };
    const tree = new WindowsProcessTree(root.pid, { backend, rootIsAlive: () => true });
    for (let index = 0; index < 8200; index++) {
      rows = [root, { pid: index + 1000, parentPid: root.pid, birth: String(index + 1001) }];
      await tree.refresh();
    }
    expect(requests[0]).toEqual([root.pid]);
    expect(requests.every((roots) => roots.length <= 2)).toBe(true);
    expect(requests.at(-1)).toEqual([root.pid, 9198]);
  });

  it("excludes an exited original root from native queries while retaining known orphan seeds", async () => {
    let rows = [root, child];
    let rootAlive = true;
    const requests: number[][] = [];
    const capture = (roots: readonly number[]) => {
      requests.push([...roots]);
      return rows;
    };
    const backend = {
      snapshotWindowsProcesses: (roots: readonly number[]) => Promise.resolve(capture(roots)),
      snapshotWindowsProcessesSync: capture,
      killWindowsProcesses: async () => {},
      killWindowsProcessesSync: () => {},
    };
    const tree = new WindowsProcessTree(root.pid, { backend, rootIsAlive: () => rootAlive });
    await tree.refresh();
    rootAlive = false;
    rows = [{ ...child, parentPid: 1 }];
    await tree.refresh();
    expect(requests.at(-1)).toEqual([child.pid]);
    tree.killSync();
    expect(requests.slice(1).every((roots) => !roots.includes(root.pid))).toBe(true);
    expect(tree.alive).toBe(true);
  });

  it("distinguishes births separated by one 100 ns tick", async () => {
    const original = { ...root, birth: "638999999999999991" };
    const f = fixture([original]);
    await f.tree.refresh();
    f.set([{ ...original, birth: "638999999999999992" }]);
    await f.tree.kill();
    expect(f.killed).toEqual([]);
    expect(f.tree.alive).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "verifies the live native process birth before killing",
    async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      try {
        const tree = new WindowsProcessTree(child.pid!, {
          rootIsAlive: () => child.exitCode === null && child.signalCode === null,
          snapshot: () =>
            Promise.resolve([{ pid: child.pid!, parentPid: process.pid, birth: "0" }]),
        });
        await tree.kill();
        expect(tree.alive).toBe(true);
        expect(() => process.kill(child.pid!, 0)).not.toThrow();
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
    },
  );
});
