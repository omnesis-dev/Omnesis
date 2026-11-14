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
 * Linux holds a kernel advisory lease for the gateway's entire lifetime, so
 * containers sharing a directory do not mistake each other's PID namespaces
 * or hostnames for process liveness. The record holds the owner's identity
 * for diagnostics. Windows, macOS and legacy records use PID/start-time liveness.
 * A live holder is waited for
 * up to `waitMs`, which is how a replacement gateway rides out its
 * predecessor's shutdown under a supervisor that restarts on exit.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { windowsPowerShellExecutable, windowsProcessStart } from "./windows-process-tree.js";

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
  /** Linux uses a kernel lease; Windows records the process identity. */
  locking?: "flock-v1" | "windows-process-v1";
  leaseId?: string;
}

// Only paths obtained by reading the requested config directory are probed.
// A JSON record cannot redirect an offline tool to a different lease file.
const holderPaths = new WeakMap<GatewayLockHolder, string>();

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
    let pendingLease: number | undefined;
    let attempt;
    try {
      attempt = await withClaimGuard(path, pid, (births) => {
        // flock's FD mode locks the inherited open-file description. The parent
        // retains that description after the utility exits, so only closing our
        // FD (including SIGKILL) releases ownership. No keeper process can die
        // independently and leave a still-writing gateway without its lease.
        if (process.platform === "linux" && opts.pid === undefined) {
          const lease = takeLease(path);
          if (lease === null) {
            return {
              claimed: false as const,
              holder: readHolder(path) ?? {
                pid: 1,
                processStart: null,
                hostname: "",
                startedAt: "",
                locking: "flock-v1" as const,
              },
            };
          }
          try {
            const holder = readHolder(path);
            // An older gateway does not hold the lifetime lease. Preserve its
            // PID/host evidence instead of stealing its stores during upgrade.
            if (holder && holder.locking !== "flock-v1" && isHolderAlive(holder, births)) {
              closeSync(lease);
              return { claimed: false as const, holder };
            }
            retire(path, pid);
            if (!tryClaim(path, pid, now, true, births))
              throw new Error("Gateway claim changed while guarded");
            pendingLease = lease;
            return { claimed: true as const, lease };
          } catch (error) {
            closeSync(lease);
            throw error;
          }
        }
        if (tryClaim(path, pid, now, false, births)) return { claimed: true as const };
        const holder = readHolder(path);
        if (!holder || !isHolderAlive(holder, births)) {
          retire(path, pid);
          return { claimed: tryClaim(path, pid, now, false, births) };
        }
        return { claimed: false as const, holder };
      });
    } catch (error) {
      // Ownership transfers only after the guard has exited successfully.
      // A failed guard must not leave a lease behind in a caller that retries.
      if (pendingLease !== undefined) closeSync(pendingLease);
      throw error;
    }
    if (attempt.claimed) return handle(path, pid, "lease" in attempt ? attempt.lease : undefined);
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
type GuardBirths = ReadonlyMap<number, string | null>;
async function withClaimGuard<T>(
  path: string,
  pid: number,
  operation: (births?: GuardBirths) => T,
): Promise<T> {
  const command =
    process.platform === "win32"
      ? windowsPowerShellExecutable()
      : process.platform === "darwin"
        ? "lockf"
        : process.platform === "linux"
          ? "flock"
          : null;
  if (!command) throw new Error(`Gateway locking is unsupported on ${process.platform}`);
  const args = process.platform === "linux" ? ["-x", `${path}.guard`] : [`${path}.guard`];
  const keeper = spawn(
    command,
    process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CLAIM_GUARD]
      : [
          ...args,
          process.execPath,
          "-e",
          "process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
        ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      ...(process.platform === "win32"
        ? {
            windowsHide: true,
            env: {
              ...process.env,
              OMNESIS_GATEWAY_GUARD_PATH: `${path}.guard`,
              OMNESIS_GATEWAY_RECORD_PATH: path,
              OMNESIS_GATEWAY_OWNER_PID: String(pid),
            },
          }
        : {}),
    },
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
  let births: GuardBirths | undefined;
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
      let response = "";
      keeper.stdout!.on("data", (chunk: Buffer) => {
        response += String(chunk);
        if (response.length > 65536) {
          reject(new Error("Gateway guard response is too large"));
          return;
        }
        if (!response.includes("\n")) return;
        if (process.platform !== "win32") {
          if (response !== "ready\n") reject(new Error("Unexpected gateway guard response"));
          else resolve();
          return;
        }
        try {
          if (!response.startsWith("ready:") || !response.endsWith("\n")) throw new Error();
          const entries = JSON.parse(response.slice(6)) as Record<string, unknown>;
          if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error();
          const snapshot = new Map<number, string | null>();
          for (const [key, value] of Object.entries(entries)) {
            const identityPid = Number(key);
            if (
              !Number.isSafeInteger(identityPid) ||
              identityPid <= 0 ||
              (value !== null && (typeof value !== "string" || !/^[0-9]+$/u.test(value)))
            )
              throw new Error();
            snapshot.set(identityPid, value as string | null);
          }
          if (!snapshot.has(pid)) throw new Error();
          births = snapshot;
          resolve();
        } catch {
          reject(new Error("Unexpected Windows gateway guard response"));
        }
      });
    });
    ready = true;
    result = operation(births);
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

/**
 * FileShare.None serializes claims through a stable kernel-owned file handle.
 * A crashed starter closes stdin; a crashed guard releases the handle. The path
 * is passed through the environment so PowerShell never interprets its content.
 */
