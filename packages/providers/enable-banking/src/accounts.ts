// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { bankAccountsSchema, bankBalancesSchema, bankTransactionsSchema } from "./schemas.js";
import {
  BOOKED_STATUS,
  accountToRecord,
  balancesToRecords,
  processTransactionsPage,
} from "./normalizer.js";
import {
  bootstrapAccountDir,
  completedBootstrapMarker,
  invalidateBootstrapCache,
  loadSession,
  migrateBootstrapCaches,
  readBootstrapPage,
  removeBootstrapCaches,
  type BootstrapMarker,
} from "./session.js";
import type { HistoryCoverage, StructuredSyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { EnableBankingTransport } from "./client.js";
import type { EnableBankingCursor, StoredSession, StoredSessionAccount } from "./types.js";

const log = createLogger("provider:enable-banking:accounts");

/** Incremental overlap: re-fetch the last 7 days so late-booked entries land. */
const INCREMENTAL_OVERLAP_DAYS = 7;

/** Network fallback window when the auth-time full-history cache is absent. */
const FALLBACK_WINDOW_DAYS = 90;

/**
 * Enable Banking captures full transaction history only in the few minutes
 * after SCA (`prefetchFullHistory`, provider.ts). ASPSPs are not required to
 * hand over an account's complete lifetime even in that window, and nothing
 * in the response says whether they did — so a bootstrap drained from that
 * cache can never be vouched for as `"complete"`, only reported `"unknown"`.
 */
const FULL_HISTORY_COVERAGE_DETAIL =
  "Banks decide how much past history they share, and do not say whether it is all of it. Older transactions the bank did not share are not here.";

/**
 * Coverage claim for a page fetched with an explicit `dateFrom` lower bound —
 * the 90-day fallback window used when the full-history cache is absent,
 * or belongs to a superseded consent, or when an account has no
 * watermark yet. Unlike the cache-drain path, this source knows exactly what
 * it left out: everything before `dateFrom`.
 */
function fallbackWindowCoverage(accountKey: string): {
  coverage: HistoryCoverage;
  detail: string;
  coverageSubject: string;
} {
  return {
    coverage: "partial",
    // What is missing, not what is held. Naming the date a page happened to
    // start from described an account holding three months as holding a week
    // and re-dated itself every tick; naming a span from now is the same error
    // reversed, since an account connected a year ago has since accumulated a
    // year. Only the gap below the connection is fixed, so that is what it
    // says.
    detail: `Account …${accountKey.slice(-6)}: the full-history capture was unavailable when it was connected, so nothing from before roughly ${FALLBACK_WINDOW_DAYS} days prior to that is here. Re-connecting the bank fetches the rest.`,
    // One connection speaks for several accounts, and they can disagree.
    coverageSubject: accountKey,
  };
}

/** YYYY-MM-DD in UTC. */
export function utcDateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Day-aligned date arithmetic on YYYY-MM-DD strings. */
export function minusDays(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00.000Z`);
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

export interface EnableBankingAccountsSourceOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Config dir override (tests). */
  configDir?: string;
  dataCutoff?: string;
}

type Result = StructuredSyncResult<EnableBankingCursor>;

/**
 * Hybrid structured source for one connected bank (one Enable Banking
 * session). Emits `bank_accounts` / `bank_balances` / `bank_transactions`
 * rows plus a searchable document per transaction. See the cursor type for
 * the phase machine; identity is `account_key` throughout, with the
 * session-scoped `uid` looked up fresh from `session.json` on every page.
 */
export class EnableBankingAccountsSource {
  private readonly now: () => Date;
  private readonly configDir?: string;
  private readonly dataCutoff?: string;
  private migratedConsent?: string;

  constructor(
    private readonly client: EnableBankingTransport,
    private readonly providerId: ProviderId,
    private readonly sourceId: SourceId,
    private readonly accountId: string,
    opts: EnableBankingAccountsSourceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.configDir = opts.configDir;
    this.dataCutoff = opts.dataCutoff;
  }

  async syncStructured(cursor: EnableBankingCursor | null): Promise<Result> {
    const session = loadSession(this.accountId, this.configDir);
    if (!session) {
      throw new SyncError(
        "auth",
        `No Enable Banking session for ${this.accountId} — re-run the auth flow to re-consent.`,
      );
    }

    if (this.migratedConsent !== session.session_id) {
      migrateBootstrapCaches(this.accountId, this.configDir);
      this.migratedConsent = session.session_id;
    }

    const phase = cursor?.phase ?? "accounts";
    switch (phase) {
      case "accounts":
        return this.accountsPage(session, cursor);
      case "bootstrap":
        return this.bootstrapPage(session, cursor ?? { phase: "bootstrap" });
      case "balances":
        return this.initialBalancesPage(session, cursor ?? { phase: "balances" });
      case "incremental":
        return this.incrementalPage(session, cursor ?? { phase: "incremental" });
    }
  }

  // ── Phase: accounts ───────────────────────────────────────────────

  private accountsPage(session: StoredSession, cursor: EnableBankingCursor | null): Result {
    return {
      analytics: { tableName: bankAccountsSchema.tableName, records: this.accountRecords(session) },
      cursor: {
        phase: "bootstrap",
        accountIndex: 0,
        lastBookingDates: cursor?.lastBookingDates ?? {},
        bootstrapReach: cursor?.bootstrapReach,
      },
      hasMore: true,
    };
  }

  private accountRecords(session: StoredSession): Record<string, unknown>[] {
    const syncedAt = this.now().toISOString();
    return session.accounts.map((account) =>
      accountToRecord(account, {
        sourceAccountId: this.accountId,
        bankName: session.aspsp.name,
        country: session.aspsp.country,
        syncedAt,
      }),
    );
  }

  // ── Phase: bootstrap ──────────────────────────────────────────────

  private async bootstrapPage(
    session: StoredSession,
    cursor: EnableBankingCursor,
  ): Promise<Result> {
    const accountIndex = cursor.accountIndex ?? 0;
    if (accountIndex >= session.accounts.length) {
      return {
        cursor: {
          phase: "balances",
          lastBookingDates: cursor.lastBookingDates ?? {},
          bootstrapReach: cursor.bootstrapReach,
        },
        hasMore: true,
      };
    }

    const account = session.accounts[accountIndex];
    const cacheDir = bootstrapAccountDir(this.accountId, account.account_key, this.configDir);
    const marker = completedBootstrapMarker(cacheDir, this.configDir);

    // Which way this account is walked is what its coverage claim rests on
    // later; the watermark cannot carry it, because an account with nothing in
    // the window has no watermark either way.
    const reached = (reach: "full" | "window"): EnableBankingCursor => ({
      ...cursor,
      bootstrapReach: { ...(cursor.bootstrapReach ?? {}), [account.account_key]: reach },
    });

    if (marker !== null) {
      return this.bootstrapFromCache(session, reached("full"), account, cacheDir, marker);
    }
    return this.bootstrapFromNetwork(session, reached("window"));
  }

  /** Drain the raw pages the auth flow prefetched (full history, offline). */
  private async bootstrapFromCache(
    session: StoredSession,
    cursor: EnableBankingCursor,
    account: StoredSessionAccount,
    cacheDir: string,
    marker: BootstrapMarker,
  ): Promise<Result> {
    // Stale cache: the marker belongs to a consent other than the current
    // one (e.g. a re-consent whose prefetch died before reaching this
    // account). Invalidate and fall back to the network window with clean
    // window state. Unreadable caches instead remain intact for recovery.
    if (marker.sessionId !== session.session_id) {
      log.warn(
        `Bootstrap cache for ${this.accountId} account …${account.account_key.slice(-6)} belongs to a previous consent; falling back to ${FALLBACK_WINDOW_DAYS}d network fetch`,
      );
      invalidateBootstrapCache(cacheDir);
      return this.bootstrapFromNetwork(session, {
        ...cursor,
        cachePageIndex: undefined,
        continuationKey: undefined,
        windowMaxBookingDate: undefined,
        windowHashCounts: undefined,
      });
    }

    // Stale cursor: it records the consent epoch it started draining, and a
    // re-consent mid-drain wiped and renumbered the cache (and may have
    // reordered session.accounts) underneath it. Restart the bootstrap walk
    // from the first account — idempotent thanks to the
    // [account_key, transaction_key] PK upserts. At most one restart: every
    // epoch the cursor can adopt equals the current session_id (the branch
    // above filters any other cache), so a restarted walk never mismatches.
    if (cursor.bootstrapSessionId !== undefined && cursor.bootstrapSessionId !== marker.sessionId) {
      log.warn(
        `Bootstrap cache for ${this.accountId} was rewritten by a newer consent mid-drain; restarting the bootstrap walk from the first account`,
      );
      return this.bootstrapPage(session, {
        phase: "bootstrap",
        accountIndex: 0,
        lastBookingDates: cursor.lastBookingDates ?? {},
        bootstrapReach: cursor.bootstrapReach,
      });
    }

    const accountIndex = cursor.accountIndex ?? 0;
    const pageIndex = cursor.cachePageIndex ?? 0;
    const totalPages = marker.pages;

    if (pageIndex >= totalPages) {
      // Empty cache (account had no history) — account done.
      return this.advanceBootstrapAccount(
        session,
        { ...cursor, bootstrapSessionId: marker.sessionId },
        account,
        [],
        [],
        {
          coverage: "unknown",
          detail: FULL_HISTORY_COVERAGE_DETAIL,
          coverageSubject: account.account_key,
        },
      );
    }

    const page = readBootstrapPage(cacheDir, pageIndex, this.configDir);
    const processed = this.processPage(session, account, cursor, page.transactions);

    const isLastPage = pageIndex + 1 >= totalPages;
    if (isLastPage) {
      return this.advanceBootstrapAccount(
        session,
        {
          ...cursor,
          windowMaxBookingDate: processed.windowMaxBookingDate,
          bootstrapSessionId: marker.sessionId,
        },
        account,
        processed.records,
        processed.documents,
        {
          coverage: "unknown",
          detail: FULL_HISTORY_COVERAGE_DETAIL,
          coverageSubject: account.account_key,
        },
      );
    }
    return {
      analytics: { tableName: bankTransactionsSchema.tableName, records: processed.records },
      documents: processed.documents,
      progress: {
        phase: "bootstrap",
        processed: processed.records.length,
        coverage: "unknown",
        detail: FULL_HISTORY_COVERAGE_DETAIL,
        coverageSubject: account.account_key,
      },
      cursor: {
        phase: "bootstrap",
        accountIndex,
        cachePageIndex: pageIndex + 1,
        bootstrapSessionId: marker.sessionId,
        windowMaxBookingDate: processed.windowMaxBookingDate,
        windowHashCounts: processed.windowHashCounts,
        lastBookingDates: cursor.lastBookingDates ?? {},
        bootstrapReach: cursor.bootstrapReach,
      },
      hasMore: true,
    };
  }

  /** No usable cache — fetch the last 90 days from the network. */
  private async bootstrapFromNetwork(
    session: StoredSession,
    cursor: EnableBankingCursor,
  ): Promise<Result> {
    const accountIndex = cursor.accountIndex ?? 0;
    const account = session.accounts[accountIndex];
    const dateFrom = minusDays(utcDateOf(this.now()), FALLBACK_WINDOW_DAYS);

    let page;
    try {
      page = await this.client.getTransactions(account.uid, {
        dateFrom,
        transactionStatus: BOOKED_STATUS,
        continuationKey: cursor.continuationKey,
      });
    } catch (err) {
      if (isStaleContinuationFailure(err, cursor.continuationKey)) {
        return this.restartWindowAfterStaleContinuation(
          account,
          dateFrom,
          {
            phase: "bootstrap",
            accountIndex,
            bootstrapSessionId: cursor.bootstrapSessionId,
            lastBookingDates: cursor.lastBookingDates ?? {},
            bootstrapReach: cursor.bootstrapReach,
          },
          err,
        );
      }
      throw err;
    }
    const processed = this.processPage(session, account, cursor, page.transactions);

    if (page.continuation_key) {
      return {
        analytics: { tableName: bankTransactionsSchema.tableName, records: processed.records },
        documents: processed.documents,
        progress: {
          phase: "bootstrap",
          processed: processed.records.length,
          ...fallbackWindowCoverage(account.account_key),
        },
        cursor: {
          phase: "bootstrap",
          accountIndex,
          continuationKey: page.continuation_key,
          bootstrapSessionId: cursor.bootstrapSessionId,
          windowMaxBookingDate: processed.windowMaxBookingDate,
          windowHashCounts: processed.windowHashCounts,
          lastBookingDates: cursor.lastBookingDates ?? {},
          bootstrapReach: cursor.bootstrapReach,
        },
        hasMore: true,
      };
    }
    return this.advanceBootstrapAccount(
      session,
      { ...cursor, windowMaxBookingDate: processed.windowMaxBookingDate },
      account,
      processed.records,
      processed.documents,
      fallbackWindowCoverage(account.account_key),
    );
  }

  /** Current account's window is complete: promote the watermark, move on. */
  private advanceBootstrapAccount(
    session: StoredSession,
    cursor: EnableBankingCursor,
    account: StoredSessionAccount,
    records: Record<string, unknown>[],
    documents: DocumentInput[],
    coverage: { coverage: HistoryCoverage; detail: string; coverageSubject?: string },
  ): Result {
    const accountIndex = cursor.accountIndex ?? 0;
    const lastBookingDates = promoteWatermark(
      cursor.lastBookingDates,
      account.account_key,
      cursor.windowMaxBookingDate,
    );
    const moreAccounts = accountIndex + 1 < session.accounts.length;
    return {
      analytics: { tableName: bankTransactionsSchema.tableName, records },
      documents,
      progress: {
        phase: moreAccounts ? "bootstrap" : "balances",
        processed: records.length,
        ...coverage,
      },
      cursor: {
        phase: moreAccounts ? "bootstrap" : "balances",
        accountIndex: moreAccounts ? accountIndex + 1 : undefined,
        bootstrapSessionId: moreAccounts ? cursor.bootstrapSessionId : undefined,
        lastBookingDates,
        // Every account's walk ends here, so this is where the record of how
        // far each one reached would be lost — and it was, silently, because
        // every cursor field is optional and a typecheck cannot see a missing
        // one. See `baseIncrementalCursor` below for the same hazard.
        bootstrapReach: cursor.bootstrapReach,
      },
      hasMore: true,
    };
  }

  // ── Phase: balances (initial snapshot, ends the bootstrap tick) ──

  private async initialBalancesPage(
    session: StoredSession,
    cursor: EnableBankingCursor,
  ): Promise<Result> {
    // Reaching this phase means every bootstrap page (cached or network) has
    // been ingested and its cursor persisted — the prefetched raw history is
    // now redundant on disk, so it goes.
    removeBootstrapCaches(this.accountId, this.configDir);
    const { records, snapshotDate } = await this.fetchAllBalances(session);
    return {
      analytics: { tableName: bankBalancesSchema.tableName, records },
      cursor: {
        phase: "incremental",
        lastBookingDates: cursor.lastBookingDates ?? {},
        bootstrapReach: cursor.bootstrapReach,
        lastBalancesDate: snapshotDate,
      },
      hasMore: false,
    };
  }

  // ── Phase: incremental ────────────────────────────────────────────

  private async incrementalPage(
    session: StoredSession,
    cursor: EnableBankingCursor,
  ): Promise<Result> {
    let stage = cursor.incStage;
    if (!stage) {
      // Tick start: refresh accounts + balances on the first tick of each
      // UTC day (3 calls/account/day nominal — headroom under the 4/day
      // ASPSP cap); otherwise go straight to transactions.
      const balancesDue = utcDateOf(this.now()) !== cursor.lastBalancesDate;
      stage = balancesDue ? "accounts-refresh" : "transactions";
    }

    if (stage === "accounts-refresh") {
      // No API call — re-emits session accounts so the transient uid column
      // (and any renamed accounts) stay fresh after a re-consent.
      return {
        analytics: {
          tableName: bankAccountsSchema.tableName,
          records: this.accountRecords(session),
        },
        cursor: { ...baseIncrementalCursor(cursor), incStage: "balances" },
        hasMore: true,
      };
    }

    if (stage === "balances") {
      const { records, snapshotDate } = await this.fetchAllBalances(session);
      return {
        analytics: { tableName: bankBalancesSchema.tableName, records },
        cursor: {
          ...baseIncrementalCursor(cursor),
          lastBalancesDate: snapshotDate,
          incStage: "transactions",
          incrementalAccountIndex: 0,
        },
        hasMore: true,
      };
    }

    return this.incrementalTransactionsPage(session, cursor);
  }

  private async incrementalTransactionsPage(
    session: StoredSession,
    cursor: EnableBankingCursor,
  ): Promise<Result> {
    const accountIndex = cursor.incrementalAccountIndex ?? 0;
    if (accountIndex >= session.accounts.length) {
      return {
        cursor: baseIncrementalCursor(cursor),
        hasMore: false,
      };
    }

    const account = session.accounts[accountIndex];
    const lastBookingDate = cursor.lastBookingDates?.[account.account_key];
    // Accounts first seen after bootstrap (e.g. added on re-consent) have no
    // watermark — use the 90-day fallback window rather than full history.
    const dateFrom = lastBookingDate
      ? minusDays(lastBookingDate, INCREMENTAL_OVERLAP_DAYS)
      : minusDays(utcDateOf(this.now()), FALLBACK_WINDOW_DAYS);
    // Three cases, and the watermark alone separates only two of them.
    //
    // An account walked from the prefetch cache holds its full history and has
    // nothing to report — even if that history is empty, which is precisely
    // the account the watermark cannot speak for: it never acquires one, and
    // reading its absence as the 90-day fallback tells the operator their
    // bank's full-history capture failed when it succeeded, permanently,
    // because nothing later would revise it.
    //
    // An account walked from the network took the fallback and is missing
    // everything before its window. An account this cursor has never walked at
    // all — one that appeared in the session after bootstrap ran — is on the
    // fallback too, and is the case the recorded reach cannot answer, so the
    // watermark still decides it.
    const reach = cursor.bootstrapReach?.[account.account_key];
    const coverage =
      reach === "full"
        ? undefined
        : reach === "window" || !lastBookingDate
          ? fallbackWindowCoverage(account.account_key)
          : undefined;

    let page;
    try {
      page = await this.client.getTransactions(account.uid, {
        dateFrom,
        transactionStatus: BOOKED_STATUS,
        continuationKey: cursor.continuationKey,
      });
    } catch (err) {
      if (isStaleContinuationFailure(err, cursor.continuationKey)) {
        return this.restartWindowAfterStaleContinuation(
          account,
          dateFrom,
          {
            ...baseIncrementalCursor(cursor),
            incStage: "transactions",
            incrementalAccountIndex: accountIndex,
          },
          err,
        );
      }
      throw err;
    }
    const processed = this.processPage(session, account, cursor, page.transactions);

    if (page.continuation_key) {
      return {
        analytics: { tableName: bankTransactionsSchema.tableName, records: processed.records },
        documents: processed.documents,
        progress: coverage
          ? { phase: "incremental", processed: processed.records.length, ...coverage }
          : undefined,
        cursor: {
          ...baseIncrementalCursor(cursor),
          incStage: "transactions",
          incrementalAccountIndex: accountIndex,
          continuationKey: page.continuation_key,
          windowMaxBookingDate: processed.windowMaxBookingDate,
          windowHashCounts: processed.windowHashCounts,
        },
        hasMore: true,
      };
    }

    // Window complete for this account — promote the watermark.
    const lastBookingDates = promoteWatermark(
      cursor.lastBookingDates,
      account.account_key,
      processed.windowMaxBookingDate,
    );
    const moreAccounts = accountIndex + 1 < session.accounts.length;
    return {
      analytics: { tableName: bankTransactionsSchema.tableName, records: processed.records },
      documents: processed.documents,
      progress: coverage
        ? { phase: "incremental", processed: processed.records.length, ...coverage }
        : undefined,
      cursor: moreAccounts
        ? {
            ...baseIncrementalCursor(cursor),
            lastBookingDates,
            incStage: "transactions",
            incrementalAccountIndex: accountIndex + 1,
          }
        : { ...baseIncrementalCursor(cursor), lastBookingDates },
      hasMore: moreAccounts,
    };
  }

  // ── Shared helpers ────────────────────────────────────────────────

  /**
   * A transactions request carrying a continuation key was rejected with a
   * non-auth, non-rate-limit 4xx — the key is dead (expired query handle,
   * or minted against a replaced session). Retrying it would wedge the
   * source forever; instead drop the key and all window state so the next
   * page restarts the current window from its date_from. The
   * [account_key, transaction_key] PK upserts make the re-fetch idempotent.
   */
  private restartWindowAfterStaleContinuation(
    account: StoredSessionAccount,
    dateFrom: string,
    restartCursor: EnableBankingCursor,
    err: unknown,
  ): Result {
    log.warn(
      `Continuation key for ${this.accountId} account …${account.account_key.slice(-6)} was rejected (${(err as Error).message}); restarting the window from ${dateFrom}`,
    );
    return {
      cursor: restartCursor,
      hasMore: true,
    };
  }

  private async fetchAllBalances(
    session: StoredSession,
  ): Promise<{ records: Record<string, unknown>[]; snapshotDate: string }> {
    // snapshot_date is ALWAYS the UTC date of the fetch — "latest
    // observation that day". Two same-day fetches upsert the same PK; a
    // midnight-crossing retry leaves one benign extra row.
    const snapshotDate = utcDateOf(this.now());
    const records: Record<string, unknown>[] = [];
    for (const account of session.accounts) {
      const balances = await this.client.getBalances(account.uid);
      const result = balancesToRecords(balances, {
        accountKey: account.account_key,
        sourceAccountId: this.accountId,
        snapshotDate,
      });
      for (const reason of result.skipped) {
        log.error(`Skipping balance entry for ${this.accountId}: ${reason}`);
      }
      records.push(...result.records);
    }
    return { records, snapshotDate };
  }

  private processPage(
    session: StoredSession,
    account: StoredSessionAccount,
    cursor: EnableBankingCursor,
    transactions: Parameters<typeof processTransactionsPage>[0],
  ): {
    records: Record<string, unknown>[];
    documents: DocumentInput[];
    windowMaxBookingDate?: string;
    windowHashCounts: Record<string, number>;
  } {
    const hashCounts = { ...(cursor.windowHashCounts ?? {}) };
    const processed = processTransactionsPage(transactions, {
      account,
      sourceAccountId: this.accountId,
      bankName: session.aspsp.name,
      providerId: this.providerId,
      sourceId: this.sourceId,
      dataCutoff: this.dataCutoff,
      hashCounts,
    });
    for (const reason of processed.skipped) {
      log.error(`Skipping malformed record for ${this.accountId}: ${reason}`);
    }
    if (processed.nonBooked > 0) {
      log.debug(
        `Skipped ${processed.nonBooked}/${processed.total} non-booked transactions for ${this.accountId} (response-path booked-only filter)`,
      );
    }
    log.debug(
      `entry_reference present on ${processed.entryRefPresent}/${processed.total} transactions for ${this.accountId}`,
    );
    const windowMax = maxDate(cursor.windowMaxBookingDate, processed.maxBookingDate);
    return {
      records: processed.records,
      documents: processed.documents,
      windowMaxBookingDate: windowMax,
      windowHashCounts: hashCounts,
    };
  }
}

/**
 * Whether a transactions fetch failed because its continuation key is dead.
 * The client maps non-auth, non-rate-limit 4xx statuses to
 * `SyncError("unknown")`; when the request carried a continuation key, that
 * kind means the key itself was rejected (auth and rate-limit failures keep
 * their own routing, and 5xx/network errors stay retryable as-is).
 */
function isStaleContinuationFailure(err: unknown, continuationKey: string | undefined): boolean {
  return continuationKey !== undefined && err instanceof SyncError && err.kind === "unknown";
}

/** Incremental cursor with all transient in-tick/window state cleared. */
/**
 * The cursor an incremental stage hands to the next one.
 *
 * Built field by field rather than spread, so anything not named here is
 * dropped at the first stage transition — which is silent, and survives a
 * typecheck, because every field is optional.
 */
function baseIncrementalCursor(cursor: EnableBankingCursor): EnableBankingCursor {
  return {
    phase: "incremental",
    lastBookingDates: cursor.lastBookingDates ?? {},
    lastBalancesDate: cursor.lastBalancesDate,
    bootstrapReach: cursor.bootstrapReach,
  };
}

function promoteWatermark(
  lastBookingDates: Record<string, string> | undefined,
  accountKey: string,
  windowMax: string | undefined,
): Record<string, string> {
  const next = { ...(lastBookingDates ?? {}) };
  const existing = next[accountKey];
  const promoted = maxDate(existing, windowMax);
  if (promoted) next[accountKey] = promoted;
  return next;
}

function maxDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}
