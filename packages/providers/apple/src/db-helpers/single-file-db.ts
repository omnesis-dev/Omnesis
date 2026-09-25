// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared lifecycle for the Apple databases that live in one file — Notes,
 * iMessage, Calendar, Call Log, Voicemail.
 *
 * All five are opened by a collector that may or may not hold the macOS
 * privacy grant they sit behind, against files macOS is free to be mid-write
 * on, and each one is read by exactly one source. So the rule they share is:
 * an open that does not produce a usable database is recorded here and never
 * thrown. The provider opens all of them in a single pass, so a helper that
 * threw would end that pass and take the other sources' databases with it,
 * however readable they were. The source that owns this database is the one
 * that turns the record into a typed sync error, at sync time, where it costs
 * only itself.
 */

import { existsSync } from "node:fs";
import { toErrorMessage, type Logger } from "@omnesis/core";
import {
  openAppleDb,
  type AppleDbLifecycle,
  type AppleDbOpenFailure,
  type AppleDenial,
  type Db,
} from "./internal.js";
import type { SyncRemediation } from "@omnesis/types";

export abstract class SingleFileAppleDb implements AppleDbLifecycle {
  protected db: Db | null = null;
  private failure: AppleDbOpenFailure | null = null;
  /** Last failure written to the log, so a standing one is not re-announced. */
  private warned: string | null = null;

  /**
   * @param path        the database file.
   * @param label       how the database is named to an operator, e.g. "Apple Notes".
   * @param denied      what to do about a refused read of this specific file.
   *                    Most sit behind Full Disk Access; the ones that do not
   *                    say what they need instead, because sending an operator
   *                    to a setting that cannot help them is worse than saying
   *                    nothing.
   * @param log         the helper's own logger component.
   */
  constructor(
    readonly path: string,
    private readonly label: string,
    private readonly denied: AppleDenial,
    private readonly log: Logger,
  ) {}

  /** True when the file is on disk, or a database is already open. */
  isAvailable(): boolean {
    return this.db !== null || existsSync(this.path);
  }

  hasOpenDb(): boolean {
    return this.db !== null;
  }

  /**
   * Why this database is unusable, or `null` when it is open — or simply
   * absent, which is not a failure.
   */
  getLastOpenFailure(): AppleDbOpenFailure | null {
    return this.failure;
  }

  /**
   * Open the database if it is not open already. Idempotent, and safe to
   * re-run every cycle: a denial that is lifted, or a lock that clears, opens
   * on the next attempt and clears the recorded failure with it.
   */
  open(): void {
    if (this.db) return;

    // A database this host does not have is not a failure to report, and one
    // that has since been removed must stop being reported as one: SQLite
    // cannot tell a missing file from an unreadable one, and the difference is
    // the whole distinction between a source with nothing to sync and a source
    // the operator has to go and fix.
    if (!existsSync(this.path)) {
      this.failure = null;
      this.warned = null;
      return;
    }

    const result = openAppleDb(this.path);
    if (result.kind === "denied") {
      this.recordFailure(
        "denied",
        `Cannot open the ${this.label} database — ${this.denied.hint}`,
        this.denied.remediation,
      );
      return;
    }
    if (result.kind === "busy") {
      this.recordFailure(
        "busy",
        `The ${this.label} database is locked (SQLITE_BUSY) — retrying on the next sync cycle.`,
      );
      return;
    }
    if (result.kind === "error") {
      this.recordFailure(
        "error",
        `Cannot open the ${this.label} database: ${toErrorMessage(result.error)}`,
      );
      return;
    }

    // A database that opens can still fault on its first read — a truncated
    // file, a schema this provider has not been taught — and that is this
    // helper's failure to record like any other, not an exception for the
    // provider's open pass to trip over.
    let rejection: string | null;
    try {
      rejection = this.reject(result.db);
    } catch (err) {
      rejection = `Cannot read the ${this.label} database: ${toErrorMessage(err)}`;
    }
    if (rejection) {
      result.db.close();
      this.recordFailure("error", rejection);
      return;
    }

    this.db = result.db;
    this.failure = null;
    this.warned = null;
  }

  /** Get the database, opening it lazily on first use and after a failure. */
  getDb(): Db | null {
    if (!this.db) this.open();
    return this.db;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Inspect a database that opened and reject it by returning the reason. The
   * default accepts everything; a helper whose schema it cannot read overrides
   * this rather than handing the source a database it will fail on later.
   */
  protected reject(_db: Db): string | null {
    return null;
  }

  /**
   * Record why the database is unusable, and say so once. `open()` runs on
   * every cycle and on every lazy `getDb()`, so a standing failure would
   * otherwise fill the log with the same line; a failure that changes is
   * announced again. The durable channel is the source's sync error, which is
   * raised every cycle.
   */
  private recordFailure(
    kind: AppleDbOpenFailure["kind"],
    message: string,
    remediation?: SyncRemediation,
  ): void {
    this.failure = { kind, message, ...(remediation ? { remediation } : {}) };
    if (this.warned !== message) {
      this.log.warn(message);
      this.warned = message;
    }
  }
}
