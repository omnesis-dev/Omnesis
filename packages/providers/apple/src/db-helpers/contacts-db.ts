// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Lazy-open helper for the Apple Contacts (AddressBook) DBs. macOS
 * stores per-account address books under `Sources/<source-uuid>/`,
 * each with its own `AddressBook-v22.abcddb`. Single-DB setups (older
 * macOS, tests with a stubbed dir) fall back to the directory's main
 * DB file directly.
 *
 * Every address book the scan finds is reported, whether or not it opened.
 * The Contacts source builds its `presentExternalIds` snapshot from that
 * report, and a snapshot is a claim that the enumeration covers everything the
 * source holds — so an address book dropped from the report rather than named
 * as unreadable would be indistinguishable from an address book whose contacts
 * had all been deleted, and the gateway would delete them.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger, toErrorMessage } from "@omnesis/core";
import { contactsDbFile } from "../paths.js";
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

const log = createLogger("provider:apple:contacts-db");

/** Partition key of the single-DB layout (no `Sources/` subdirectories). */
const MAIN_STORE_KEY = "main";

/** Partition key standing for the `Sources/` scan itself. */
const SOURCES_DIR_KEY = "Sources";

/**
 * One per-account address book. `key` is the partition identifier the snapshot
 * is accounted against — the `Sources/<uuid>` directory name, or `main` for the
 * single-DB layout.
 */
export type ContactsStore =
  | { kind: "open"; key: string; db: Db }
  | { kind: "unavailable"; key: string; reason: string };

export class ContactsDbHelper implements AppleDbLifecycle {
  private readonly opened = new Map<string, Db>();
  /** Gaps already written to the log, so a standing one is not repeated. */
  private readonly warned = new Map<string, string>();
  private readonly unavailable = new Map<string, AppleStoreGap>();

  constructor(public readonly dirPath: string) {}

  /** Path to the main AddressBook DB inside `dirPath`. */
  get dbFilePath(): string {
    return contactsDbFile(this.dirPath);
  }

  /** True when the AddressBook directory exists OR a DB is already open. */
  isAvailable(): boolean {
    return this.opened.size > 0 || existsSync(this.dirPath);
  }

  /**
   * Rescan the address-book directory, opening any store not already open.
   *
   * Re-running is deliberate rather than a no-op once something is open: an
   * address book that was locked, corrupt or unreadable last cycle must get
   * another chance, and a new iCloud account adds a `Sources/<uuid>/` directory
   * mid-session. A set of stores opened once and then frozen would hold a
   * transient failure for the life of the process, and with it the snapshot.
   */
  open(): void {
    this.unavailable.clear();

    const sourcesDir = join(this.dirPath, "Sources");
    let scannedSources = false;
    if (existsSync(sourcesDir)) {
      let dirs: string[] = [];
      try {
        dirs = readdirSync(sourcesDir).filter((f) => !f.startsWith("."));
        scannedSources = true;
      } catch (err) {
        this.recordUnavailable(
          SOURCES_DIR_KEY,
          describeListingGap(err, `cannot list ${sourcesDir}`),
        );
      }
      for (const dir of dirs) {
        const dbPath = contactsDbFile(join(sourcesDir, dir));
        if (!existsSync(dbPath)) {
          // The account's directory exists but its database file does not —
          // an address book part-way through an iCloud download, most often.
          // Skipping it here would drop the partition before the enumeration
          // could see it, which is the same mass-delete instruction as a failed
          // open, arriving through a quieter door. A directory that stays in
          // this state is worth the operator's attention, and the warning says
          // so every cycle.
          this.recordUnavailable(dir, {
            kind: "absent",
            reason: `has no database file yet at ${dbPath} — the address book may still be downloading`,
          });
          continue;
        }
        this.openStore(dir, dbPath, `Contacts source ${dir}`);
      }
    }

    // Fallback: the single-DB layout, used when the scan found no per-account
    // store at all (older macOS, or a test dir holding a bare AddressBook file).
    if (!scannedSources || (this.opened.size === 0 && this.unavailable.size === 0)) {
      const mainDbPath = this.dbFilePath;
      if (existsSync(mainDbPath)) this.openStore(MAIN_STORE_KEY, mainDbPath, "Contacts");
    }
  }

  /**
   * Open one address book and probe its contact table. A store that opens but
   * cannot be probed is recorded as unavailable rather than dropped: its
   * contacts exist, they just could not be enumerated this cycle.
   *
   * An empty store stays open and contributes no ids, which is how the source
   * says "every contact in this address book is gone" without that being
   * confused with a read that failed.
   */
  private openStore(key: string, dbPath: string, label: string): void {
    if (this.opened.has(key)) return;

    const opened = openAppleDb(dbPath);
    if (opened.kind !== "ok") {
      this.recordUnavailable(key, describeStoreGap(opened));
      return;
    }

    try {
      opened.db.prepare("SELECT COUNT(*) as count FROM ZABCDRECORD WHERE Z_ENT = 22").get();
      this.opened.set(key, opened.db);
    } catch (err) {
      this.recordUnavailable(key, {
        kind: "error",
        reason: `has an unreadable contact table: ${toErrorMessage(err)}`,
      });
      opened.db.close();
    }
  }

  /** Record an address book this scan could not read, and say so once. */
  private recordUnavailable(key: string, gap: AppleStoreGap): void {
    this.unavailable.set(key, gap);
    // Every cycle rescans, so a standing gap would repeat this line forever.
    if (this.warned.get(key) !== gap.reason) {
      log.warn(`Apple Contacts address book ${key} ${gap.reason}`);
      this.warned.set(key, gap.reason);
    }
  }

  /** At least one address book opened. */
  hasOpenDb(): boolean {
    return this.opened.size > 0;
  }

  /**
   * Why this host has no readable address book at all.
   *
   * With one address book open the source has contacts to read, and the ones
   * it could not read are reported as unavailable stores instead — which is
   * what stops a partial read from emitting a snapshot that deletes the rest.
   */
  getLastOpenFailure(): AppleDbOpenFailure | null {
    if (this.opened.size > 0) return null;
    const blocking = blockingGap(this.unavailable);
    if (!blocking) return null;
    const { key, kind, reason, remediation } = blocking;
    return {
      kind,
      message: `No Apple Contacts address book could be read: ${key} ${reason}.`,
      ...(remediation ? { remediation } : {}),
    };
  }

  /**
   * Every address book the scan found, opened or not, keyed by partition. The
   * caller must account for each one before it may emit a snapshot.
   */
  getStores(): ContactsStore[] {
    this.open();
    const stores: ContactsStore[] = [];
    for (const [key, db] of this.opened) stores.push({ kind: "open", key, db });
    for (const [key, { reason }] of this.unavailable)
      stores.push({ kind: "unavailable", key, reason });
    return stores;
  }

  /** Get all open DBs, opening them lazily on first call. */
  getDbs(): Db[] {
    this.open();
    return [...this.opened.values()];
  }

  close(): void {
    for (const db of this.opened.values()) db.close();
    this.opened.clear();
    this.unavailable.clear();
    this.warned.clear();
  }

  /** Sum of person rows (`Z_ENT = 22`) across every open DB. */
  count(): number {
    let total = 0;
    for (const db of this.opened.values()) {
      try {
        const result = db
          .prepare("SELECT COUNT(*) as count FROM ZABCDRECORD WHERE Z_ENT = 22")
          .get() as { count: number };
        total += result.count;
      } catch {
        /* skip */
      }
    }
    return total;
  }
}
