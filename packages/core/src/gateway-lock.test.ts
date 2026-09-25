// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireGatewayLock,
  GATEWAY_LOCK_FILE,
  GatewayLockHeldError,
  readGatewayLockHolder,
} from "./gateway-lock.js";

let dir: string;
let sleeper: ChildProcess | null;

/** A live process that is not this one, so liveness is tested for real. */
async function spawnSleeper(): Promise<number> {
  sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => sleeper!.once("spawn", resolve));
  return sleeper.pid!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-gateway-lock-"));
  sleeper = null;
});

afterEach(async () => {
  if (sleeper && sleeper.exitCode === null && sleeper.signalCode === null) {
    sleeper.kill("SIGKILL");
    await new Promise<void>((resolve) => sleeper!.once("exit", () => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireGatewayLock", () => {
  it("takes a free directory and records this process", async () => {
    const lock = await acquireGatewayLock(dir);
    const holder = readGatewayLockHolder(dir);
    expect(holder).toMatchObject({ pid: process.pid, hostname: hostname() });
    expect(readFileSync(lock.path, "utf8")).toContain(`"pid":${process.pid}`);
    lock.release();
    expect(readGatewayLockHolder(dir)).toBeNull();
  });

  it("replaces a lock whose holder is gone", async () => {
    const pid = await spawnSleeper();
    const first = await acquireGatewayLock(dir, { pid });
    sleeper!.kill("SIGKILL");
    await new Promise<void>((resolve) => sleeper!.once("exit", () => resolve()));

    const lock = await acquireGatewayLock(dir, { waitMs: 0 });
    expect(readGatewayLockHolder(dir)?.pid).toBe(process.pid);
    // The dead holder's handle can no longer remove the live owner's lock.
    first.release();
    expect(readGatewayLockHolder(dir)?.pid).toBe(process.pid);
    lock.release();
  });

  it("replaces a lock whose PID now belongs to a different process", async () => {
    const pid = await spawnSleeper();
    writeFileSync(
      join(dir, GATEWAY_LOCK_FILE),
      JSON.stringify({
        pid,
        processStart: "boot:0",
        hostname: hostname(),
        startedAt: new Date().toISOString(),
      }),
    );
    const lock = await acquireGatewayLock(dir, { waitMs: 0 });
    expect(readGatewayLockHolder(dir)?.pid).toBe(process.pid);
    lock.release();
  });

  it("waits for a live holder and takes over once it exits", async () => {
    const pid = await spawnSleeper();
    await acquireGatewayLock(dir, { pid });
    const waiting: number[] = [];
    const pending = acquireGatewayLock(dir, {
      waitMs: 10_000,
      onWaiting: (holder) => waiting.push(holder.pid),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(waiting).toEqual([pid]);
    expect(readGatewayLockHolder(dir)?.pid).toBe(pid);
    sleeper!.kill("SIGKILL");
    const lock = await pending;
    expect(readGatewayLockHolder(dir)?.pid).toBe(process.pid);
    lock.release();
  });

  it("refuses a live holder once the wait is over, naming it", async () => {
    const pid = await spawnSleeper();
    await acquireGatewayLock(dir, { pid });
    const failure = await acquireGatewayLock(dir, { waitMs: 300 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayLockHeldError);
    expect((failure as GatewayLockHeldError).holder.pid).toBe(pid);
    expect((failure as Error).message).toContain(`PID ${pid}`);
    expect(readGatewayLockHolder(dir)?.pid).toBe(pid);
  });

  it("treats an unreadable lock file as unowned", async () => {
    writeFileSync(join(dir, GATEWAY_LOCK_FILE), "not json");
    const lock = await acquireGatewayLock(dir, { waitMs: 0 });
    expect(readGatewayLockHolder(dir)?.pid).toBe(process.pid);
    lock.release();
  });

  it("hands a stale lock to exactly one of several simultaneous starters", async () => {
    const module = new URL("./gateway-lock.ts", import.meta.url).href;
    const script = `
      import { acquireGatewayLock } from ${JSON.stringify(module)};
      acquireGatewayLock(${JSON.stringify(dir)}, { waitMs: 0 }).then(
        () => { process.stdout.write("won"); setInterval(() => {}, 1000); },
        (error) => { process.stdout.write("held:" + error.name); process.exit(0); },
      );
    `;
    for (let round = 0; round < 5; round++) {
      writeFileSync(
        join(dir, GATEWAY_LOCK_FILE),
        JSON.stringify({
          pid: 999_999_999,
          processStart: null,
          hostname: hostname(),
          startedAt: new Date().toISOString(),
        }),
      );
      const racers = Array.from({ length: 6 }, () =>
        spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
          cwd: join(import.meta.dirname, "../../.."),
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
      const outcomes = await Promise.all(
        racers.map(
          (racer) =>
            new Promise<string>((resolve) => {
              let out = "";
              racer.stdout!.on("data", (chunk: Buffer) => {
                out += String(chunk);
                if (out === "won" || out.startsWith("held")) resolve(out);
              });
              racer.once("exit", () => resolve(out || "exited"));
            }),
        ),
      );
      try {
        expect(outcomes.filter((o) => o === "won")).toHaveLength(1);
        expect(outcomes.filter((o) => o === "held:GatewayLockHeldError")).toHaveLength(5);
        const winner = racers[outcomes.indexOf("won")]!;
        expect(readGatewayLockHolder(dir)?.pid).toBe(winner.pid);
      } finally {
        for (const racer of racers) {
          if (racer.exitCode === null && racer.signalCode === null) racer.kill("SIGKILL");
        }
        await Promise.all(
          racers.map(
            (racer) =>
              new Promise<void>((resolve) => {
                if (racer.exitCode !== null || racer.signalCode !== null) resolve();
                else racer.once("exit", () => resolve());
              }),
          ),
        );
      }
    }
  });

  it("leaves a lock from another host alone", async () => {
    writeFileSync(
      join(dir, GATEWAY_LOCK_FILE),
      JSON.stringify({
        pid: 1,
        processStart: null,
        hostname: "some-other-host.example",
        startedAt: new Date().toISOString(),
      }),
    );
    await expect(acquireGatewayLock(dir, { waitMs: 0 })).rejects.toBeInstanceOf(
      GatewayLockHeldError,
    );
  });
});