const WINDOWS_CLAIM_GUARD = `
$ErrorActionPreference = 'Stop'
$guard = $null
try {
  while ($null -eq $guard) {
    try {
      $guard = [System.IO.File]::Open($env:OMNESIS_GATEWAY_GUARD_PATH, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch [System.IO.IOException] {
      $cause = $_.Exception
      while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
      $code = $cause.HResult -band 65535
      if ($code -ne 32 -and $code -ne 33) { throw }
      Start-Sleep -Milliseconds 50
    }
  }
  # Sample identities while holding the same claim guard. The caller consumes
  # this snapshot only in its synchronous guarded callback; no foreign birth is
  # cached beyond this claim attempt. Failed probes stay conservatively unknown.
  $births = @{}
  $identityPids = @([int]$env:OMNESIS_GATEWAY_OWNER_PID)
  try {
    $record = [IO.File]::ReadAllText($env:OMNESIS_GATEWAY_RECORD_PATH)
    if ($record.Length -le 65536) {
      $holder = ConvertFrom-Json -InputObject $record
      if ($holder.pid -gt 0 -and $holder.pid -le [int]::MaxValue) { $identityPids += [int]$holder.pid }
    }
  } catch { }
  foreach ($identityPid in $identityPids) {
    $birth = $null
    $target = $null
    try {
      $target = [Diagnostics.Process]::GetProcessById($identityPid)
      $birth = $target.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    } catch { } finally { if ($null -ne $target) { $target.Dispose() } }
    $births[[string]$identityPid] = $birth
  }
  [Console]::Out.Write("ready:" + (ConvertTo-Json -InputObject $births -Compress) + "\`n")
  [Console]::Out.Flush()
  [Console]::In.ReadToEnd() | Out-Null
} finally {
  if ($null -ne $guard) { $guard.Dispose() }
}
`;

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
  return isHolderAlive(holder);
}
function isHolderAlive(holder: GatewayLockHolder, births?: GuardBirths): boolean {
  if (holder.locking === "flock-v1") {
    const path = holderPaths.get(holder);
    if (!path || process.platform !== "linux") return true;
    const lease = takeLease(path);
    if (lease === null) return true;
    closeSync(lease);
    return false;
  }
  if (holder.hostname !== hostname()) {
    // A lock from another host (a config dir on shared storage) cannot be
    // probed; treat it as live rather than steal a store in use elsewhere.
    return true;
  }
  if (holder.pid === process.pid) {
    if (holder.locking === "windows-process-v1")
      return sameProcess(holder.pid, holder.processStart, births);
    // A same-host legacy record naming this process is from an earlier life
    // of this PID. Foreign-host records must stay conservative even when
    // their namespace happens to assign the same PID as ours.
    return false;
  }
  return sameProcess(holder.pid, holder.processStart, births);
}

/**
 * Create the lock file for `pid`; false when another holder's file is
 * already there. The record is written to a private file first and linked
 * into place, so a competing reader never sees a claim before its content:
 * `link` is atomic and fails with EEXIST when a holder exists.
 */
function tryClaim(
  path: string,
  pid: number,
  now: () => Date,
  advisory = false,
  births?: GuardBirths,
): boolean {
  const owner: GatewayLockHolder = {
    pid,
    processStart: birthWithinGuard(pid, births),
    hostname: hostname(),
    startedAt: now().toISOString(),
    ...(advisory ? { locking: "flock-v1" as const, leaseId: randomUUID() } : {}),
    ...(process.platform === "win32" && !advisory
      ? { locking: "windows-process-v1" as const, leaseId: randomUUID() }
      : {}),
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

function handle(path: string, pid: number, lease?: number): GatewayLock {
  let released = false;
  const leaseId = readHolder(path)?.leaseId;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      const holder = readHolder(path);
      try {
        if (holder && (holder.pid !== pid || holder.leaseId !== leaseId)) return;
        rmSync(path, { force: true });
      } finally {
        if (lease !== undefined) closeSync(lease);
      }
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
    const holder: GatewayLockHolder = {
      pid: parsed.pid,
      processStart: typeof parsed.processStart === "string" ? parsed.processStart : null,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      ...(parsed.locking === "flock-v1" ? { locking: "flock-v1" as const } : {}),
      ...(parsed.locking === "windows-process-v1"
        ? { locking: "windows-process-v1" as const }
        : {}),
      ...(typeof parsed.leaseId === "string" ? { leaseId: parsed.leaseId } : {}),
    };
    holderPaths.set(holder, path);
    return holder;
  } catch {
    return null;
  }
}

/** A nonblocking kernel lease; caller owns the returned FD until close. */
function takeLease(path: string): number | null {
  const fd = openSync(
    `${path}.lease`,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Gateway lease must be a regular file");
    execFileSync("flock", ["-n", "-x", "-E", "73", "3"], {
      stdio: ["ignore", "ignore", "pipe", fd],
    });
    return fd;
  } catch (error) {
    closeSync(fd);
    if ((error as { status?: number }).status === 73) return null;
    throw error;
  }
}

function sameProcess(pid: number, expectedStart: string | null, births?: GuardBirths): boolean {
  // 0 and negatives address process groups; a lock never names those.
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (expectedStart === null) return true;
  const start = birthWithinGuard(pid, births);
  return start === null || start === expectedStart;
}

/**
 * A stable identity for a running process beyond its reusable PID: the
 * kernel's start tick (plus the boot id, so a reboot never matches) on
 * Linux, `ps`'s start time on macOS, UTC creation ticks on Windows.
 */
function birthWithinGuard(pid: number, births?: GuardBirths): string | null {
  return births?.has(pid) ? births.get(pid)! : processStart(pid);
}

function processStart(pid: number): string | null {
  if (process.platform === "win32") return windowsProcessStart(pid);
  if (process.platform === "darwin") {
    try {
      return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        // Lock writers and readers may inherit different launchd/shell locales.
        env: { ...process.env, LC_ALL: "C" },
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
