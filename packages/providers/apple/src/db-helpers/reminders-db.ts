// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Lazy-open helper for Apple Reminders DBs. One macOS host can hold
 * multiple per-account stores under the Reminders directory
 * (`Data-<uuid>.sqlite` files); this helper opens each one read-only
 * and skips empty stores so the source's per-store sync logic only
 * sees stores that actually carry reminders.
 *
 * Account → store correlation is delegated to
 * `AppleAccountResolver` so the helper doesn't have to know about
 * MobileMeAccounts.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger, toErrorMessage } from "@omnesis/core";
import {
  blockingGap,
  describeListingGap,
  describeStoreGap,
  openAppleDb,
  type AppleDbLifecycle,
  type AppleDbOpenFailure,
  type AppleStoreGap,
  type Db,
} from "./internal.js";
import type { SnapshotGap } from "@omnesis/source-sdk";
import type { RemindersStoreInfo } from "../types.js";
import type { AppleAccountResolver } from "../account-resolver.js";

const log = createLogger("provider:apple:reminders-db");

/** Partition key standing for the stores directory scan itself. */
const STORES_DIR_KEY = "Stores";

export class RemindersDbHelper implements AppleDbLifecycle {
  private dbs: Map<string, Db> = new Map();
  private skipped: Map<string, AppleStoreGap> = new Map();
  /** Skips already written to the log, so a standing one is not repeated. */
  private warned: Map<string, string> = new Map();

  constructor(public readonly dirPath: string) {}

  /** True when any store file is on disk OR already opened. */
  isAvailable(): boolean {
    return this.dbs.size > 0 || existsSync(this.dirPath);
  }

  /**
   * Idempotent — re-running scans for new store files (a freshly
   * created iCloud account adds a new `Data-<uuid>.sqlite` mid-session,
   * which we want to pick up without restarting the provider).
   */
  open(): void {
    if (!existsSync(this.dirPath)) return;

    this.skipped.clear();

    // The provider opens every Apple database in one pass, so a directory this
    // process cannot list is recorded like any other unreadable store rather
    // than thrown — a throw here would end that pass and cost the sources that
    // read the other six databases.
    let files: string[];
    try {
      files = readdirSync(this.dirPath).filter(
        (f) => f.startsWith("Data-") && f.endsWith(".sqlite"),
      );
    } catch (err) {
      this.recordSkip(STORES_DIR_KEY, describeListingGap(err, "cannot be listed"));
      return;
    }

    for (const file of files) {
      if (this.dbs.has(file)) continue;

      const fullPath = join(this.dirPath, file);
      const opened = openAppleDb(fullPath);
      if (opened.kind !== "ok") {
        this.recordSkip(file, describeStoreGap(opened));
        continue;
      }
      try {
        const db = opened.db;
        // Only keep DBs that have any reminders (including trashed,
        // for deletion detection).
        const row = db.prepare("SELECT COUNT(*) as count FROM ZREMCDREMINDER").get() as {
          count: number;
        };
        if (row.count > 0) {
          this.dbs.set(file, db);
        } else {
          db.close();
        }
      } catch (err) {
        this.recordSkip(file, {
          kind: "error",
          reason: `has an unreadable reminder table: ${toErrorMessage(err)}`,
        });
        opened.db.close();
      }
    }
  }

  /**
   * Record a store this scan could not read, and say so where an operator will
   * see it. A skipped store is a hole in what the source knows: a reader that
   * merely dropped it would present the stores it did open as though they were
   * all of them, which is the shape that lets a snapshot delete the rest.
   */
  private recordSkip(file: string, gap: AppleStoreGap): void {
    this.skipped.set(file, gap);
    // Every cycle rescans, so a standing skip would repeat this line forever.
    if (this.warned.get(file) !== gap.reason) {
      log.warn(`Apple Reminders store ${file} ${gap.reason}`);
      this.warned.set(file, gap.reason);
    }
  }

  /** At least one store opened and carries reminders. */
  hasOpenDb(): boolean {
    return this.dbs.size > 0;
  }

  /**
   * Why this host has no readable Reminders store at all.
   *
   * A partial read is not reported here: with one store open the source has
   * work to do, and the stores it could not read are reported as snapshot gaps
   * instead, which is what stops a partial read from deleting the rest. `null`
   * therefore also covers the host whose stores are all simply empty — that is
   * an answer, not a failure.
   */
  getLastOpenFailure(): AppleDbOpenFailure | null {
    if (this.dbs.size > 0) return null;
    const blocking = blockingGap(this.skipped);
    if (!blocking) return null;
    const { key, kind, reason, remediation } = blocking;
    return {
      kind,
      message: `No Apple Reminders store could be read: ${key} ${reason}.`,
      ...(remediation ? { remediation } : {}),
    };
  }

  /**
   * Stores this scan found but could not read. Any caller assembling a
   * `presentExternalIds` snapshot over Reminders must treat a non-empty list as
   * a reason to withhold it — the reminders in a store that would not open have
   * not gone anywhere.
   */
  getSkippedStores(): SnapshotGap[] {
    this.open();
    return [...this.skipped].map(([partition, { reason }]) => ({ partition, reason }));
  }

  /** Get all open DBs, opening them lazily on first call. */
  getDbs(): Map<string, Db> {
    this.open();
    return this.dbs;
  }

  close(): void {
    for (const [, db] of this.dbs) db.close();
    this.dbs.clear();
    this.skipped.clear();
    this.warned.clear();
  }

  /** Sum of non-trashed reminders across every open store. */
  count(): number {
    let total = 0;
    for (const [, db] of this.dbs) {
      try {
        const row = db
          .prepare(
            "SELECT COUNT(*) as count FROM ZREMCDREMINDER WHERE ZMARKEDFORDELETION != 1 OR ZMARKEDFORDELETION IS NULL",
          )
          .get() as { count: number };
        total += row.count;
      } catch {
        // skip
      }
    }
    return total;
  }

  /**
   * Discover Reminders stores with their owning account emails.
   * Each store's ZACCOUNTID blob is matched against MobileMeAccounts
   * UUIDs via the supplied resolver. Returns only non-empty stores
   * (stores with at least one reminder, including trashed).
   */
  getStoresWithAccounts(resolver: AppleAccountResolver): RemindersStoreInfo[] {
    this.open();
    if (this.dbs.size === 0) return [];

    const accounts = resolver.resolveAllICloudAccounts();
    const results: RemindersStoreInfo[] = [];

    for (const [filename, db] of this.dbs) {
      const accountUuid = resolver.getStoreAccountUuid(db);
      let accountEmail: string | undefined;

      if (accountUuid) {
        accountEmail = accounts.get(accountUuid);
      }

      // Fallback: if this is the only iCloud store and we have a
      // primary account, use it.
      if (!accountEmail && accountUuid && accounts.size === 1) {
        accountEmail = accounts.values().next().value ?? undefined;
      }

      results.push({
        filename,
        db,
        accountEmail: accountEmail ?? undefined,
        accountUuid: accountUuid ?? undefined,
      });

      log.debug(`Reminders store ${filename}`, {
        accountUuid,
        accountEmail,
      });
    }

    return results;
  }
}
