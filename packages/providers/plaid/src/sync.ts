// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Phase orchestrator for one connected Plaid item.
 *
 * Three shapes of data share one phase machine, driven by the `PlaidCursor`:
 *
 *  1. **transactions** — Plaid's `/transactions/sync` delta
 *     ({@link PlaidTransactionsSource}), self-paginating via `has_more`; drains
 *     the requested history on the first pass, then only the delta.
 *  2. **balances** + **holdings** — point-in-time snapshots
 *     ({@link PlaidSnapshotSource}), a single non-paginated request each,
 *     day-folded into a composite-PK append-only row.
 *  3. **incremental** — steady state: poll the transactions delta, and take a
 *     fresh snapshot when the UTC day rolls over so point-in-time history
 *     accumulates one snapshot per day. A tick with nothing new returns
 *     `hasMore: false` and the source idles until its next scheduled run.
 *
 * Transactions run FIRST on a fresh item, because they are the corpus: a
 * snapshot leg reaches the institution and can fail on a bank outage, and
 * ordering it first would hold the whole item's history behind a bad afternoon
 * at the bank. The snapshot legs then follow, and a failure in either is
 * tolerated for the tick — the day's snapshot is skipped and retried on the
 * next run rather than failing a sync that already ingested transactions.
 *
 * Phase order on a fresh item (cursor null): `transactions` →
 * `snapshot-balances` → `snapshot-holdings` → `incremental`. The snapshot day
 * is pinned in the balances phase and carried through holdings, so a pass that
 * straddles UTC midnight writes ONE consistent day.
 *
 * `now` is injectable so tests and the synth twin pin the snapshot day and the
 * day-rollover deterministically.
 */

import { assertNever, createLogger } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { plaidBalancesSchema, plaidHoldingsSchema } from "./schemas.js";
import { PlaidSnapshotSource, utcDateOf } from "./snapshot.js";
import { PlaidTransactionsSource } from "./transactions.js";
import type { AnalyticsTableSchema, StructuredSyncResult, SyncOptions } from "@omnesis/source-sdk";
import type { ProviderId, SourceId } from "@omnesis/types";
import type { PlaidTransport } from "./client.js";
import type { PlaidCursor } from "./types.js";

const log = createLogger("provider:plaid:sync");

type Result = StructuredSyncResult<PlaidCursor>;

export interface PlaidSyncSourceOptions {
  /** ISO 8601 — transactions before this are skipped (history-import bound). */
  dataCutoff?: string;
  /** Institution display name, for the co-emitted document's account label. */
  institutionName?: string;
  /** Injectable clock for deterministic snapshot dating in tests. */
  now?: () => Date;
}

/**
 * Structured source for one Plaid item: the transactions delta followed by
 * balances + holdings snapshots, all under one phase machine.
 */
export class PlaidSyncSource {
  private readonly transactions: PlaidTransactionsSource;
  private readonly snapshots: PlaidSnapshotSource;
  private readonly now: () => Date;

  constructor(
    client: PlaidTransport,
    providerId: ProviderId,
    sourceId: SourceId,
    /** The connected item id — the Omnesis accountId. */
    private readonly itemId: string,
    /** Per-item access token (secret — never logged). */
    accessToken: string,
    opts: PlaidSyncSourceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.transactions = new PlaidTransactionsSource(
      client,
      providerId,
      sourceId,
      itemId,
      accessToken,
      { dataCutoff: opts.dataCutoff, institutionName: opts.institutionName, now: this.now },
    );
    this.snapshots = new PlaidSnapshotSource(client, itemId, accessToken, this.now);
  }

  async syncStructured(cursor: PlaidCursor | null, opts?: SyncOptions): Promise<Result> {
    const c: PlaidCursor = cursor ?? { phase: "transactions" };
    switch (c.phase) {
      case "transactions":
        // Drain the delta; advance to the day's snapshot once caught up.
        return this.transactions.transactionsPage(c, "snapshot-balances", opts);
      case "snapshot-balances":
        // A failed balances leg skips the WHOLE day's snapshot: letting the
        // holdings leg run would stamp `lastSnapshotDate`, and the day would
        // never be retried, leaving a permanent hole in the balance history.
        return this.snapshotLeg(
          c,
          opts,
          () => this.snapshots.balancesPage(c, opts),
          { phase: "incremental", lastSnapshotDate: c.lastSnapshotDate },
          plaidBalancesSchema,
        );
      case "snapshot-holdings":
        return this.snapshotLeg(
          c,
          opts,
          () => this.snapshots.holdingsPage(c, opts),
          // Balances already landed for this day, so record it: only the
          // positions are missing, and they are retried tomorrow.
          {
            ...c,
            phase: "incremental",
            snapshotDate: undefined,
            lastSnapshotDate: c.snapshotDate ?? utcDateOf(this.now()),
          },
          plaidHoldingsSchema,
        );
      case "incremental":
        return this.incrementalPage(c, opts);
      default:
        return assertNever(c.phase);
    }
  }

  /**
   * Steady state. Poll the transactions delta, then take a fresh snapshot when
   * the UTC day has rolled over so point-in-time history accumulates a new day.
   * A tick with nothing new returns `hasMore: false` and the source idles.
   */
  private async incrementalPage(cursor: PlaidCursor, opts?: SyncOptions): Promise<Result> {
    const today = utcDateOf(this.now());
    const next: PlaidCursor["phase"] =
      cursor.lastSnapshotDate === today ? "incremental" : "snapshot-balances";
    return this.transactions.transactionsPage({ ...cursor, phase: "transactions" }, next, opts);
  }

  /**
   * Run one snapshot leg, tolerating a failure. The transactions the tick
   * already ingested are the point of the sync; a bank that is briefly
   * unreachable should cost this day's balance row, not the whole run. The
   * cursor advances either way, so a failed leg is retried on the next run
   * rather than repeated within this one.
   */
  private async snapshotLeg(
    cursor: PlaidCursor,
    opts: SyncOptions | undefined,
    run: () => Promise<Result>,
    onFailure: PlaidCursor,
    table: AnalyticsTableSchema,
  ): Promise<Result> {
    try {
      return await run();
    } catch (err) {
      if (opts?.signal?.aborted) throw err;
      // A revoked consent must park the source in needs-auth, and a rate limit
      // carries the delay the collector backs off by — neither is this leg's
      // to swallow.
      if (err instanceof SyncError && (err.kind === "auth" || err.kind === "rate-limit")) throw err;
      log.warn(
        `Plaid item ${this.itemId}: skipping the ${cursor.phase} snapshot this run ` +
          `(${(err as Error).message})`,
      );
      return {
        analytics: { tableName: table.tableName, records: [], schema: table },
        cursor: onFailure,
        hasMore: onFailure.phase !== "incremental",
      };
    }
  }
}
