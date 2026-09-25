// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Local persistence for the Enable Banking source:
 *
 *   <configDir>/enable-banking/<accountId>/session.json
 *   <configDir>/enable-banking/<accountId>/bootstrap/<account_key>/page-0000.json…
 *   <configDir>/enable-banking/<accountId>/bootstrap/<account_key>/complete.json
 *
 * `session.json` holds the active consent (session id, validity, the
 * account_key → uid map). The bootstrap cache holds the raw transaction
 * pages prefetched during the auth flow — Revolut only serves full history
 * within ~5 minutes of SCA, so the auth flow captures it and the first sync
 * drains it offline. A cache directory without `complete.json` is treated
 * as absent (interrupted prefetch) and sync falls back to the 90-day window.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  acquireUpdateLock,
  DEFAULT_CONFIG_DIR,
  isEncryptedSecretFile,
  readInstallRootKeySync,
  secretFileEncryptionRequired,
  readSecretJsonFileSync,
  writeSecretJsonFileSync,
  writeSecretTextFileSync,
} from "@omnesis/core";
import { safePathSegment } from "@omnesis/types";
import { ebTransactionsPageSchema, storedSessionSchema } from "./schemas.js";
import type { EbTransactionsPage, StoredSession } from "./types.js";

export const ENABLE_BANKING_FILE_KEY = "enable-banking";

export function enableBankingDir(configDir?: string): string {
  return join(configDir ?? DEFAULT_CONFIG_DIR, ENABLE_BANKING_FILE_KEY);
}

export function accountDir(accountId: string, configDir?: string): string {
  return join(enableBankingDir(configDir), safePathSegment(accountId));
}

export function sessionPath(accountId: string, configDir?: string): string {
  return join(accountDir(accountId, configDir), "session.json");
}

/** Read consent and atomically migrate legacy plaintext when a local key is available. */
export function loadSession(accountId: string, configDir?: string): StoredSession | null {
  const path = sessionPath(accountId, configDir);
  if (!existsSync(path)) return null;
  return readStoredJson(path, storedSessionSchema, configDir);
}

/** Offline status inspection must not migrate plaintext or write lock files. */
export function inspectSession(accountId: string, configDir?: string): StoredSession | null {
  const raw = readSecretJsonFileSync<unknown>(sessionPath(accountId, configDir), { configDir });
  return raw === null ? null : storedSessionSchema.parse(raw);
}

/** Migrate retained pages, including incomplete prefetch, before the first drain. */
export function migrateBootstrapCaches(accountId: string, configDir?: string): void {
  const home = accountDir(accountId, configDir);
  if (existsSync(home)) {
    for (const file of readdirSync(home)) {
      const stage = atomicStage(file, /^session\.json$/);
      if (stage) migrateStage(join(home, file), stage.pid, configDir);
    }
  }
  const root = bootstrapRootDir(accountId, configDir);
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      for (const file of readdirSync(dir)) {
        if (/^page-\d+\.json$/.test(file)) {
          readStoredJson(join(dir, file), ebTransactionsPageSchema, configDir);
        } else if (file === COMPLETE_MARKER) {
          readStoredJson(join(dir, file), bootstrapMarkerSchema, configDir);
        } else {
          const stage = atomicStage(file, /^(?:page-\d+|complete)\.json$/);
          if (stage) migrateStage(join(dir, file), stage.pid, configDir);
        }
      }
    }
  }
}

function atomicStage(file: string, targetPattern: RegExp): { target: string; pid: number } | null {
  const match = /^(.*)\.omnesis-([0-9a-z]+)([0-9a-f]{12})\.tmp$/.exec(file);
  if (!match || !targetPattern.test(match[1])) return null;
  const pid = Number.parseInt(match[2], 36);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid banking staging owner");
  return { target: match[1], pid };
}

