// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What an update reads off the host's running processes rather than its files:
 * whether the gateway is running, a backup of one that is not, and whether a
 * running daemon started from the build that is installed now.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireGatewayLock,
  DEFAULT_PRE_UPDATE_BACKUP_COUNT,
  GATEWAY_STORE_FILE,
  GatewayLockHeldError,
  gatewayStoreFiles,
  liveGatewayHolder,
  prunePreUpdateBackups,
  writeOfflineBackup,
  type BackupLog,
  type BackupPurpose,
} from "@omnesis/core";
import { parseUpdateApplyState, UPDATE_STATE_FILE } from "./detect.js";

export type OfflineBackupOutcome =
  /** The closed stores were copied into a backup at `path`. */
  | { kind: "copied"; path: string }
  /** The gateway has never created its document store; there is nothing to keep. */
  | { kind: "nothing-to-copy" }
  /** A gateway took the stores since the plan was made; its API takes the backup. */
  | { kind: "gateway-running" };

/**
 * Back up a gateway that is not running by copying its closed stores.
 *
 * The config directory's gateway lock is taken for the length of the copy,
 * without waiting: a gateway already holding it answers the backup through its
 * API instead, and a gateway that starts during the copy waits for the lock
 * before it opens a store, so no store changes under the copy. The index is
 * skipped as the online pre-update backup skips it: it rebuilds from the
 * document store.
 */
export async function takeOfflineGatewayBackup(opts: {
  configDir: string;
  note: string;
  purpose: BackupPurpose;
  version: string;
  env?: NodeJS.ProcessEnv;
  log: BackupLog;
}): Promise<OfflineBackupOutcome> {
  const stores = gatewayStoreFiles(opts.configDir, {
    includeIndex: false,
    ...(opts.env ? { env: opts.env } : {}),
  }).filter((store) => existsSync(store.path));
  if (!stores.some((store) => store.name === GATEWAY_STORE_FILE)) {
    return { kind: "nothing-to-copy" };
  }
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock(opts.configDir, { waitMs: 0 });
  } catch (err) {
    if (err instanceof GatewayLockHeldError) return { kind: "gateway-running" };
    throw err;
  }
  try {
    const result = writeOfflineBackup({
      configDir: opts.configDir,
      stores,
      includeIndex: false,
      version: opts.version,
      purpose: opts.purpose,
      note: opts.note,
    });
    const keep = preUpdateRetention(opts.configDir);
    if (keep === null) {
      opts.log.warn(
        "Kept every earlier pre-update backup: backupRetention.preUpdateCount could not be read.",
      );
    } else if (opts.purpose === "pre-update") {
      prunePreUpdateBackups(join(opts.configDir, "backups"), keep, result.path, opts.log);
    }
    return { kind: "copied", path: result.path };
  } finally {
    lock.release();
  }
}

/**
 * `backupRetention.preUpdateCount` from the config file, the default when the
 * file or the key is absent, and null when it cannot be read — in which case
 * nothing is pruned, since pruning deletes backups.
 */
export function preUpdateRetention(configDir: string): number | null {
  const path = join(configDir, "omnesis.json");
  if (!existsSync(path)) return DEFAULT_PRE_UPDATE_BACKUP_COUNT;
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      backupRetention?: { preUpdateCount?: unknown };
    };
    const count = config.backupRetention?.preUpdateCount;
    if (count === undefined) return DEFAULT_PRE_UPDATE_BACKUP_COUNT;
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

/** Whether a gateway process holds this config directory's gateway lock. */
export function gatewayRunning(configDir: string): boolean {
  return liveGatewayHolder(configDir) !== null;
}

/**
 * When the source checkout's installation last finished changing: the
 * completion record is written once a build succeeds and never by a run that
 * builds nothing. Null without a completed record for this checkout.
 */
export function sourceInstalledAt(configDir: string, rootDir: string): number | null {
  const path = join(configDir, UPDATE_STATE_FILE);
  try {
    const state = parseUpdateApplyState(readFileSync(path, "utf8"));
    if (state?.method !== "source" || state.phase !== "complete" || state.rootDir !== rootDir) {
      return null;
    }
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * When the package containing `importMetaUrl` was installed. The manifest's
 * change time, not its modification time: npm extracts files with the
 * tarball's fixed timestamps, while the inode's change time is set when the
 * file is written and cannot be set back.
 */
export function packageInstalledAt(importMetaUrl: string): number | null {
  let dir = dirname(fileURLToPath(importMetaUrl));
  for (let i = 0; i < 10; i += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        return statSync(manifest).ctimeMs;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * When a process started, from `ps`, which reads the same on Linux and macOS.
 * Second precision, so a daemon restarted within the second an install
 * finished reads as older — the direction that keeps a restart hint.
 */
export function processStartedAt(pid: number): number | null {
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    const ms = Date.parse(started);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** When this config directory's running gateway took its lock, which it does first. */
export function gatewayStartedAt(configDir: string): number | null {
  const holder = liveGatewayHolder(configDir);
  if (!holder) return null;
  const ms = Date.parse(holder.startedAt);
  return Number.isFinite(ms) ? ms : null;
}
