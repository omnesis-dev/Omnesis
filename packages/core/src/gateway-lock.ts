// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One gateway per configuration directory.
 *
 * The stores under a config dir — the SQLite databases and the DuckDB
 * analytics store — are owned by exactly one gateway process at a time. A
 * second gateway pointed at the same directory (a duplicate `gateway serve`,
 * a service unit started beside a manual run, a replacement booting while its
 * predecessor is still shutting down) must not get as far as opening any of
 * them, so this lock is taken before the first store opens and released as
 * the last thing on the way out.
 *
 * The lock is a file holding the owner's PID, its process start time and the
 * host name. A holder that no longer exists — or whose PID now belongs to a
 * different process — is stale and is replaced. A live holder is waited for
 * up to `waitMs`, which is how a replacement gateway rides out its
 * predecessor's shutdown under a supervisor that restarts on exit.
 */

import { execFileSync, spawn } from "node:child_process";
import { hostname } from "node:os";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GATEWAY_LOCK_FILE = "gateway.lock";

/**
 * How long the gateway gives its own shutdown before it force-exits. The
 * service units and this lock derive their patience from it: a replacement
 * gateway waits at least this long for its predecessor, and launchd's
 * ExitTimeOut (`GATEWAY_EXIT_TIMEOUT_SECONDS`) exceeds it so a slow but
 * healthy shutdown is never cut off mid-close.
 */
export const GATEWAY_SHUTDOWN_BUDGET_MS = 60_000;
export const GATEWAY_EXIT_TIMEOUT_SECONDS = Math.ceil((GATEWAY_SHUTDOWN_BUDGET_MS * 1.5) / 1000);

const DEFAULT_WAIT_MS = GATEWAY_SHUTDOWN_BUDGET_MS + 15_000;
const POLL_MS = 250;

export interface GatewayLockHolder {
  pid: number;
  processStart: string | null;
  hostname: string;
  startedAt: string;
}

export interface GatewayLock {
  readonly path: string;
  release(): void;
}

export interface AcquireGatewayLockOptions {
  /** How long to wait for a live holder before giving up. Default 60 s. */
  waitMs?: number;
  /** Called once when a live holder is found, before waiting on it. */
  onWaiting?: (holder: GatewayLockHolder) => void;
  pid?: number;
  now?: () => Date;
}

export class GatewayLockHeldError extends Error {
  constructor(
    readonly holder: GatewayLockHolder,
    readonly path: string,
  ) {
    super(
      `Another gateway (PID ${holder.pid} on ${holder.hostname || "an unknown host"}, started ${holder.startedAt}) already owns this configuration directory` +
        ` — ${path}. Stop it first (\`omnesis service stop gateway\`, or the process itself) or point this gateway at a different config dir.` +
        ` If that process is certainly gone, remove the lock file and start again.`,
    );
    this.name = "GatewayLockHeldError";
  }
}