function migrateStage(path: string, pid: number, configDir?: string): void {
  withAccountLock(path, configDir, () => {
    try {
      process.kill(pid, 0);
      throw new Error(
        "Banking staging file may still belong to a live writer; retry after it exits",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const raw = readFileSync(path, "utf8");
    // Atomic writes encrypt for the final target before creating scratch, so
    // existing ciphertext may have a different scope. Preserve it verbatim.
    if (isEncryptedSecretFile(raw) || !migrationWriteNeeded(configDir)) return;
    // Preserve even a partial write for recovery, without claiming it committed.
    writeSecretTextFileSync(path, raw, { configDir });
  });
}

/** A keyless legacy read must not create another plaintext atomic staging file. */
function migrationWriteNeeded(configDir?: string): boolean {
  // Let the secret-file writer report unavailable keys when encryption is required.
  return secretFileEncryptionRequired(configDir) || readInstallRootKeySync({ configDir }) !== null;
}

/** Atomic per-file migration is retryable after interruption; no plaintext backup is made. */
function readStoredJson<T>(path: string, schema: z.ZodType<T>, configDir?: string): T {
  return withAccountLock(path, configDir, () => {
    const value = schema.parse(readSecretJsonFileSync<unknown>(path, { configDir }));
    if (!isEncryptedSecretFile(readFileSync(path, "utf8")) && migrationWriteNeeded(configDir)) {
      writeSecretJsonFileSync(path, value, { configDir });
    }
    return value;
  });
}

/** Coordinate migration with auth subprocess writes and cleanup, outside network awaits. */
function withAccountLock<T>(path: string, configDir: string | undefined, fn: () => T): T {
  const bankRoot = enableBankingDir(configDir);
  const accountId = relative(bankRoot, path).split(/[\\/]/)[0];
  const lock = acquireUpdateLock(join(bankRoot, ".locks", safePathSegment(accountId)), {
    owner: "banking local persistence",
  });
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function writeStoredJson(path: string, value: unknown, configDir?: string): void {
  withAccountLock(path, configDir, () => writeSecretJsonFileSync(path, value, { configDir }));
}

/** Persist the session atomically with mode 0600 (it is an access credential). */
export function saveSession(accountId: string, session: StoredSession, configDir?: string): void {
  writeStoredJson(sessionPath(accountId, configDir), session, configDir);
}

/** Whether the stored consent is still valid at `now`. Offline check only. */
export function isSessionValid(session: StoredSession | null, now: Date): boolean {
  if (!session) return false;
  const validUntil = Date.parse(session.valid_until);
  return Number.isFinite(validUntil) && validUntil > now.getTime();
}

/** Account ids with a persisted session, discovered offline. */
export function listAccountIds(configDir?: string): string[] {
  const dir = enableBankingDir(configDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "session.json")))
    .map((d) => d.name);
}

/** Remove everything stored for an account (session + bootstrap cache). */
export async function removeAccountData(accountId: string, configDir?: string): Promise<void> {
  const path = accountDir(accountId, configDir);
  withAccountLock(path, configDir, () => rmSync(path, { recursive: true, force: true }));
}

// ── Bootstrap cache ─────────────────────────────────────────────────

/** account_key is a hash but not guaranteed filesystem-safe — sanitize. */
function sanitizeKey(accountKey: string): string {
  return accountKey.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Root of all per-account bootstrap caches for one connected bank. */
export function bootstrapRootDir(accountId: string, configDir?: string): string {
  return join(accountDir(accountId, configDir), "bootstrap");
}

export function bootstrapAccountDir(
  accountId: string,
  accountKey: string,
  configDir?: string,
): string {
  return join(bootstrapRootDir(accountId, configDir), sanitizeKey(accountKey));
}

function bootstrapPagePath(dir: string, pageIndex: number): string {
  return join(dir, `page-${String(pageIndex).padStart(4, "0")}.json`);
}

const COMPLETE_MARKER = "complete.json";

/** Bootstrap paths have a fixed provider/account/bootstrap/key topology. */
function bootstrapConfigDir(dir: string, configDir?: string): string {
  return configDir ?? resolve(dir, "../../../..");
}

export function writeBootstrapPage(
  dir: string,
  pageIndex: number,
  page: EbTransactionsPage,
  configDir?: string,
): void {
  writeStoredJson(bootstrapPagePath(dir, pageIndex), page, bootstrapConfigDir(dir, configDir));
}

/** Completion marker of a prefetched cache: page count + the consent epoch. */
export interface BootstrapMarker {
  /** Number of page files the prefetch wrote. */
  pages: number;
  /**
   * `session_id` of the consent the cache was prefetched under. The drain
   * cursor records the epoch it started against; a mismatch means a
   * re-consent wiped and renumbered the cache underneath the cursor.
   */
  sessionId: string;
}

const bootstrapMarkerSchema = z.object({
  pages: z.number().int().nonnegative(),
  session_id: z.string().min(1),
});

/**
 * Mark the prefetch complete; `pages` is the number of page files written
 * and `sessionId` stamps the consent epoch the cache belongs to.
 */
export function markBootstrapComplete(
  dir: string,
  pages: number,
  sessionId: string,
  configDir?: string,
): void {
  writeStoredJson(
    join(dir, COMPLETE_MARKER),
    { pages, session_id: sessionId },
    bootstrapConfigDir(dir, configDir),
  );
}

/** Missing marker means interrupted prefetch; unreadable state must remain recoverable. */
export function completedBootstrapMarker(dir: string, configDir?: string): BootstrapMarker | null {
  const markerPath = join(dir, COMPLETE_MARKER);
  if (!existsSync(markerPath)) return null;
  const marker = readStoredJson(
    markerPath,
    bootstrapMarkerSchema,
    bootstrapConfigDir(dir, configDir),
  );
  return { pages: marker.pages, sessionId: marker.session_id };
}

/** Authentication, validation and key failures preserve the only full-history copy. */
export function readBootstrapPage(
  dir: string,
  pageIndex: number,
  configDir?: string,
): EbTransactionsPage {
  return readStoredJson(
    bootstrapPagePath(dir, pageIndex),
    ebTransactionsPageSchema,
    bootstrapConfigDir(dir, configDir),
  );
}

/**
 * Invalidate a cache from a stale consent mid-drain: the whole
 * directory goes, so `completedBootstrapMarker` reports it absent (every
 * subsequent sync page takes the network-fallback path) and no raw page
 * files linger on disk.
 */
export function invalidateBootstrapCache(dir: string): void {
  withAccountLock(dir, bootstrapConfigDir(dir), () =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

/** Wipe a (possibly stale) bootstrap cache before a fresh prefetch. */
export async function clearBootstrapCache(dir: string): Promise<void> {
  invalidateBootstrapCache(dir);
}

/**
 * Remove every bootstrap cache for one connected bank. Called once the
 * bootstrap phase has fully drained: the raw full-history pages are in the
 * analytics DB by then and must not sit on disk indefinitely.
 */
export function removeBootstrapCaches(accountId: string, configDir?: string): void {
  const path = bootstrapRootDir(accountId, configDir);
  withAccountLock(path, configDir, () => rmSync(path, { recursive: true, force: true }));
}
