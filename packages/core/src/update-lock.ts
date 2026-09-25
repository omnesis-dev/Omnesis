// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export const UPDATE_LOCK_ENV = "OMNESIS_UPDATE_LOCK_ID";

const LOCK_DIR = "update.lock";
const OWNER_FILE = "owner.json";
const CLAIM_PREFIX = ".claim-";
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;

interface UpdateLockReturnOwner {
  id: string;
  owner: string;
  pid: number;
  processStart: string | null;
  startedAt: string;
  /**
   * Where the owner being returned to hands the lock on in turn, when it had
   * itself adopted the lock and handed it over whole.
   */
  returnTo?: UpdateLockReturnOwner;
}

/** How deep a chain of whole hand-overs may nest before it is not believed. */
const MAX_RETURN_DEPTH = 4;

interface UpdateLockOwner extends UpdateLockReturnOwner {
  version: 1;
  updatedAt: string;
  currentStep: string;
  returnTo?: UpdateLockReturnOwner;
  processGroupPid?: number;
  processGroupStart?: string | null;
}

export interface UpdateLockOptions {
  owner: string;
  currentStep?: string;
  heartbeatMs?: number;
  staleMs?: number;
  now?: () => Date;
  pid?: number;
}

export interface AdoptUpdateLockOptions extends UpdateLockOptions {
  /**
   * Return the lock to the exact process that handed it over, with that
   * process's own way back intact, instead of to the process that first took
   * it. For a holder that stays alive and keeps working after the adopter
   * finishes, such as an update handing its remaining steps to the build it
   * just installed.
   */
  returnToHolder?: boolean;
}

export interface UpdateLock {
  readonly id: string;
  readonly startedAt: string;
  setStep(step: string): void;
  setProcessGroup(pid: number | null): void;
  handBack(step?: string): void;
  /**
   * Take the lock back from a process this one handed it to whole
   * (`returnToHolder`) that exited without returning it. True when this handle
   * owns the lock afterwards.
   */
  reclaim(): boolean;
  release(): void;
}

export class UpdateLockBusyError extends Error {
  constructor(
    readonly holder: Readonly<UpdateLockOwner> | null,
    message = holder ? busyMessage(holder) : "Another Omnesis update holds this host lock.",
  ) {
    super(message);
    this.name = "UpdateLockBusyError";
  }
}

/** The lock stayed busy for the whole of a bounded wait. */
export class UpdateLockWaitTimeoutError extends UpdateLockBusyError {
  constructor(
    holder: Readonly<UpdateLockOwner> | null,
    readonly waitedMs: number,
  ) {
    super(
      holder,
      `${holder ? `${updateLockHolderLabel(holder)}, started ${holder.startedAt}, currently ${holder.currentStep},` : "Another Omnesis update"} ` +
        `was still running on this host after waiting ${formatWait(waitedMs)}.`,
    );
    this.name = "UpdateLockWaitTimeoutError";
  }
}

/** Who holds the lock, in the words every waiting and refusal message uses. */
export function updateLockHolderLabel(holder: Readonly<UpdateLockReturnOwner>): string {
  return `${holder.owner} (PID ${holder.pid})`;
}

export interface UpdateLockWaitOptions {
  /** How long the lock may stay busy before the wait gives up. */
  waitMs: number;
  /** How often the lock is tried again. Default 2 s. */
  pollMs?: number;
  /** Called once, with the first holder found, before waiting on it. */
  onWaiting?(holder: Readonly<UpdateLockOwner> | null): void;
  sleep?(ms: number): Promise<void>;
  clock?(): number;
}

const DEFAULT_WAIT_POLL_MS = 2_000;

/**
 * Take the host update lock, waiting for another update to finish instead of
 * refusing. `acquire` is tried again until it stops throwing
 * `UpdateLockBusyError` — because the holder released the lock, or because it
 * is proven dead by the ordinary stale-lock rules `acquireUpdateLock` applies
 * on every attempt — or until `waitMs` has passed, when the wait throws
 * `UpdateLockWaitTimeoutError`. Any other error ends the wait at once.
 */
