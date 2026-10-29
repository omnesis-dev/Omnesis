// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireGatewayLock,
  GATEWAY_LOCK_FILE,
  GatewayLockHeldError,
  holderIsAlive,
  liveGatewayHolder,
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

describe.skipIf(process.platform === "win32")("macOS process identity across locales", () => {
  it("keeps a gateway live across writer/reader locales and still rejects a reused PID", async () => {
    const pid = await spawnSleeper();
    // Model macOS ps formatting without requiring a particular locale installed on the host.
    writeFileSync(
      join(dir, "ps"),
      `#!${process.execPath}
process.stdout.write(process.env.LC_ALL === 'C'
  ? 'Tue Jan 20 08:12:30 2032\\n'
  : 'Tue 20 Jan 08:12:30 2032\\n');
`,
      { mode: 0o700 },
    );
    if (process.platform === "linux") {
      // The claim guard is independent of ps; use the host's equivalent lock utility.
      writeFileSync(join(dir, "lockf"), '#!/bin/sh\nexec flock -x "$@"\n', { mode: 0o700 });
    }
    vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
    vi.stubEnv("LANG", "en_GB.UTF-8");
    vi.stubEnv("LC_ALL", "en_GB.UTF-8");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const lock = await acquireGatewayLock(dir, { pid, waitMs: 0 });
      try {
        expect(readGatewayLockHolder(dir)?.processStart).toBe("Tue Jan 20 08:12:30 2032");
        vi.stubEnv("LANG", "fr_FR.UTF-8");
        vi.stubEnv("LC_ALL", "fr_FR.UTF-8");
        expect(liveGatewayHolder(dir)?.pid).toBe(pid);
        await expect(acquireGatewayLock(dir, { waitMs: 0 })).rejects.toBeInstanceOf(
          GatewayLockHeldError,
        );
        const holder = readGatewayLockHolder(dir)!;
        writeFileSync(
          lock.path,
          JSON.stringify({ ...holder, processStart: "Mon Jan 19 08:12:30 2032" }),
        );
        expect(liveGatewayHolder(dir)).toBeNull();
      } finally {
        lock.release();
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe.skipIf(process.platform !== "linux")("Linux gateway lifetime lease", () => {
  it("rejects a lease symlink without following its target", async () => {
    const target = join(dir, "unrelated-file");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(dir, `${GATEWAY_LOCK_FILE}.lease`));
    await expect(acquireGatewayLock(dir, { waitMs: 0 })).rejects.toMatchObject({ code: "ELOOP" });
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(readGatewayLockHolder(dir)).toBeNull();
  });

  it("rejects non-regular lease files without blocking on a FIFO", async () => {
    execFileSync("mkfifo", [join(dir, `${GATEWAY_LOCK_FILE}.lease`)]);
    await expect(acquireGatewayLock(dir, { waitMs: 0 })).rejects.toThrow("regular file");
    expect(readGatewayLockHolder(dir)).toBeNull();
  });

  it("closes a claimed lease if the guard exits unsuccessfully", async () => {
    const originalPath = process.env.PATH;
    const realFlock = execFileSync("sh", ["-c", "command -v flock"], { encoding: "utf8" }).trim();
    const shim = join(dir, "flock");
    writeFileSync(
      shim,
      `#!${process.execPath}
      const {spawnSync} = require('node:child_process');
      const args = process.argv.slice(2);
      const result = spawnSync(${JSON.stringify(realFlock)}, args, {stdio: args[0] === '-n' ? ['inherit', 'inherit', 'inherit', 3] : 'inherit'});
      process.exit(args[1]?.endsWith('.guard') && result.status === 0 ? 9 : result.status ?? 1);
    `,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${dir}:${originalPath ?? ""}`);
    await expect(acquireGatewayLock(dir, { waitMs: 0 })).rejects.toThrow(
      "guard exited with code 9",
    );
    vi.stubEnv("PATH", originalPath);
    expect(liveGatewayHolder(dir)).toBeNull();
    const replacement = await acquireGatewayLock(dir, { waitMs: 0 });
    replacement.release();
  });

  it("keeps the lease after flock exits and reports this process as live", async () => {
    const lock = await acquireGatewayLock(dir);
    try {
      expect(readGatewayLockHolder(dir)?.locking).toBe("flock-v1");
      expect(liveGatewayHolder(dir)?.pid).toBe(process.pid);
      await expect(acquireGatewayLock(dir, { waitMs: 0 })).rejects.toBeInstanceOf(
        GatewayLockHeldError,
      );
    } finally {
      lock.release();
    }
    expect(liveGatewayHolder(dir)).toBeNull();
  });

  it("refuses a live lease across hostname and PID namespace identities", async () => {
    const lock = await acquireGatewayLock(dir);
    const record = JSON.parse(readFileSync(lock.path, "utf8"));
    writeFileSync(lock.path, JSON.stringify({ ...record, hostname: "other-container.example" }));
    try {
      // The recorded PID equals ours, but the kernel lease wins over both
      // the self-PID shortcut and the conservative foreign-host fallback.
      expect(holderIsAlive(readGatewayLockHolder(dir)!)).toBe(true);
      await expect(acquireGatewayLock(dir, { waitMs: 0 })).rejects.toBeInstanceOf(
        GatewayLockHeldError,
      );
    } finally {
      lock.release();
    }
  });

  it("reclaims a dead container's lease despite a foreign hostname and reused PID", async () => {
    writeFileSync(
      join(dir, GATEWAY_LOCK_FILE),
      JSON.stringify({
        pid: 1,
        processStart: null,
        hostname: "retired-container.example",
        startedAt: new Date().toISOString(),
        locking: "flock-v1",
        leaseId: "retired-claim",
      }),
    );
    expect(liveGatewayHolder(dir)).toBeNull();
    const lock = await acquireGatewayLock(dir, { waitMs: 0 });
    expect(readGatewayLockHolder(dir)?.pid).toBe(process.pid);
    lock.release();
  });

  it("releases the lease on SIGKILL without relying on owner cleanup", async () => {
    const module = new URL("./gateway-lock.ts", import.meta.url).href;
    sleeper = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { acquireGatewayLock } from ${JSON.stringify(module)};
      await acquireGatewayLock(${JSON.stringify(dir)});
      process.stdout.write("ready");
      setInterval(() => {}, 1000);
    `,
      ],
      { cwd: join(import.meta.dirname, "../../.."), stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      sleeper!.stdout!.once("data", () => resolve());
      sleeper!.once("error", reject);
      sleeper!.once("exit", () => reject(new Error("Owner exited before acquiring its lease")));
    });
    const path = join(dir, GATEWAY_LOCK_FILE);
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({ ...record, hostname: "killed-container.example", pid: 1 }),
    );
    expect(liveGatewayHolder(dir)).not.toBeNull();
    sleeper.kill("SIGKILL");
    await new Promise<void>((resolve) => sleeper!.once("exit", () => resolve()));
    expect(liveGatewayHolder(dir)).toBeNull();
    const replacement = await acquireGatewayLock(dir, { waitMs: 0 });
    replacement.release();
  });

  it("makes release idempotent across a same-process successor", async () => {
    const previous = await acquireGatewayLock(dir);
    const firstId = readGatewayLockHolder(dir)?.leaseId;
    previous.release();
    const replacement = await acquireGatewayLock(dir);
    try {
      expect(readGatewayLockHolder(dir)?.leaseId).not.toBe(firstId);
      previous.release();
      expect(liveGatewayHolder(dir)?.pid).toBe(process.pid);
    } finally {
      replacement.release();
    }
  });

  it("never removes a different claim with the same PID", async () => {
    const previous = await acquireGatewayLock(dir);
    const path = join(dir, GATEWAY_LOCK_FILE);
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, leaseId: "different-claim" }));
    previous.release();
    expect(readGatewayLockHolder(dir)?.leaseId).toBe("different-claim");
    const replacement = await acquireGatewayLock(dir, { waitMs: 0 });
    replacement.release();
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
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

  it("leaves a legacy lock from another host alone even with our PID", async () => {
    writeFileSync(
      join(dir, GATEWAY_LOCK_FILE),
      JSON.stringify({
        pid: process.pid,
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