export async function acquireGatewayLock(
  configDir: string,
  opts: AcquireGatewayLockOptions = {},
): Promise<GatewayLock> {
  const path = join(configDir, GATEWAY_LOCK_FILE);
  const now = opts.now ?? (() => new Date());
  const pid = opts.pid ?? process.pid;
  const deadline = Date.now() + (opts.waitMs ?? DEFAULT_WAIT_MS);
  let announced = false;

  for (;;) {
    // A proven live holder needs no claim attempt. Keep the guard for the
    // transition from missing/stale to claimed, not every waiting poll.
    const visible = readHolder(path);
    if (visible && holderIsAlive(visible)) {
      if (!announced) {
        announced = true;
        opts.onWaiting?.(visible);
      }
      if (Date.now() >= deadline) throw new GatewayLockHeldError(visible, path);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    const attempt = await withClaimGuard(path, () => {
      if (tryClaim(path, pid, now)) return { claimed: true as const };
      const holder = readHolder(path);
      if (!holder || !holderIsAlive(holder)) {
        retire(path, pid);
        return { claimed: tryClaim(path, pid, now) };
      }
      return { claimed: false as const, holder };
    });
    if (attempt.claimed) return handle(path, pid);
    const holder = "holder" in attempt ? attempt.holder : readHolder(path);
    if (!holder) continue;
    if (!announced) {
      announced = true;
      opts.onWaiting?.(holder);
    }
    if (Date.now() >= deadline) throw new GatewayLockHeldError(holder, path);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Serialize inspection, stale cleanup, and claiming across gateway processes.
 * The sidecar inode is never removed: the kernel drops its advisory lock if a
 * starter crashes, so no stale guard needs its own unsafe cleanup protocol.
 */
async function withClaimGuard<T>(path: string, operation: () => T): Promise<T> {
  const command =
    process.platform === "darwin" ? "lockf" : process.platform === "linux" ? "flock" : null;
  if (!command) throw new Error(`Gateway locking is unsupported on ${process.platform}`);
  const args = process.platform === "linux" ? ["-x", `${path}.guard`] : [`${path}.guard`];
  const keeper = spawn(
    command,
    [
      ...args,
      process.execPath,
      "-e",
      "process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let errorOutput = "";
  keeper.stderr!.on("data", (chunk: Buffer) => {
    errorOutput += String(chunk);
  });
  keeper.stdin!.on("error", () => {});
  let ready = false;
  let result: T | undefined;
  let failure: unknown;
  let failed = false;
  try {
    await new Promise<void>((resolve, reject) => {
      keeper.once("error", reject);
      keeper.once("close", (code) =>
        reject(
          new Error(
            `${command} exited before acquiring gateway guard (code ${code}): ${errorOutput}`,
          ),
        ),
      );
      keeper.stdout!.once("data", (chunk: Buffer) => {
        if (String(chunk) !== "ready\n")
          reject(new Error(`Unexpected gateway guard response: ${String(chunk)}`));
        else resolve();
      });
    });
    ready = true;
    result = operation();
  } catch (error) {
    failed = true;
    failure = error;
  }
  keeper.stdin!.end();
  if (!ready && keeper.exitCode === null && keeper.signalCode === null) keeper.kill();
  const code = await new Promise<number | null>((resolve) => {
    if (keeper.exitCode !== null || keeper.signalCode !== null) resolve(keeper.exitCode);
    else keeper.once("close", resolve);
  });
  if (ready && code !== 0)
    throw new Error(`${command} gateway guard exited with code ${code}: ${errorOutput}`);
  if (failed) throw failure;
  return result as T;
}

/** Only call while holding the stable advisory sidecar guard. */
function retire(path: string, pid: number): void {
  const parked = `${path}.stale-${pid}`;
  try {
    renameSync(path, parked);
  } catch {
    return;
  }
  rmSync(parked, { force: true });
}

/** The holder recorded in a config dir's lock, or null when nothing holds it. */
export function readGatewayLockHolder(configDir: string): GatewayLockHolder | null {
  return readHolder(join(configDir, GATEWAY_LOCK_FILE));
}

/**
 * The gateway process that owns `configDir` right now, or null. Offline
 * tools that copy or rewrite the stores ask this before touching them: a
 * gateway that is booting or draining holds the files even while `/health`
 * does not answer.
 */
export function liveGatewayHolder(configDir: string): GatewayLockHolder | null {
  const holder = readGatewayLockHolder(configDir);
  return holder && holderIsAlive(holder) ? holder : null;
}

/** Whether the recorded holder is still the process that took the lock. */
export function holderIsAlive(holder: GatewayLockHolder): boolean {
  if (holder.pid === process.pid) {
    // A lock naming this very process was left by an earlier life of the
    // same PID — a container restart, typically — never by us.
    return false;
  }
  if (holder.hostname !== hostname()) {
    // A lock from another host (a config dir on shared storage) cannot be
    // probed; treat it as live rather than steal a store in use elsewhere.
    return true;
  }
  return sameProcess(holder.pid, holder.processStart);
}

/**
 * Create the lock file for `pid`; false when another holder's file is
 * already there. The record is written to a private file first and linked
 * into place, so a competing reader never sees a claim before its content:
 * `link` is atomic and fails with EEXIST when a holder exists.
 */
function tryClaim(path: string, pid: number, now: () => Date): boolean {
  const owner: GatewayLockHolder = {
    pid,
    processStart: processStart(pid),
    hostname: hostname(),
    startedAt: now().toISOString(),
  };
  const record = `${JSON.stringify(owner)}\n`;
  const draft = `${path}.${pid}.claim`;
  writeFileSync(draft, record, { mode: 0o600 });
  try {
    linkSync(draft, path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw err;
  } finally {
    rmSync(draft, { force: true });
  }
  // A filesystem without hard links: exclusive create is the next best thing.
  try {
    writeFileSync(path, record, { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  }
}

function handle(path: string, pid: number): GatewayLock {
  return {
    path,
    release() {
      const holder = readHolder(path);
      if (holder && holder.pid !== pid) return;
      rmSync(path, { force: true });
    },
  };
}

function readHolder(path: string): GatewayLockHolder | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GatewayLockHolder>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return {
      pid: parsed.pid,
      processStart: typeof parsed.processStart === "string" ? parsed.processStart : null,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch {
    return null;
  }
}

function sameProcess(pid: number, expectedStart: string | null): boolean {
  // 0 and negatives address process groups; a lock never names those.
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (expectedStart === null) return true;
  const start = processStart(pid);
  return start === null || start === expectedStart;
}

/**
 * A stable identity for a running process beyond its reusable PID: the
 * kernel's start tick (plus the boot id, so a reboot never matches) on
 * Linux, `ps`'s start time on macOS.
 */
function processStart(pid: number): string | null {
  if (process.platform === "darwin") {
    try {
      return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }
  if (process.platform !== "linux") return null;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const start = stat.slice(close + 2).split(" ")[19];
    return bootId && start ? `${bootId}:${start}` : null;
  } catch {
    return null;
  }
}