export async function waitForUpdateLock<T>(
  acquire: () => T,
  opts: UpdateLockWaitOptions,
): Promise<{ lock: T; waitedMs: number }> {
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = opts.pollMs ?? DEFAULT_WAIT_POLL_MS;
  const start = clock();
  let announced = false;
  for (;;) {
    try {
      // Zero when the lock was free, and at least a millisecond when it was
      // not: only a wait that happened is reported, and every one that did is.
      return { lock: acquire(), waitedMs: announced ? Math.max(1, clock() - start) : 0 };
    } catch (err) {
      if (!(err instanceof UpdateLockBusyError)) throw err;
      if (!announced) {
        announced = true;
        opts.onWaiting?.(err.holder);
      }
      const waitedMs = clock() - start;
      if (waitedMs >= opts.waitMs) throw new UpdateLockWaitTimeoutError(err.holder, waitedMs);
      await sleep(Math.min(pollMs, opts.waitMs - waitedMs));
    }
  }
}

function formatWait(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const seconds = Math.max(1, Math.round(ms / 1_000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** Acquire the one update transaction allowed in this configuration directory. */
export function acquireUpdateLock(configDir: string, opts: UpdateLockOptions): UpdateLock {
  const now = opts.now ?? (() => new Date());
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const lockDir = join(configDir, LOCK_DIR);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      const stamp = now().toISOString();
      const owner: UpdateLockOwner = {
        version: 1,
        id: randomUUID(),
        owner: opts.owner,
        pid: opts.pid ?? process.pid,
        processStart: processStart(opts.pid ?? process.pid),
        startedAt: stamp,
        updatedAt: stamp,
        currentStep: opts.currentStep ?? "starting",
      };
      try {
        writeOwner(lockDir, owner);
      } catch (err) {
        retireLock(lockDir);
        throw err;
      }
      return createHandle(lockDir, owner.id, opts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readOwner(lockDir);
      const updated = holder ? Date.parse(holder.updatedAt) : lockMtime(lockDir);
      const age = now().getTime() - updated;
      // A timestamp in the future may be a live lease observed after the
      // wall clock moved backwards. Treat it as fresh: a PID namespace can
      // make a live updater look dead to another container on this host.
      const fresh = Number.isFinite(updated) && age < staleMs;
      if (fresh || (holder && updateWorkMayBeActive(holder))) {
        throw new UpdateLockBusyError(holder);
      }
      if (
        retireLock(lockDir, holder?.id, (current) => {
          if (holder ? current?.id !== holder.id : current !== null) return false;
          const currentUpdated = current ? Date.parse(current.updatedAt) : updated;
          const currentAge = now().getTime() - currentUpdated;
          const currentFresh = Number.isFinite(currentUpdated) && currentAge < staleMs;
          return !currentFresh && !(current && updateWorkMayBeActive(current));
        }) !== "retired"
      ) {
        continue;
      }
    }
  }
  throw new UpdateLockBusyError(readOwner(lockDir));
}

/**
 * Atomically transfer a held lock to this process. By default the lock later
 * returns to the process that first took it — a collector, through any wrapper
 * in between; with `returnToHolder` it returns to the one handing it over.
 */
export function adoptUpdateLock(
  configDir: string,
  id: string,
  opts: AdoptUpdateLockOptions,
): UpdateLock {
  const lockDir = join(configDir, LOCK_DIR);
  const claim = claimGuard(lockDir);
  if (!claim) {
    throw new Error("The update lock is changing ownership; start the update again.");
  }
  let adopted: UpdateLockOwner;
  let returnTo: UpdateLockReturnOwner;
  try {
    const owner = readOwner(lockDir);
    if (!owner || owner.id !== id) {
      throw new Error("The update lock hand-off is no longer valid; start the update again.");
    }
    const holder: UpdateLockReturnOwner = {
      id: owner.id,
      owner: owner.owner,
      pid: owner.pid,
      processStart: owner.processStart,
      startedAt: owner.startedAt,
    };
    returnTo = opts.returnToHolder
      ? { ...holder, ...(owner.returnTo ? { returnTo: owner.returnTo } : {}) }
      : (owner.returnTo ?? holder);
    adopted = {
      ...owner,
      id: randomUUID(),
      owner: opts.owner,
      pid: opts.pid ?? process.pid,
      processStart: processStart(opts.pid ?? process.pid),
      updatedAt: (opts.now ?? (() => new Date()))().toISOString(),
      currentStep: opts.currentStep ?? owner.currentStep,
      returnTo,
    };
    writeOwner(lockDir, adopted);
  } finally {
    releaseGuard(claim);
  }
  return createHandle(lockDir, adopted.id, opts, returnTo);
}

function createHandle(
  lockDir: string,
  id: string,
  opts: UpdateLockOptions,
  returnTo?: UpdateLockReturnOwner,
): UpdateLock {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const now = opts.now ?? (() => new Date());
  let released = false;
  let releaseRetry: NodeJS.Timeout | null = null;

  const update = (step?: string, required = false, processGroupPid?: number | null): void => {
    if (released) return;
    const claim = claimGuard(lockDir);
    if (!claim) {
      if (required) throw new Error("Could not verify ownership of the host update lock.");
      return;
    }
    try {
      const current = readOwner(lockDir);
      if (!current || current.id !== id) {
        throw new Error("This update lost ownership of the host lock; refusing further work.");
      }
      const next: UpdateLockOwner = {
        ...current,
        updatedAt: now().toISOString(),
        ...(step === undefined ? {} : { currentStep: step }),
        ...(processGroupPid === undefined || processGroupPid === null
          ? {}
          : { processGroupPid, processGroupStart: processStart(processGroupPid) }),
      };
      if (processGroupPid === null) {
        delete next.processGroupPid;
        delete next.processGroupStart;
      }
      writeOwner(lockDir, next);
    } finally {
      releaseGuard(claim);
    }
  };
  const timer = setInterval(() => {
    try {
      update();
    } catch {
      // The next explicit step still checks ownership; a heartbeat I/O
      // failure must not crash a process in the middle of an apply.
    }
  }, heartbeatMs);
  timer.unref();

  const finish = (): void => {
    released = true;
    clearInterval(timer);
    if (releaseRetry) clearTimeout(releaseRetry);
    process.off("exit", onExit);
  };

  const release = (): void => {
    if (released) return;
    const result = retireLock(lockDir, id);
    if (result === "busy") {
      if (!releaseRetry) {
        releaseRetry = setTimeout(() => {
          releaseRetry = null;
          release();
        }, DEFAULT_STALE_MS);
        releaseRetry.unref();
      }
      return;
    }
    finish();
  };
  // A process that exits holding an adopted lock returns it to the process it
  // came from, which is still waiting on this one; only a lock this process
  // took itself is released.
  const onExit = (): void => {
    if (!returnTo) {
      release();
      return;
    }
    try {
      handBack("returning the lock from an exited update process");
    } catch {
      release();
    }
  };
  process.on("exit", onExit);

  const handBack = (step = "finishing collector self-update"): void => {
    if (released) return;
    if (!returnTo) throw new Error("This update lock has no previous owner to return to.");
    const claim = claimGuard(lockDir);
    if (!claim) throw new Error("Could not return ownership of the host update lock.");
    try {
      const current = readOwner(lockDir);
      if (!current || current.id !== id) {
        throw new Error("This update lost ownership of the host lock before hand-back.");
      }
      writeOwner(lockDir, {
        version: 1,
        ...returnTo,
        updatedAt: now().toISOString(),
        currentStep: step,
      });
    } finally {
      releaseGuard(claim);
    }
    finish();
  };

  const reclaim = (): boolean => {
    if (released) return false;
    const claim = claimGuard(lockDir);
    if (!claim) return false;
    try {
      const current = readOwner(lockDir);
      if (current?.id === id) return true;
      if (!current?.returnTo || current.returnTo.id !== id || updateWorkMayBeActive(current)) {
        return false;
      }
      writeOwner(lockDir, {
        version: 1,
        ...current.returnTo,
        updatedAt: now().toISOString(),
        currentStep: "reclaimed from an update process that exited",
      });
      return true;
    } finally {
      releaseGuard(claim);
    }
  };

  const owner = readOwner(lockDir);
  return {
    id,
    startedAt: owner?.startedAt ?? now().toISOString(),
    setStep: (step) => update(step, true),
    setProcessGroup: (pid) => update(undefined, true, pid),
    handBack,
    reclaim,
    release,
  };
}

function writeOwner(lockDir: string, owner: UpdateLockOwner): void {
  atomicWriteFileSync(join(lockDir, OWNER_FILE), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

function readOwner(lockDir: string): UpdateLockOwner | null {
  try {
    const path = join(lockDir, OWNER_FILE);
    if (!lstatSync(path).isFile()) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateLockOwner>;
    if (
      value.version !== 1 ||
      typeof value.id !== "string" ||
      typeof value.owner !== "string" ||
      !Number.isInteger(value.pid) ||
      (typeof value.processStart !== "string" && value.processStart !== null) ||
      typeof value.startedAt !== "string" ||
      typeof value.updatedAt !== "string" ||
      typeof value.currentStep !== "string" ||
      (value.processGroupPid !== undefined &&
        (!Number.isInteger(value.processGroupPid) ||
          value.processGroupPid <= 0 ||
          (typeof value.processGroupStart !== "string" && value.processGroupStart !== null))) ||
      (value.processGroupPid === undefined && value.processGroupStart !== undefined) ||
      (value.returnTo !== undefined && !isReturnOwner(value.returnTo))
    ) {
      return null;
    }
    return value as UpdateLockOwner;
  } catch {
    return null;
  }
}

export type UpdateLockProcessGroup =
  | { state: "none" }
  | { state: "gone"; pid: number }
  | { state: "active"; pid: number }
  | { state: "unverified"; pid: number };

/** Inspect the published apply group without ever trusting a reused PGID. */
export function getUpdateLockProcessGroup(configDir: string): UpdateLockProcessGroup {
  const owner = readOwner(join(configDir, LOCK_DIR));
  if (owner?.processGroupPid === undefined) return { state: "none" };
  if (!processGroupExists(owner.processGroupPid)) {
    return { state: "gone", pid: owner.processGroupPid };
  }
  if (
    typeof owner.processGroupStart !== "string" ||
    !sameProcess(owner.processGroupPid, owner.processGroupStart)
  ) {
    return { state: "unverified", pid: owner.processGroupPid };
  }
  return { state: "active", pid: owner.processGroupPid };
}

function processGroupExists(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function updateWorkMayBeActive(owner: UpdateLockOwner): boolean {
  return (
    sameProcess(owner.pid, owner.processStart) ||
    (owner.processGroupPid !== undefined && processGroupExists(owner.processGroupPid))
  );
}

function isReturnOwner(value: unknown, depth = 1): value is UpdateLockReturnOwner {
  if (!value || typeof value !== "object" || depth > MAX_RETURN_DEPTH) return false;
  const owner = value as Partial<UpdateLockReturnOwner>;
  return (
    typeof owner.id === "string" &&
    typeof owner.owner === "string" &&
    Number.isInteger(owner.pid) &&
    (typeof owner.processStart === "string" || owner.processStart === null) &&
    typeof owner.startedAt === "string" &&
    (owner.returnTo === undefined || isReturnOwner(owner.returnTo, depth + 1))
  );
}

function lockMtime(lockDir: string): number {
  try {
    const stat = lstatSync(lockDir);
    return stat.isDirectory() ? stat.mtimeMs : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** A winning unique claim fences this directory generation against ABA replacement. */
type RetireResult = "retired" | "not-owner" | "busy";

function retireLock(
  lockDir: string,
  expectedId?: string,
  canRetire: (owner: UpdateLockOwner | null) => boolean = () => true,
): RetireResult {
  const claim = claimGuard(lockDir);
  if (!claim) {
    return expectedId && readOwner(lockDir)?.id !== expectedId ? "not-owner" : "busy";
  }
  const current = readOwner(lockDir);
  if (expectedId && current?.id !== expectedId) {
    releaseGuard(claim);
    return "not-owner";
  }
  if (!canRetire(current)) {
    releaseGuard(claim);
    return "busy";
  }
  const retired = `${lockDir}.retired-${process.pid}-${randomUUID()}`;
  try {
    if (!lstatSync(lockDir).isDirectory()) {
      releaseGuard(claim);
      return expectedId && readOwner(lockDir)?.id !== expectedId ? "not-owner" : "busy";
    }
    renameSync(lockDir, retired);
  } catch {
    releaseGuard(claim);
    return expectedId && readOwner(lockDir)?.id !== expectedId ? "not-owner" : "busy";
  }
  rmSync(retired, { recursive: true, force: true });
  return "retired";
}

interface GuardClaim {
  version: 1;
  state: "choosing" | "waiting";
  ticket: number;
  pid: number;
  processStart: string | null;
}

/** A filesystem-backed bakery lock serializes owner changes without a toolchain. */
function claimGuard(lockDir: string): string | null {
  const name = `${CLAIM_PREFIX}${randomUUID()}`;
  const claim = join(lockDir, name);
  const identity: GuardClaim = {
    version: 1,
    state: "choosing",
    ticket: 0,
    pid: process.pid,
    processStart: processStart(process.pid),
  };
  try {
    writeFileSync(claim, `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    return null;
  }

  let ticket = 1;
  try {
    const contenders = readdirSync(lockDir).filter((entry) => entry.startsWith(CLAIM_PREFIX));
    for (const entry of contenders) {
      if (entry === name) continue;
      discardStaleClaim(join(lockDir, entry));
      const other = readGuardClaim(join(lockDir, entry));
      if (other?.state === "waiting") ticket = Math.max(ticket, other.ticket + 1);
    }
    identity.state = "waiting";
    identity.ticket = ticket;
    atomicWriteFileSync(claim, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  } catch {
    releaseGuard(claim);
    return null;
  }

  for (let attempt = 0; attempt < 250; attempt += 1) {
    let contenders: string[];
    try {
      contenders = readdirSync(lockDir).filter((entry) => entry.startsWith(CLAIM_PREFIX));
      for (const entry of contenders) {
        if (entry === name) continue;
        discardStaleClaim(join(lockDir, entry));
      }
      contenders = readdirSync(lockDir).filter((entry) => entry.startsWith(CLAIM_PREFIX));
    } catch {
      releaseGuard(claim);
      return null;
    }
    if (!contenders.includes(name)) {
      releaseGuard(claim);
      return null;
    }
    let blocked = false;
    for (const entry of contenders) {
      if (entry === name) continue;
      const other = readGuardClaim(join(lockDir, entry));
      if (
        !other ||
        other.state === "choosing" ||
        other.ticket < ticket ||
        (other.ticket === ticket && entry < name)
      ) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return claim;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
  releaseGuard(claim);
  return null;
}

function readGuardClaim(path: string): GuardClaim | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GuardClaim>;
    if (
      value.version !== 1 ||
      (value.state !== "choosing" && value.state !== "waiting") ||
      !Number.isSafeInteger(value.ticket) ||
      (value.ticket as number) < 0 ||
      !Number.isInteger(value.pid) ||
      (typeof value.processStart !== "string" && value.processStart !== null)
    ) {
      return null;
    }
    return value as GuardClaim;
  } catch {
    return null;
  }
}

function discardStaleClaim(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return;
    const age = Date.now() - stat.mtimeMs;
    // Future mtimes are conservatively live after a backwards clock step.
    if (age < DEFAULT_STALE_MS) return;
    let identity: { pid?: unknown; processStart?: unknown };
    try {
      identity = JSON.parse(readFileSync(path, "utf8")) as typeof identity;
    } catch {
      unlinkSync(path);
      return;
    }
    if (
      Number.isInteger(identity.pid) &&
      (typeof identity.processStart === "string" || identity.processStart === null) &&
      sameProcess(identity.pid as number, identity.processStart)
    ) {
      return;
    }
    unlinkSync(path);
  } catch {
    // A concurrent claimant retired the directory or removed this exact claim.
  }
}

function releaseGuard(claim: string): void {
  try {
    unlinkSync(claim);
  } catch {
    // The whole lock was retired, or this exact claim was already cleaned up.
  }
}

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

function sameProcess(pid: number, expectedStart: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return expectedStart === null || processStart(pid) === expectedStart;
}

function busyMessage(holder: UpdateLockOwner): string {
  return (
    `Another Omnesis update is running on this host: ${holder.owner} (PID ${holder.pid}), ` +
    `started ${holder.startedAt}, currently ${holder.currentStep}.`
  );
}
