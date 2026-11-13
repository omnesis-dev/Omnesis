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
