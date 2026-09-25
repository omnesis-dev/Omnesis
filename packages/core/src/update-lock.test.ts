// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireUpdateLock,
  adoptUpdateLock,
  getUpdateLockProcessGroup,
  UpdateLockBusyError,
  UpdateLockWaitTimeoutError,
  waitForUpdateLock,
} from "./update-lock.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-update-lock-"));
  dirs.push(dir);
  return dir;
}

describe("update lock", () => {
  it("refuses a second holder with the owner, start time, pid, and current step", async () => {
    const configDir = await tempConfig();
    const lock = acquireUpdateLock(configDir, {
      owner: "operator update",
      currentStep: "resolving release",
    });
    lock.setStep("taking backup");

    expect(() => acquireUpdateLock(configDir, { owner: "second update" })).toThrowError(
      UpdateLockBusyError,
    );
    expect(() => acquireUpdateLock(configDir, { owner: "second update" })).toThrow(
      /operator update \(PID \d+\), started .* currently taking backup/,
    );
    lock.release();
  });

  it("releases for the next update", async () => {
    const configDir = await tempConfig();
    const first = acquireUpdateLock(configDir, { owner: "first" });
    first.release();
    const second = acquireUpdateLock(configDir, { owner: "second" });
    second.release();
  });

  it("publishes and clears the active apply process group", async () => {
    const configDir = await tempConfig();
    const ownerPath = join(configDir, "update.lock", "owner.json");
    const lock = acquireUpdateLock(configDir, { owner: "operator" });
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -process.pid) return true;
      return realKill(pid, signal);
    });
    try {
      lock.setProcessGroup(process.pid);
      expect(getUpdateLockProcessGroup(configDir)).toEqual({ state: "active", pid: process.pid });

      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
      owner.processGroupStart = "reused-process-identity";
      writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
      expect(getUpdateLockProcessGroup(configDir)).toEqual({
        state: "unverified",
        pid: process.pid,
      });

      lock.setProcessGroup(null);
      expect(getUpdateLockProcessGroup(configDir)).toEqual({ state: "none" });
    } finally {
      kill.mockRestore();
      lock.release();
    }
  });

  it("recovers an old lock whose process is dead", async () => {
    const configDir = await tempConfig();
    const lockDir = join(configDir, "update.lock");
    mkdirSync(lockDir, { mode: 0o700 });
    const old = new Date("2026-01-01T00:00:00.000Z");
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({
        version: 1,
        id: "dead-owner",
        owner: "interrupted update",
        pid: 2_147_483_647,
        processStart: null,
        startedAt: old.toISOString(),
        updatedAt: old.toISOString(),
        currentStep: "applying",
      })}\n`,
    );

    const lock = acquireUpdateLock(configDir, {
      owner: "recovery",
      staleMs: 1,
      now: () => new Date("2026-01-01T00:01:00.000Z"),
    });
    expect(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")).owner).toBe("recovery");
    lock.release();
  });

  it.skipIf(process.platform === "win32")(
    "does not retire a dead CLI owner's fence while its detached apply group remains",
    async () => {
      const configDir = await tempConfig();
      const lockDir = join(configDir, "update.lock");
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(
        join(lockDir, "owner.json"),
        `${JSON.stringify({
          version: 1,
          id: "dead-cli-owner",
          owner: "Omnesis update",
          pid: 2_147_483_647,
          processStart: "dead-cli",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          currentStep: "installing",
          processGroupPid: 2_147_483_646,
          processGroupStart: "detached-apply",
        })}\n`,
      );
      const realKill = process.kill.bind(process);
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -2_147_483_646) return true;
        return realKill(pid, signal);
      });
      try {
        expect(() =>
          acquireUpdateLock(configDir, {
            owner: "next update",
            staleMs: 1,
            now: () => new Date("2026-01-01T00:01:00.000Z"),
          }),
        ).toThrow(UpdateLockBusyError);
      } finally {
        kill.mockRestore();
      }

      const recovered = acquireUpdateLock(configDir, {
        owner: "next update",
        staleMs: 1,
        now: () => new Date("2026-01-01T00:01:00.000Z"),
      });
      recovered.release();
    },
  );

  it("does not reclaim a future lease when PID liveness is not comparable", async () => {
    const configDir = await tempConfig();
    const lockDir = join(configDir, "update.lock");
    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({
        version: 1,
        id: "future-owner",
        owner: "interrupted update",
        pid: 2_147_483_647,
        processStart: null,
        startedAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
        currentStep: "applying",
      })}\n`,
    );

    expect(() => acquireUpdateLock(configDir, { owner: "recovery" })).toThrow(UpdateLockBusyError);
  });

  it("fails closed on fresh malformed metadata but reclaims it once old", async () => {
    const configDir = await tempConfig();
    const lockDir = join(configDir, "update.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), "not-json");

    expect(() => acquireUpdateLock(configDir, { owner: "next", staleMs: 60_000 })).toThrow(
      /holds this host lock/,
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockDir, old, old);
    const lock = acquireUpdateLock(configDir, { owner: "next", staleMs: 60_000 });
    lock.release();
  });

  it("transfers ownership only from the exact owner id", async () => {
    const configDir = await tempConfig();
    const owner = acquireUpdateLock(configDir, { owner: "collector" });
    expect(() => adoptUpdateLock(configDir, "wrong", { owner: "cli" })).toThrow(/hand-off/);
    const child = adoptUpdateLock(configDir, owner.id, { owner: "cli" });
    child.setStep("installing");
    owner.release();
    expect(() => acquireUpdateLock(configDir, { owner: "blocked" })).toThrow(UpdateLockBusyError);
    child.release();
  });

  it("returns a chained wrapper handoff to the original collector", async () => {
    const configDir = await tempConfig();
    const collector = acquireUpdateLock(configDir, { owner: "collector self-update" });
    const wrapper = adoptUpdateLock(configDir, collector.id, { owner: "source recovery" });
    const cli = adoptUpdateLock(configDir, wrapper.id, { owner: "Omnesis update" });

    cli.handBack();
    wrapper.release();
    expect(() => acquireUpdateLock(configDir, { owner: "operator" })).toThrow(
      /collector self-update.*finishing collector self-update/,
    );

    collector.release();
    const next = acquireUpdateLock(configDir, { owner: "operator" });
    next.release();
  });

  it("returns a whole hand-over to the process that made it, with that process's own way back", async () => {
    const configDir = await tempConfig();
    const collector = acquireUpdateLock(configDir, { owner: "collector self-update" });
    const cli = adoptUpdateLock(configDir, collector.id, { owner: "Omnesis update" });
    const continuation = adoptUpdateLock(configDir, cli.id, {
      owner: "Omnesis update (installed build)",
      returnToHolder: true,
    });

    // While the continuation holds it, the process that handed it over holds nothing.
    expect(() => cli.setStep("restarting")).toThrow(/lost ownership/);
    continuation.setStep("restarting the gateway");
    expect(() => acquireUpdateLock(configDir, { owner: "operator" })).toThrow(
      /Omnesis update \(installed build\).*restarting the gateway/,
    );

    continuation.handBack("finishing the update");
    // The way back is on disk, not only in this process's memory: whatever
    // adopts from the CLI next still finds the collector behind it.
    const onDisk = JSON.parse(
      readFileSync(join(configDir, "update.lock", "owner.json"), "utf8"),
    ) as {
      id: string;
      returnTo?: { id: string };
    };
    expect(onDisk.id).toBe(cli.id);
    expect(onDisk.returnTo?.id).toBe(collector.id);
    // The CLI that handed it over owns it again and can keep working...
    cli.setStep("fanning out");
    expect(() => acquireUpdateLock(configDir, { owner: "operator" })).toThrow(
      /Omnesis update .*fanning out/,
    );
    // ...and its own hand-back still reaches the collector that started it all.
    cli.handBack();
    expect(() => acquireUpdateLock(configDir, { owner: "operator" })).toThrow(
      /collector self-update.*finishing collector self-update/,
    );

    collector.release();
    const next = acquireUpdateLock(configDir, { owner: "operator" });
    next.release();
  });

  it("takes the lock back from a process it was handed to that exited without returning it", async () => {
    const configDir = await tempConfig();
    const cli = acquireUpdateLock(configDir, { owner: "Omnesis update" });
    // A PID no live process has: the adopter is gone.
    const exited = adoptUpdateLock(configDir, cli.id, {
      owner: "Omnesis update (installed build)",
      returnToHolder: true,
      pid: 2_147_483_000,
    });
    expect(() => cli.setStep("continuing")).toThrow(/lost ownership/);
    expect(cli.reclaim()).toBe(true);
    cli.setStep("continuing");
    expect(() => acquireUpdateLock(configDir, { owner: "operator" })).toThrow(/continuing/);
    exited.release();
    cli.release();
  });

  it("never reclaims from a live adopter, or one that took the lock from someone else", async () => {
    const configDir = await tempConfig();
    const cli = acquireUpdateLock(configDir, { owner: "Omnesis update" });
    const live = adoptUpdateLock(configDir, cli.id, {
      owner: "installed build",
      returnToHolder: true,
    });
    expect(cli.reclaim()).toBe(false);
    live.handBack();
    expect(cli.reclaim()).toBe(true);

    const bystander = await tempConfig();
    const other = acquireUpdateLock(bystander, { owner: "collector self-update" });
    const unrelated = acquireUpdateLock(await tempConfig(), { owner: "elsewhere" });
    adoptUpdateLock(bystander, other.id, {
      owner: "gone",
      returnToHolder: true,
      pid: 2_147_483_000,
    });
    expect(unrelated.reclaim()).toBe(true);
    unrelated.release();
    other.release();
    cli.release();
  });

  it("reaps a crashed malformed guard claim before changing the owner", async () => {
    const configDir = await tempConfig();
    const lock = acquireUpdateLock(configDir, { owner: "operator" });
    const claim = join(configDir, "update.lock", ".claim-crashed");
    writeFileSync(claim, "truncated");
    const old = new Date(Date.now() - 60_000);
    utimesSync(claim, old, old);

    lock.setStep("installing");

    expect(existsSync(claim)).toBe(false);
    expect(
      JSON.parse(readFileSync(join(configDir, "update.lock", "owner.json"), "utf8")),
    ).toMatchObject({
      currentStep: "installing",
    });
    lock.release();
  });

  it("keeps release ownership when a fresh crashed guard temporarily blocks cleanup", async () => {
    const configDir = await tempConfig();
    const lockDir = join(configDir, "update.lock");
    const lock = acquireUpdateLock(configDir, { owner: "collector" });
    const crashed = join(lockDir, ".claim-crashed");
    writeFileSync(
      crashed,
      `${JSON.stringify({
        version: 1,
        state: "choosing",
        ticket: 0,
        pid: 2_147_483_647,
        processStart: null,
      })}\n`,
    );

    lock.release();
    expect(existsSync(lockDir)).toBe(true);

    const old = new Date(Date.now() - 60_000);
    utimesSync(crashed, old, old);
    lock.release();
    expect(existsSync(lockDir)).toBe(false);
    const next = acquireUpdateLock(configDir, { owner: "next" });
    next.release();
  });

  it.skipIf(process.platform !== "linux")(
    "does not confuse a prior-boot start tick with the current process",
    async () => {
      const configDir = await tempConfig();
      const lockDir = join(configDir, "update.lock");
      mkdirSync(lockDir);
      const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
      const oldStartTick = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      writeFileSync(
        join(lockDir, "owner.json"),
        `${JSON.stringify({
          version: 1,
          id: "prior-boot-owner",
          owner: "interrupted update",
          pid: process.pid,
          processStart: oldStartTick,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          currentStep: "applying",
        })}\n`,
      );

      const lock = acquireUpdateLock(configDir, {
        owner: "recovery",
        staleMs: 1,
        now: () => new Date("2026-01-01T00:01:00.000Z"),
      });
      lock.release();
    },
  );
});

