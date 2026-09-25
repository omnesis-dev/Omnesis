// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  killSubprocessGroup,
  liveGroupCountForTest,
  registerSubprocessGroup,
} from "./subprocess-reaper.js";

/** True iff `pid` is still alive (signal 0 probes without delivering). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; EPERM = alive but not ours (won't happen here).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

describe("subprocess-reaper", () => {
  let dir: string;
  // Tracked so afterEach can guarantee no leak even if the test fails midway.
  let parentPid: number | undefined;
  let grandchildPid: number | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-reaper-"));
    parentPid = undefined;
    grandchildPid = undefined;
  });
  afterEach(() => {
    for (const target of [parentPid, grandchildPid]) {
      if (typeof target !== "number") continue;
      try {
        process.kill(-target, "SIGKILL"); // group
      } catch {
        /* gone */
      }
      try {
        process.kill(target, "SIGKILL"); // bare pid (parent isn't detached)
      } catch {
        /* gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reaps a detached child group when the runner is SIGTERM'd before cleanup", async () => {
    // A fixture process that mirrors what a harness does: register a
    // detached, long-lived grandchild and then idle. When this fixture is
    // SIGTERM'd (as `timeout` does to the e2e runner), the reaper's signal
    // handler must kill the grandchild's group — without it, the grandchild
    // would orphan (the original leak).
    const reaperUrl = pathToFileURL(join(import.meta.dirname, "subprocess-reaper.ts")).href;
    const fixture = join(dir, "fixture.mts");
    writeFileSync(
      fixture,
      [
        `import { registerSubprocessGroup } from ${JSON.stringify(reaperUrl)};`,
        `import { spawn } from "node:child_process";`,
        // Detached grandchild that never exits on its own.
        `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { detached: true, stdio: "ignore" });`,
        `registerSubprocessGroup(child);`,
        `process.stdout.write("CHILD_PID=" + child.pid + "\\n");`,
        // Keep the fixture alive until signalled.
        `setInterval(() => {}, 1e9);`,
      ].join("\n"),
    );

    // Run the fixture as a SINGLE node process with the tsx loader (no
    // `npx`/`tsx` wrapper), replicating tsx's own invocation, so the
    // SIGTERM below reaches the process that runs the reaper directly —
    // exactly as `timeout` SIGTERMs the e2e test runner.
    const repoRoot = join(import.meta.dirname, "../../../..");
    const tsxDist = join(repoRoot, "node_modules", "tsx", "dist");
    const parent = spawn(
      process.execPath,
      [
        "--require",
        join(tsxDist, "preflight.cjs"),
        "--import",
        pathToFileURL(join(tsxDist, "loader.mjs")).href,
        fixture,
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] },
    );
    parentPid = parent.pid;

    // Read the grandchild PID the fixture prints.
    let buf = "";
    const childPid = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("fixture never reported a child pid")), 20000);
      parent.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = buf.match(/CHILD_PID=(\d+)/);
        if (m) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      });
      parent.on("exit", () => {
        clearTimeout(t);
        reject(new Error("fixture exited before reporting a child pid"));
      });
    });

    grandchildPid = childPid;
    expect(isAlive(childPid)).toBe(true);

    // Kill the runner the way `timeout` would — SIGTERM, no stop() call.
    parent.kill("SIGTERM");

    // The reaper must take the grandchild down with it.
    const died = await waitUntil(() => !isAlive(childPid), 10000);
    if (!died) {
      try {
        process.kill(-childPid, "SIGKILL");
      } catch {
        /* cleanup best-effort */
      }
    }
    expect(died).toBe(true);
  }, 30000);
});

