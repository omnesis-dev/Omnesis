// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Structured sync for a Coinbase portfolio (#752 + #753).
 *
 * Two shapes of data share one phase machine:
 *
 * - **Balances + holdings** are point-in-time snapshots. Both tables fold a
 *   `snapshot_date` (UTC day) into their composite primary key — the
 *   day-snapshot convention. A same-day re-sync (including an at-least-once
 *   page retry) overwrites the day's rows via `ON CONFLICT … DO UPDATE`, so it
 *   neither duplicates nor destroys data; a new UTC day appends a fresh
 *   snapshot, so net-worth-over-time = `GROUP BY snapshot_date`. The day for a
 *   pass is pinned on the first balances page and carried across every snapshot
 *   page, so a multi-page snapshot that straddles UTC midnight writes ONE
 *   consistent day (at most a benign one-day-late edge, never a torn snapshot).
 *
 * - **Orders, fills, and the v2 transaction ledger** are current-state
 *   APPEND-ONLY activity. Each row is keyed on the stable upstream id
 *   (`order_id` / `trade_id` / transaction id), so an at-least-once page retry
 *   upserts the identical PK (no duplicate, no loss). Each walk persists a
 *   watermark (newest timestamp ingested) and the next pass fetches only rows
 *   at/after it — settled history is never re-walked. The watermark is promoted
 *   only when a walk completes, so an interrupted multi-page walk re-covers from
 *   the old watermark; the stable-id PK makes the overlap idempotent. The
 *   watermark filter is inclusive (`>=`) so a row arriving at the exact cursor
 *   timestamp is re-seen, never skipped — again deduped by the PK.
 *
 * The v2 ledger needs the additional read-only `wallet:transactions:read`
 * grant. If it is absent the v2 reads throw {@link CoinbaseScopeError}, which
 * the transactions phase catches and SKIPS gracefully (the source stays
 * healthy, the other phases are unaffected, and the cursor records the grant
 * as unavailable so later passes don't re-probe until re-auth).
 *
 * `now` is injectable so tests pin dates and the day-rollover deterministically.
 */

import { createLogger } from "@omnesis/core";
import { CoinbaseScopeError } from "./client.js";
import {
  accountsToBalanceRecords,
  fillToRecord,
  orderToRecord,
  spotPositionToHoldingRecord,
  toIso,
  transactionToDocument,
  transactionToRecord,
  v2AccountCurrency,
} from "./normalizer.js";
import {
  coinbaseBalancesTableSchema,
  coinbaseFillsTableSchema,
  coinbaseHoldingsTableSchema,
  coinbaseOrdersTableSchema,
  coinbaseTransactionsTableSchema,
} from "./schemas.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { CoinbaseClient } from "./client.js";
import type { CoinbaseCursor } from "./types.js";

const log = createLogger("provider:coinbase:snapshot");

/** Page size for the balances walk (Coinbase caps accounts paging at 250). */
export const ACCOUNTS_PAGE_SIZE = 250;

export interface CoinbaseSnapshotSourceOptions {
  /** Injectable clock for deterministic snapshot dating in tests. */
  now?: () => Date;
}

/**
 * Structured source for a Coinbase portfolio. Emits balances and holdings as
 * point-in-time snapshots, and orders/fills/transactions as append-only rows
 * (transactions also co-emit searchable documents).
 */
export class CoinbaseSnapshotSource {
  private readonly now: () => Date;

  constructor(
    private readonly client: CoinbaseClient,
    private readonly providerId: ProviderId,
    private readonly sourceId: SourceId,
    /** Stable per-account key (retail_portfolio_id or hash-derived) — the source's accountId. */
    private readonly accountKey: string,
    /** Omnesis account slug discriminating sibling source instances. */
    private readonly sourceAccountId: string,
    opts: CoinbaseSnapshotSourceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async syncStructured(
    cursor: CoinbaseCursor | null,
  ): Promise<StructuredSyncResult<CoinbaseCursor>> {
    const c: CoinbaseCursor = cursor ?? { phase: "snapshot-balances" };
    switch (c.phase) {
      case "snapshot-balances":
        return this.snapshotBalancesPage(c);
      case "snapshot-holdings":
        return this.snapshotHoldingsPage(c);
      case "orders":
        return this.ordersPage(c);
      case "fills":
        return this.fillsPage(c);
      case "transactions":
        return this.transactionsPage(c);
      case "incremental":
        return this.incrementalPage(c);
      default:
        // An unknown phase (e.g. a downgraded cursor) falls through to
        // incremental so a future-written cursor can never wedge the source.
        return this.incrementalPage({ ...c, phase: "incremental" });
    }
  }

  // ── balances ──────────────────────────────────────────────────────

  private async snapshotBalancesPage(
    cursor: CoinbaseCursor,
  ): Promise<StructuredSyncResult<CoinbaseCursor>> {
    // Pin the day on the first page of the pass; hold it across every page.
    const snapshotDate = cursor.snapshotDate ?? utcDateOf(this.now());
    const page = await this.client.getAccountsPage({
      cursor: cursor.pageCursor,
      limit: ACCOUNTS_PAGE_SIZE,
    });
    const records = accountsToBalanceRecords(
      page.accounts,
      this.accountKey,
      this.sourceAccountId,
      snapshotDate,
    );

    const hasNext = Boolean(page.has_next) && Boolean(page.cursor);
    const next: CoinbaseCursor = hasNext
      ? { ...cursor, phase: "snapshot-balances", snapshotDate, pageCursor: page.cursor }
      : { ...cursor, phase: "snapshot-holdings", snapshotDate, pageCursor: undefined };

    return {
      analytics: { tableName: coinbaseBalancesTableSchema.tableName, records },
      cursor: next,
      hasMore: true,
    };
  }

  // ── holdings ──────────────────────────────────────────────────────

  private async snapshotHoldingsPage(
    cursor: CoinbaseCursor,
  ): Promise<StructuredSyncResult<CoinbaseCursor>> {
    const snapshotDate = cursor.snapshotDate ?? utcDateOf(this.now());

    // Resolve the portfolio list once at the start of the holdings phase.
    let portfolioUuids = cursor.portfolioUuids;
    if (!portfolioUuids) {
      const { portfolios } = await this.client.getPortfolios();
      portfolioUuids = portfolios.filter((p) => !p.deleted).map((p) => p.uuid);
    }

    const index = cursor.portfolioIndex ?? 0;
    if (index >= portfolioUuids.length) {
      // Holdings done — the snapshot for this UTC day is complete. Clear the
      // per-pass snapshot state, record the day, and chain into the append-only
      // activity walks (orders → fills → transactions → incremental).
      log.info(
        `Coinbase snapshot complete for ${snapshotDate} (${portfolioUuids.length} portfolio(s))`,
      );
      return {
        cursor: {
          ...cursor,
          phase: "orders",
          snapshotDate: undefined,
          portfolioIndex: undefined,
          portfolioUuids: undefined,
          pageCursor: undefined,
          lastSnapshotDate: snapshotDate,
        },
        hasMore: true,
      };
    }

    const uuid = portfolioUuids[index]!;
    const breakdown = await this.client.getPortfolioBreakdown(uuid);
    const positions = breakdown.breakdown.spot_positions ?? [];
    const records = positions.map((p) =>
      spotPositionToHoldingRecord(p, this.accountKey, this.sourceAccountId, snapshotDate),
    );

    return {
      analytics: { tableName: coinbaseHoldingsTableSchema.tableName, records },
      cursor: {
        ...cursor,
        phase: "snapshot-holdings",
        snapshotDate,
        portfolioUuids,
        portfolioIndex: index + 1,
      },
      hasMore: true,
    };
  }

  // ── orders (append-only) ──────────────────────────────────────────

  private async ordersPage(cursor: CoinbaseCursor): Promise<StructuredSyncResult<CoinbaseCursor>> {
    const page = await this.client.getOrdersPage({
      cursor: cursor.pageCursor,
      // Inclusive lower bound: re-seeing a boundary-timestamp order is harmless
      // (PK dedup) but skipping it would lose data.
      startDate: cursor.ordersWatermark,
    });
    const records = page.orders.map((o) => orderToRecord(o, this.accountKey, this.sourceAccountId));
    const sweepMax = maxIso(
      cursor.ordersSweepMax,
      maxTimeOf(page.orders, (o) => o.created_time),
    );

    const hasNext = Boolean(page.has_next) && Boolean(page.cursor);
    const next: CoinbaseCursor = hasNext
      ? { ...cursor, phase: "orders", pageCursor: page.cursor, ordersSweepMax: sweepMax }
      : {
          // Walk complete — promote the watermark now (not mid-walk), so an
          // interrupted walk re-covers from the old watermark.
          ...cursor,
          phase: "fills",
          pageCursor: undefined,
          ordersWatermark: maxIso(cursor.ordersWatermark, sweepMax),
          ordersSweepMax: undefined,
        };
    return {
      analytics: { tableName: coinbaseOrdersTableSchema.tableName, records },
      cursor: next,
      hasMore: true,
    };
  }

  // ── fills (append-only) ───────────────────────────────────────────

  private async fillsPage(cursor: CoinbaseCursor): Promise<StructuredSyncResult<CoinbaseCursor>> {
    const page = await this.client.getFillsPage({
      cursor: cursor.pageCursor,
      startTime: cursor.fillsWatermark,
    });
    const records = page.fills.map((f) => fillToRecord(f, this.accountKey, this.sourceAccountId));
    const sweepMax = maxIso(
      cursor.fillsSweepMax,
      maxTimeOf(page.fills, (f) => f.trade_time),
    );

    const hasNext = Boolean(page.has_next) && Boolean(page.cursor);
    const next: CoinbaseCursor = hasNext
      ? { ...cursor, phase: "fills", pageCursor: page.cursor, fillsSweepMax: sweepMax }
      : {
          ...cursor,
          phase: "transactions",
          pageCursor: undefined,
          fillsWatermark: maxIso(cursor.fillsWatermark, sweepMax),
          fillsSweepMax: undefined,
        };
    return {
      analytics: { tableName: coinbaseFillsTableSchema.tableName, records },
      cursor: next,
      hasMore: true,
    };
  }

  // ── v2 transaction ledger (append-only, graceful-degrade) ─────────

  private async transactionsPage(
    cursor: CoinbaseCursor,
  ): Promise<StructuredSyncResult<CoinbaseCursor>> {
    // The ledger phase is the one path that may lack a grant. Any
    // CoinbaseScopeError from a v2 read SKIPS the phase, leaving the source
    // healthy and the other phases' data intact.
    try {
      return await this.transactionsPageInner(cursor);
    } catch (err) {
      if (err instanceof CoinbaseScopeError) {
        log.info(
          "Coinbase transaction ledger skipped — the key lacks wallet:transactions:read (source stays healthy)",
        );
        return this.finishTransactions({ ...cursor, ledgerUnavailable: true });
      }
      throw err;
    }
  }

  private async transactionsPageInner(
    cursor: CoinbaseCursor,
  ): Promise<StructuredSyncResult<CoinbaseCursor>> {
    if (cursor.ledgerUnavailable) {
      // Grant confirmed absent earlier in this context — don't re-probe.
      return this.finishTransactions(cursor);
    }

    // Resolve the v2 wallet account list once at the start of the phase.
    let accountIds = cursor.ledgerAccountIds;
    if (!accountIds) {
      accountIds = await this.listLedgerAccountIds();
    }

    const index = cursor.ledgerAccountIndex ?? 0;
    if (index >= accountIds.length) {
      return this.finishTransactions({ ...cursor, ledgerAccountIds: undefined });
    }

    const walletId = accountIds[index]!;
    const watermark = cursor.ledgerWatermarks?.[walletId];
    const page = await this.client.getV2TransactionsPage(walletId, {
      startingAfter: cursor.pageCursor,
    });

    // The v2 ledger has no server-side time filter and returns newest-first.
    // Keep rows at/after the watermark; stop paging this wallet as soon as we
    // cross below it (older rows are already ingested). Inclusive at the
    // boundary so a same-timestamp row is re-seen (PK-deduped), never skipped.
    const records: Record<string, unknown>[] = [];
    const documents: DocumentInput[] = [];
    let crossedWatermark = false;
    let sweepMax = cursor.ledgerSweepMax;
    for (const txn of page.data) {
      const time = toIso(txn.created_at);
      if (watermark && time && time < watermark) {
        crossedWatermark = true;
        continue;
      }
      records.push(transactionToRecord(txn, walletId, this.accountKey, this.sourceAccountId));
      documents.push(
        transactionToDocument(txn, {
          providerId: this.providerId,
          sourceId: this.sourceId,
          accountKey: this.accountKey,
        }),
      );
      sweepMax = maxIso(sweepMax, time ?? undefined);
    }

    const pageCursor = page.pagination?.next_starting_after ?? undefined;
    const hasMorePages = Boolean(pageCursor) && !crossedWatermark;

    if (hasMorePages) {
      return {
        analytics: { tableName: coinbaseTransactionsTableSchema.tableName, records },
        documents,
        cursor: {
          ...cursor,
          phase: "transactions",
          ledgerAccountIds: accountIds,
          pageCursor,
          ledgerSweepMax: sweepMax,
        },
        hasMore: true,
      };
    }

    // Wallet done — promote its watermark and advance to the next wallet.
    const ledgerWatermarks = { ...(cursor.ledgerWatermarks ?? {}) };
    const promoted = maxIso(watermark, sweepMax);
    if (promoted) ledgerWatermarks[walletId] = promoted;
    return {
      analytics: { tableName: coinbaseTransactionsTableSchema.tableName, records },
      documents,
      cursor: {
        ...cursor,
        phase: "transactions",
        ledgerAccountIds: accountIds,
        ledgerAccountIndex: index + 1,
        pageCursor: undefined,
        ledgerSweepMax: undefined,
        ledgerWatermarks,
      },
      hasMore: true,
    };
  }

  /** Page the v2 accounts list fully into a flat id array (probes the grant). */
  private async listLedgerAccountIds(): Promise<string[]> {
    const ids: string[] = [];
    let startingAfter: string | undefined;
    let guard = 0;
    do {
      const page = await this.client.getV2AccountsPage({ startingAfter });
      for (const acc of page.data) {
        // A wallet with no recognizable currency is still a valid ledger target.
        void v2AccountCurrency(acc);
        ids.push(acc.id);
      }
      startingAfter = page.pagination?.next_starting_after ?? undefined;
    } while (startingAfter && ++guard < 100);
    return ids;
  }

  /** End the transactions phase, clearing per-pass ledger state, entering incremental idle. */
  private finishTransactions(cursor: CoinbaseCursor): StructuredSyncResult<CoinbaseCursor> {
    return {
      cursor: {
        ...cursor,
        phase: "incremental",
        ledgerAccountIds: undefined,
        ledgerAccountIndex: undefined,
        ledgerSweepMax: undefined,
        pageCursor: undefined,
      },
      hasMore: true,
    };
  }

  // ── incremental ───────────────────────────────────────────────────

  private async incrementalPage(
    cursor: CoinbaseCursor,
  ): Promise<StructuredSyncResult<CoinbaseCursor>> {
    const today = utcDateOf(this.now());
    if (cursor.lastSnapshotDate !== today) {
      // A new UTC day — re-run the whole pass: a fresh balances/holdings
      // snapshot (appends a new day's rows) followed by the append-only walks,
      // which the watermarks keep to only-new orders/fills/transactions.
      return this.snapshotBalancesPage({
        ...cursor,
        phase: "snapshot-balances",
        snapshotDate: today,
      });
    }
    // Already swept today — nothing to do until the day rolls over.
    return {
      cursor: { ...cursor, phase: "incremental" },
      hasMore: false,
    };
  }
}

/** Later of two optional ISO timestamps (undefined acts as "no bound"). */
function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/** Max normalized ISO time over a list, via the given timestamp accessor. */
function maxTimeOf<T>(
  items: T[],
  pick: (item: T) => string | null | undefined,
): string | undefined {
  let max: string | undefined;
  for (const item of items) {
    const iso = toIso(pick(item));
    if (iso) max = maxIso(max, iso);
  }
  return max;
}

/** UTC calendar date (YYYY-MM-DD) of a Date. */
export function utcDateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