describe("waiting for the update lock", () => {
  it("takes the lock once its holder finishes, announcing the holder once", async () => {
    const configDir = await tempConfig();
    const holder = acquireUpdateLock(configDir, {
      owner: "collector self-update",
      currentStep: "building",
    });
    const announced: Array<string | undefined> = [];
    let naps = 0;
    const { lock, waitedMs } = await waitForUpdateLock(
      () => acquireUpdateLock(configDir, { owner: "harness self-update" }),
      {
        waitMs: 60_000,
        onWaiting: (current) => announced.push(current?.owner),
        sleep: () => {
          naps += 1;
          if (naps === 3) holder.release();
          return Promise.resolve();
        },
      },
    );
    expect(announced).toEqual(["collector self-update"]);
    expect(naps).toBe(3);
    expect(waitedMs).toBeGreaterThanOrEqual(0);
    expect(() => acquireUpdateLock(configDir, { owner: "third" })).toThrow(/harness self-update/);
    lock.release();
  });

  it("a free lock is taken at once and reports no wait", async () => {
    const configDir = await tempConfig();
    const onWaiting = vi.fn();
    const { lock, waitedMs } = await waitForUpdateLock(
      () => acquireUpdateLock(configDir, { owner: "operator update" }),
      { waitMs: 60_000, onWaiting },
    );
    expect(waitedMs).toBe(0);
    expect(onWaiting).not.toHaveBeenCalled();
    lock.release();
  });

  it("takes the lock once a dead holder's lease goes stale", async () => {
    const configDir = await tempConfig();
    // A process that has exited: its PID answers ESRCH.
    const child = spawn(process.execPath, ["-e", ""]);
    await once(child, "exit");
    mkdirSync(join(configDir, "update.lock"), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(
      join(configDir, "update.lock", "owner.json"),
      JSON.stringify({
        version: 1,
        id: "dead-holder",
        owner: "collector self-update",
        pid: child.pid,
        processStart: null,
        startedAt: stamp,
        updatedAt: stamp,
        currentStep: "building",
      }),
    );
    const { lock, waitedMs } = await waitForUpdateLock(
      () => acquireUpdateLock(configDir, { owner: "harness self-update", staleMs: 100 }),
      { waitMs: 10_000, pollMs: 20 },
    );
    expect(waitedMs).toBeGreaterThan(0);
    lock.release();
  });

  it("gives up after the wait, naming the holder that is still running", async () => {
    const configDir = await tempConfig();
    const holder = acquireUpdateLock(configDir, {
      owner: "collector self-update",
      currentStep: "building",
    });
    let now = 0;
    const attempt = waitForUpdateLock(
      () => acquireUpdateLock(configDir, { owner: "harness self-update" }),
      {
        waitMs: 5 * 60_000,
        clock: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
      },
    );
    await expect(attempt).rejects.toBeInstanceOf(UpdateLockWaitTimeoutError);
    await expect(attempt).rejects.toThrow(
      /collector self-update \(PID \d+\), started .*, currently building, was still running on this host after waiting 5 minutes/,
    );
    holder.release();
  });

  it("an error that is not a busy lock ends the wait at once", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      waitForUpdateLock(
        () => {
          throw new Error("disk full");
        },
        { waitMs: 60_000, sleep },
      ),
    ).rejects.toThrow("disk full");
    expect(sleep).not.toHaveBeenCalled();
  });
});
