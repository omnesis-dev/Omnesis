// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { open, stat, unlink, type FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_GATEWAY_TIMEOUT_MS, OAUTH_TOKEN_TIMEOUT_MS } from "./request-budgets.js";

const REFRESH_LOCK_WAIT_MS = 25;
/**
 * How long a process waits for another one's refresh to finish.
 *
 * Outlasts the holder's worst case — a refresh, its one repeat and a
 * re-issue, each on the token-request budget, plus the two metadata
 * discoveries the SDK may make on the ordinary budget, one per pass — so a
 * waiter behind a stalled gateway adopts the holder's result instead of
 * failing.
 *
 * @internal Exported for the budget-consistency test.
 */
export const REFRESH_LOCK_TIMEOUT_MS =
  3 * OAUTH_TOKEN_TIMEOUT_MS + 2 * DEFAULT_GATEWAY_TIMEOUT_MS + 10_000;
/**
 * The age past which a lease whose owner cannot be seen alive is reclaimed.
 *
 * Above the longest a live holder keeps it, so a holder whose process id is
 * not visible from here, as across a container boundary, is never cut short.
 *
 * @internal Exported for the budget-consistency test.
 */
export const REFRESH_LOCK_STALE_MS = 4 * 60_000;

/** The cross-process refresh lease, shared with the Hermes adapter. */
export async function withCredentialRefreshLock(
  credentialsPath: string,
  expectedBearer: string | undefined,
  readBearer: () => string | undefined,
  refresh: () => Promise<void>,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const lockPath = `${credentialsPath}.refresh.lock`;
  const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS;
  for (;;) {
    options.signal?.throwIfAborted();
    if (expectedBearer && readBearer() !== expectedBearer) return;
    let handle: FileHandle | null = null;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
    } catch (error) {
      await handle?.close();
      if (!isAlreadyExists(error)) throw error;
      await removeStaleRefreshLock(lockPath);
      if (Date.now() >= deadline) {
        if (expectedBearer && readBearer() !== expectedBearer) return;
        throw new Error("Timed out waiting for another Omnesis OAuth refresh process", {
          cause: error,
        });
      }
      await delay(REFRESH_LOCK_WAIT_MS, undefined, { signal: options.signal });
      continue;
    }

    try {
      options.signal?.throwIfAborted();
      if (expectedBearer && readBearer() !== expectedBearer) return;
      await refresh();
      return;
    } finally {
      await releaseOwnedRefreshLock(lockPath, handle);
    }
  }
}

/** @internal Exported for the cross-process lease regression tests. */
export async function removeStaleRefreshLock(lockPath: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(lockPath, "r");
    const inspected = await handle.stat({ bigint: true });
    if (Date.now() - Number(inspected.mtimeMs) <= REFRESH_LOCK_STALE_MS) return;
    const ownerPid = Number.parseInt((await handle.readFile("utf8")).trim(), 10);
    if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && processIsAlive(ownerPid)) return;

    // Re-check the directory entry against the opened inode. A prior owner may
    // have released its lock and a new refresher may have acquired the same
    // path while this process was inspecting it; never unlink that new lease.
    const current = await stat(lockPath, { bigint: true });
    if (inspected.dev === current.dev && inspected.ino === current.ino) await unlink(lockPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}

async function releaseOwnedRefreshLock(lockPath: string, handle: FileHandle): Promise<void> {
  try {
    const [owned, current] = await Promise.all([
      handle.stat({ bigint: true }),
      stat(lockPath, { bigint: true }),
    ]);
    if (owned.dev === current.dev && owned.ino === current.ino) await unlink(lockPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  } finally {
    await handle.close();
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
