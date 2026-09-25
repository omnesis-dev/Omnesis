// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever, createLogger } from "@omnesis/core";
import {
  lunchflowAccountsSchema,
  lunchflowBalancesSchema,
  lunchflowTransactionsSchema,
} from "./schemas.js";
import {
  accountIdString,
  accountToRecord,
  balanceToRecord,
  processTransactionsPage,
  toAccountContext,
} from "./normalizer.js";
import { LunchflowAccountGoneError } from "./client.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";
import type { ProviderId, SourceId } from "@omnesis/types";
import type { LunchflowTransport } from "./client.js";
import type { LunchflowCursor, LunchflowCursorAccount } from "./types.js";

const log = createLogger("provider:lunchflow:accounts");

/** Incremental overlap: re-fetch the last 7 days so late-posted entries land. */
const INCREMENTAL_OVERLAP_DAYS = 7;

/** Connection statuses we don't bother fetching transactions/balances for. */
const INACTIVE_STATUSES: ReadonlySet<string> = new Set(["DISCONNECTED", "ERROR"]);

/** YYYY-MM-DD in UTC. */
export function utcDateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Day-aligned date arithmetic on YYYY-MM-DD strings. */
export function minusDays(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00.000Z`);
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

export interface LunchflowAccountsSourceOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  dataCutoff?: string;
}

type Result = StructuredSyncResult<LunchflowCursor>;

/**
 * Hybrid structured source for one Lunch Flow connection (one API key).
 * Fans out across every account the connection exposes — emitting
 * `lunchflow_accounts` / `lunchflow_balances` / `lunchflow_transactions`
 * rows plus a searchable document per transaction. See `LunchflowCursor` for
 * the phase machine; identity is the Lunch Flow account id throughout.
 */
export class LunchflowAccountsSource {
  private readonly now: () => Date;
  private readonly dataCutoff?: string;

  constructor(
    private readonly client: LunchflowTransport,
    private readonly providerId: ProviderId,
    private readonly sourceId: SourceId,
    /** Stamped on every row so a sibling connection's rows stay distinguishable. */
    private readonly accountId: string,
    opts: LunchflowAccountsSourceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.dataCutoff = opts.dataCutoff;
  }

  async syncStructured(cursor: LunchflowCursor | null): Promise<Result> {
    const phase = cursor?.phase ?? "accounts";
    switch (phase) {
      case "accounts":
        return this.accountsPage(cursor);
      case "transactions":
        return this.transactionsPage(cursor ?? { phase: "transactions" });
      case "balances":
        return this.balancesPage(cursor ?? { phase: "balances" });
      // See #720 — a future `holdings` phase (GET /accounts/{id}/holdings)
      // would snapshot brokerage positions for accounts that support them.
      default:
        return assertNever(phase);
    }
  }

  // ── Phase: accounts ───────────────────────────────────────────────

  private async accountsPage(cursor: LunchflowCursor | null): Promise<Result> {
    const accounts = await this.client.listAccounts();
    const syncedAt = this.now().toISOString();
    // Lunch Flow's /accounts carries no currency; stamp each row from the
    // currency learned on a prior cycle (transactions/balances phases), so an
    // account's currency lands the cycle after its money is first fetched.
    const currencies = cursor?.currencies ?? {};
    const records = accounts.map((a) =>
      accountToRecord(a, {
        syncedAt,
        currency: currencies[accountIdString(a)],
        sourceAccountId: this.accountId,
      }),
    );

    // Fan out only over connected accounts; a DISCONNECTED/ERROR account
    // still gets its row above (so the user sees its status) but no fetch.
    const syncable: LunchflowCursorAccount[] = accounts
      .filter((a) => !(a.status && INACTIVE_STATUSES.has(a.status)))
      .map(toAccountContext);

    if (syncable.length === 0) {
      return {
        analytics: { tableName: lunchflowAccountsSchema.tableName, records },
        cursor: {
          phase: "accounts",
          lastDates: cursor?.lastDates ?? {},
          lastBalancesDate: cursor?.lastBalancesDate,
          currencies,
        },
        hasMore: false,
      };
    }

    return {
      analytics: { tableName: lunchflowAccountsSchema.tableName, records },
      cursor: {
        phase: "transactions",
        accounts: syncable,
        accountIndex: 0,
        lastDates: cursor?.lastDates ?? {},
        lastBalancesDate: cursor?.lastBalancesDate,
        currencies,
      },
      hasMore: true,
    };
  }

  // ── Phase: transactions (per-account fanout) ──────────────────────

  private async transactionsPage(cursor: LunchflowCursor): Promise<Result> {
    const accounts = cursor.accounts ?? [];
    const accountIndex = cursor.accountIndex ?? 0;

    if (accountIndex >= accounts.length) {
      // Every account walked. Snapshot balances once per UTC day, else end.
      const balancesDue = utcDateOf(this.now()) !== cursor.lastBalancesDate;
      if (balancesDue) {
        return {
          cursor: {
            phase: "balances",
            accounts,
            accountIndex: 0,
            lastDates: cursor.lastDates ?? {},
            lastBalancesDate: cursor.lastBalancesDate,
            currencies: cursor.currencies ?? {},
          },
          hasMore: true,
        };
      }
      return {
        cursor: {
          phase: "accounts",
          lastDates: cursor.lastDates ?? {},
          lastBalancesDate: cursor.lastBalancesDate,
          currencies: cursor.currencies ?? {},
        },
        hasMore: false,
      };
    }

    const account = accounts[accountIndex];
    const lastDate = cursor.lastDates?.[account.id];
    // First backfill: bound by the configured data cutoff, else full history.
    const from = lastDate
      ? minusDays(lastDate, INCREMENTAL_OVERLAP_DAYS)
      : this.dataCutoff?.slice(0, 10);

    let transactions;
    try {
      transactions = await this.client.getTransactions(account.id, {
        from,
        includePending: false,
      });
    } catch (err) {
      if (err instanceof LunchflowAccountGoneError) {
        log.warn(`Lunch Flow account ${account.id} gone during transactions fetch — skipping`);
        return this.advanceTransactions(cursor, accounts, accountIndex, cursor.lastDates ?? {});
      }
      throw err;
    }

    const hashCounts: Record<string, number> = {};
    const processed = processTransactionsPage(transactions, {
      sourceAccountId: this.accountId,
      account,
      providerId: this.providerId,
      sourceId: this.sourceId,
      dataCutoff: this.dataCutoff,
      hashCounts,
    });
    for (const reason of processed.skipped) {
      log.error(`Skipping malformed Lunch Flow transaction for account ${account.id}: ${reason}`);
    }
    if (processed.pending > 0) {
      log.debug(
        `Skipped ${processed.pending}/${processed.total} pending transactions for account ${account.id}`,
      );
    }

    const lastDates = promoteWatermark(cursor.lastDates, account.id, processed.maxDate);
    // The account's currency is the currency of its money. Lunch Flow omits it
    // from /accounts, so learn it here for the next accounts page to stamp.
    const currencies = rememberCurrency(
      cursor.currencies,
      account.id,
      transactions.find((t) => t.currency)?.currency,
    );
    return {
      analytics: { tableName: lunchflowTransactionsSchema.tableName, records: processed.records },
      documents: processed.documents,
      cursor: {
        phase: "transactions",
        accounts,
        accountIndex: accountIndex + 1,
        lastDates,
        lastBalancesDate: cursor.lastBalancesDate,
        currencies,
      },
      hasMore: true,
    };
  }

  /** Advance past an account that produced no rows (skipped/gone). */
  private advanceTransactions(
    cursor: LunchflowCursor,
    accounts: LunchflowCursorAccount[],
    accountIndex: number,
    lastDates: Record<string, string>,
  ): Result {
    return {
      cursor: {
        phase: "transactions",
        accounts,
        accountIndex: accountIndex + 1,
        lastDates,
        lastBalancesDate: cursor.lastBalancesDate,
        currencies: cursor.currencies ?? {},
      },
      hasMore: true,
    };
  }

  // ── Phase: balances (once per UTC day, ends the tick) ─────────────

  private async balancesPage(cursor: LunchflowCursor): Promise<Result> {
    const accounts = cursor.accounts ?? [];
    const accountIndex = cursor.accountIndex ?? 0;
    const snapshotDate = utcDateOf(this.now());

    if (accountIndex >= accounts.length) {
      // All balances snapshotted — record the date and end the tick.
      return {
        cursor: {
          phase: "accounts",
          lastDates: cursor.lastDates ?? {},
          lastBalancesDate: snapshotDate,
          currencies: cursor.currencies ?? {},
        },
        hasMore: false,
      };
    }

    const account = accounts[accountIndex];
    let records: Record<string, unknown>[] = [];
    let balanceCurrency: string | null | undefined;
    try {
      const balance = await this.client.getBalance(account.id);
      balanceCurrency = balance.currency;
      const { record, skipped } = balanceToRecord(balance, {
        sourceAccountId: this.accountId,
        accountId: account.id,
        snapshotDate,
      });
      if (skipped) {
        log.error(`Skipping Lunch Flow balance for account ${account.id}: ${skipped}`);
      }
      if (record) records = [record];
    } catch (err) {
      if (err instanceof LunchflowAccountGoneError) {
        log.warn(`Lunch Flow account ${account.id} gone during balance fetch — skipping`);
      } else {
        throw err;
      }
    }

    return {
      analytics: { tableName: lunchflowBalancesSchema.tableName, records },
      cursor: {
        phase: "balances",
        accounts,
        accountIndex: accountIndex + 1,
        lastDates: cursor.lastDates ?? {},
        lastBalancesDate: cursor.lastBalancesDate,
        // The balance is the authoritative currency source — refine the map.
        currencies: rememberCurrency(cursor.currencies, account.id, balanceCurrency),
      },
      hasMore: true,
    };
  }
}

/** Record an account's currency in the carried map, skipping absent values. */
function rememberCurrency(
  currencies: Record<string, string> | undefined,
  accountId: string,
  currency: string | null | undefined,
): Record<string, string> {
  if (!currency) return currencies ?? {};
  return { ...(currencies ?? {}), [accountId]: currency };
}

function promoteWatermark(
  lastDates: Record<string, string> | undefined,
  accountId: string,
  windowMax: string | undefined,
): Record<string, string> {
  const next = { ...(lastDates ?? {}) };
  const existing = next[accountId];
  const promoted = maxDate(existing, windowMax);
  if (promoted) next[accountId] = promoted;
  return next;
}

function maxDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}