describe("killSubprocessGroup", () => {
  const spawned: number[] = [];

  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });

  /** A detached child that traps SIGTERM and refuses to die — stands in for a
   *  gateway wedged in a long native call, which never runs its TERM handler.
   *
   *  It announces READY *after* installing the handler, and callers must await
   *  that: signalling before the handler is installed kills the fixture via
   *  SIGTERM's default action, which silently turns these tests green without
   *  ever exercising the SIGKILL escalation they exist to cover. */
  async function spawnTermIgnoringChild(): Promise<ReturnType<typeof spawn>> {
    const proc = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000);"],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    spawned.push(proc.pid!);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("fixture never signalled READY")), 5000);
      proc.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("READY")) {
          clearTimeout(t);
          resolve();
        }
      });
      proc.once("exit", () => {
        clearTimeout(t);
        reject(new Error("fixture exited before signalling READY"));
      });
    });
    return proc;
  }

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const proc = await spawnTermIgnoringChild();
    registerSubprocessGroup(proc);
    const pid = proc.pid!;
    await waitUntil(() => isAlive(pid), 2000);

    await killSubprocessGroup(proc, { termGraceMs: 300, killGraceMs: 3000 });

    expect(isAlive(pid)).toBe(false);
    expect(liveGroupCountForTest()).toBe(0);
  }, 15000);

  it("can ask a foreground harness to stop cleanly with SIGINT", async () => {
    const proc = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGINT', () => process.exit(0)); console.log('READY'); setInterval(() => {}, 1000);",
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    spawned.push(proc.pid!);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture never signalled READY")), 5000);
      proc.stdout!.on("data", (chunk: Buffer) => {
        if (!chunk.toString().includes("READY")) return;
        clearTimeout(timer);
        resolve();
      });
      proc.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("fixture exited before signalling READY"));
      });
    });
    registerSubprocessGroup(proc);

    await killSubprocessGroup(proc, {
      initialSignal: "SIGINT",
      termGraceMs: 3_000,
      killGraceMs: 3_000,
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.signalCode).toBeNull();
    expect(liveGroupCountForTest()).toBe(0);
  }, 15000);

  it("kills a stubborn descendant after the group leader stops cleanly", async () => {
    const descendantProgram = [
      "process.on('SIGINT', () => {});",
      "process.on('SIGTERM', () => {});",
      "console.log('READY');",
      "setInterval(() => {}, 1000);",
    ].join("");
    const leaderProgram = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
      "child.stdout.once('data', () => console.log('DESCENDANT_PID=' + child.pid));",
      "process.on('SIGINT', () => process.exit(0));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("");
    const proc = spawn(process.execPath, ["-e", leaderProgram], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    spawned.push(proc.pid!);
    const descendantPid = await new Promise<number>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("fixture descendant was not ready")), 5000);
      proc.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/DESCENDANT_PID=(\d+)/u);
        if (!match) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      });
      proc.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("fixture leader exited before its descendant was ready"));
      });
    });
    registerSubprocessGroup(proc);

    await killSubprocessGroup(proc, {
      initialSignal: "SIGINT",
      termGraceMs: 300,
      killGraceMs: 3_000,
    });

    expect(proc.exitCode).toBe(0);
    expect(await waitUntil(() => !isAlive(descendantPid), 3_000)).toBe(true);
    expect(liveGroupCountForTest()).toBe(0);
  }, 15_000);

  it("reaps descendants and untracks the group when its leader exits first", async () => {
    const descendantProgram = [
      "process.on('SIGINT', () => {});",
      "process.on('SIGTERM', () => {});",
      "console.log('READY');",
      "setInterval(() => {}, 1000);",
    ].join("");
    const leaderProgram = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
      "child.stdout.once('data', () => { console.log('DESCENDANT_PID=' + child.pid); process.exit(0); });",
      "setInterval(() => {}, 1000);",
    ].join("");
    const proc = spawn(process.execPath, ["-e", leaderProgram], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    spawned.push(proc.pid!);
    registerSubprocessGroup(proc);
    const descendantPid = await new Promise<number>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("fixture descendant was not ready")), 5000);
      proc.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/DESCENDANT_PID=(\d+)/u);
        if (!match) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      });
      proc.once("error", reject);
    });

    expect(await waitUntil(() => !isAlive(descendantPid), 3_000)).toBe(true);
    expect(await waitUntil(() => liveGroupCountForTest() === 0, 3_000)).toBe(true);
  }, 15_000);

  it("keeps the group registered until the child is confirmed dead", async () => {
    // Regression: teardown used to untrack the group *before* signalling, then
    // await an exit that could never come. A hook timing out in that window
    // left a live gateway that the exit/signal reaper no longer knew about —
    // teardown had disarmed the net it depends on.
    const proc = await spawnTermIgnoringChild();
    registerSubprocessGroup(proc);
    expect(liveGroupCountForTest()).toBe(1);

    const pending = killSubprocessGroup(proc, { termGraceMs: 1500, killGraceMs: 3000 });

    // Mid-teardown, while the child is stubbornly alive: still tracked, so a
    // runner dying right now would still sweep it.
    await new Promise((r) => setTimeout(r, 400));
    expect(liveGroupCountForTest()).toBe(1);

    await pending;
    expect(liveGroupCountForTest()).toBe(0);
  }, 15000);

  it("untracks and returns promptly for an already-dead child", async () => {
    const proc = await spawnTermIgnoringChild();
    registerSubprocessGroup(proc);
    const pid = proc.pid!;
    process.kill(-pid, "SIGKILL");
    await waitUntil(() => !isAlive(pid), 5000);

    await killSubprocessGroup(proc, { termGraceMs: 5000, killGraceMs: 5000 });

    expect(liveGroupCountForTest()).toBe(0);
  }, 15000);

  it("fails and keeps an unresponsive group registered after the final wait times out", async () => {
    const fakePid = 2_000_000_000;
    const proc = new EventEmitter() as ChildProcess;
    Object.assign(proc, {
      pid: fakePid,
      exitCode: null,
      signalCode: null,
      kill: () => false,
    });
    registerSubprocessGroup(proc);
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      await expect(killSubprocessGroup(proc, { termGraceMs: 1, killGraceMs: 1 })).rejects.toThrow(
        `subprocess group ${fakePid} survived SIGTERM and SIGKILL`,
      );
      expect(liveGroupCountForTest()).toBe(1);
    } finally {
      processKill.mockRestore();
      proc.emit("exit", null, "SIGKILL");
    }
    expect(liveGroupCountForTest()).toBe(0);
  });
});
