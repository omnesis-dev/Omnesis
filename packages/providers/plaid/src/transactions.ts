// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Structured transactions sync for one connected Plaid item (one institution).
 *
 * `/transactions/sync` is a delta cursor: the SAME endpoint serves the initial
 * history (call with no cursor; its depth is the `days_requested` the item was
 * created with) and every later incremental delta (call with the stored
 * cursor), returning `{ added, modified, removed, next_cursor, has_more }`. So
 * this is a single self-paginating `transactions` phase. Each call fetches one
 * page:
 *
 *  - `added` + `modified` → upsert into `plaid_transactions` by the composite
 *    primary key `(item_id, transaction_id)`. `modified` rows
 *    overwrite the prior version; an at-least-once retry re-upserts the same
 *    rows harmlessly.
 *  - `removed` → tombstone by `transaction_id`. When a pending transaction
 *    posts, Plaid mints a NEW id, emits the posted row in added/modified, and
 *    lists the OLD pending id in `removed` — so this one rule handles the
 *    pending→posted transition with no orphan and no duplicate.
 *  - the page's `next_cursor` is written to the cursor ONLY after the page is
 *    returned for durable ingest, so a crash before that re-fetches the same
 *    page and the composite-PK upserts absorb the replay.
 *
 * Two shapes of the API need explicit handling. Plaid pulls an item's history
 * asynchronously, so early pages can report `has_more: false` while
 * `transactions_update_status` is still short of `HISTORICAL_UPDATE_COMPLETE` —
 * "nothing more right now", not "the history is complete". And a page can be
 * invalidated by data changing underneath the run
 * (`TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`), whose documented remedy is
 * to restart from the cursor the run BEGAN with, which is carried on the cursor
 * as `loopStartCursor`.
 */

import { createLogger } from "@omnesis/core";
import { PLAID_SYNC_MUTATION_CODE, PlaidApiError } from "./client.js";
import { processTransactions } from "./normalizer.js";
import {
  PLAID_HISTORICAL_UPDATE_COMPLETE,
  parseTransactionRows,
  plaidTransactionsSchema,
} from "./schemas.js";
import type { StructuredSyncResult, SyncOptions } from "@omnesis/source-sdk";
import type { ProviderId, SourceId } from "@omnesis/types";
import type { PlaidTransport, TransactionsSyncParams } from "./client.js";
import type { PlaidCursor } from "./types.js";

const log = createLogger("provider:plaid:transactions");

/**
 * `days_requested` at Link time is a request, not a guarantee: an institution
 * can hand Plaid less than asked for, and Plaid has no signal distinguishing
 * "the account has no older transactions" from "the bank withheld them". So
 * this source can never claim it holds an item's complete transaction
 * lifetime — only as much as Plaid was able to serve.
 */
const HISTORY_COVERAGE_DETAIL =
  "Banks decide how much past history they share, which can be less than was asked for. Older transactions the bank did not share are not here.";

/** Phases that still have work to do in the current run. */
const SNAPSHOT_PHASES: ReadonlySet<PlaidCursor["phase"]> = new Set([
  "snapshot-balances",
  "snapshot-holdings",
]);

/**
 * How long the source keeps asking for the rest of an item's history while
 * Plaid is still assembling it. The clock starts on the first page that finds
 * the history unfinished and is cleared by any page that carries progress, so
 * it bounds an unproductive wait rather than the sync as a whole.
 */
export const PLAID_BACKFILL_WAIT_MS = 10 * 60 * 1000;

/** How long a page that carries no progress holds before asking Plaid again. */
const PLAID_WAIT_PACE_MS = 20_000;

/** Restarts one sync will absorb before leaving a churning item to the next. */
export const PLAID_MAX_PAGINATION_RESTARTS = 5;

export interface PlaidTransactionsSourceOptions {
  /** ISO 8601 — transactions before this are skipped (history-import bound). */
  dataCutoff?: string;
  /** Institution display name, for the co-emitted document's account label. */
  institutionName?: string;
  /** Injectable clock, so the backfill wait is deterministic in tests. */
  now?: () => Date;
  /** Injectable delay, so tests do not wait out the real pacing. */
  sleep?: (ms: number) => Promise<void>;
}

type Result = StructuredSyncResult<PlaidCursor>;

export class PlaidTransactionsSource {
  private readonly dataCutoff?: string;
  private readonly institutionName?: string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: PlaidTransport,
    private readonly providerId: ProviderId,
    private readonly sourceId: SourceId,
    /** The connected item id — the Omnesis accountId. */
    private readonly itemId: string,
    /** Per-item access token (secret — never logged). */
    private readonly accessToken: string,
    opts: PlaidTransactionsSourceOptions = {},
  ) {
    this.dataCutoff = opts.dataCutoff;
    this.institutionName = opts.institutionName;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Hold before a page that carries no progress, so a wait cannot spin. The
   * hold ends the moment the sync is abandoned — an unabortable timer would
   * keep the collector alive for its whole duration after a shutdown.
   */
  private async pace(opts?: SyncOptions): Promise<void> {
    const signal = opts?.signal;
    if (signal?.aborted) return;
    if (!signal) {
      await this.sleep(PLAID_WAIT_PACE_MS);
      return;
    }
    await Promise.race([
      this.sleep(PLAID_WAIT_PACE_MS),
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
  }

  async syncStructured(cursor: PlaidCursor | null, opts?: SyncOptions): Promise<Result> {
    return this.transactionsPage(cursor, "transactions", opts);
  }

  /**
   * Fetch one `/transactions/sync` delta page. Public so the phase orchestrator
   * can drive it as one leg of the phase machine. `next` is the phase the
   * cursor advances to once the delta is exhausted and Plaid's history pull is
   * complete.
   */
  async transactionsPage(
    cursor: PlaidCursor | null,
    next: PlaidCursor["phase"] = "transactions",
    opts?: SyncOptions,
  ): Promise<Result> {
    const params: TransactionsSyncParams = { accessToken: this.accessToken };
    if (cursor?.transactionsCursor) params.cursor = cursor.transactionsCursor;

    let page;
    try {
      page = await this.client.transactionsSync(params, { signal: opts?.signal });
    } catch (err) {
      if (isPaginationMutation(err)) {
        // The run's pages no longer agree with each other. Plaid's remedy is to
        // restart from the cursor this run began with — retrying the failing
        // page would hit the same mutation. The composite-PK upserts make the
        // replay idempotent.
        log.warn(
          `Plaid item ${this.itemId} changed mid-pagination; restarting the run from its ` +
            `starting cursor`,
        );
        // On the first page of a run there is no separate starting cursor —
        // the cursor in hand IS where the run began, and dropping it would
        // replay the item's whole history.
        const restartFrom = cursor?.loopStartCursor ?? cursor?.transactionsCursor;
        const restarts = (cursor?.paginationRestarts ?? 0) + 1;
        // An item whose data keeps moving under the run would otherwise restart
        // for the whole sync window. Give the rest to the next scheduled run.
        const giveUp = restarts >= PLAID_MAX_PAGINATION_RESTARTS;
        if (giveUp) {
          log.info(
            `Plaid item ${this.itemId} kept changing mid-pagination; leaving the rest to the ` +
              `next sync`,
          );
        } else {
          await this.pace(opts);
        }
        return {
          analytics: {
            tableName: plaidTransactionsSchema.tableName,
            records: [],
            schema: plaidTransactionsSchema,
          },
          progress: {
            phase: giveUp ? next : "transactions",
            processed: 0,
            coverage: "unknown",
            detail: HISTORY_COVERAGE_DETAIL,
          },
          cursor: {
            phase: giveUp ? next : "transactions",
            transactionsCursor: restartFrom,
            loopStartCursor: giveUp ? undefined : restartFrom,
            lastSnapshotDate: cursor?.lastSnapshotDate,
            paginationRestarts: giveUp ? undefined : restarts,
          },
          hasMore: !giveUp || SNAPSHOT_PHASES.has(next),
        };
      }
      throw err;
    }

    const parsed = parseTransactionRows([...page.added, ...page.modified]);
    if (parsed.malformed > 0) {
      // One unreadable row must not block the page behind it, nor the cursor.
      log.warn(
        `Plaid item ${this.itemId}: skipped ${parsed.malformed} transaction(s) Plaid served in an ` +
          `unexpected shape`,
      );
    }
    const { records, documents } = processTransactions(parsed.transactions, {
      itemId: this.itemId,
      providerId: this.providerId,
      sourceId: this.sourceId,
      institutionName: this.institutionName,
      dataCutoff: this.dataCutoff,
    });

    const droppedByCutoff = parsed.transactions.length - records.length;
    if (droppedByCutoff > 0) {
      log.debug(
        `Plaid item ${this.itemId}: ${droppedByCutoff} transaction(s) predate the history cutoff`,
      );
    }

    // `removed` carries posted-pending tombstones and genuine deletions alike;
    // both are addressed by transaction_id, which Plaid keys per item. The
    // gateway scopes a page's deletes by the source instance, so a delete never
    // reaches a sibling item's rows.
    const deletedIds = page.removed.map((r) => r.transaction_id);
    const deletedKeys = deletedIds.map((transaction_id) => ({
      item_id: this.itemId,
      transaction_id,
    }));
    const deletedExternalIds = deletedIds.map((id) => `${this.itemId}:${id}`);

    // Plaid is still filling in the item's history when the status is short of
    // complete: keep asking rather than idling, until the wait runs out.
    const backfilling =
      !page.has_more &&
      page.transactions_update_status !== undefined &&
      page.transactions_update_status !== PLAID_HISTORICAL_UPDATE_COMPLETE;
    const waitSince = backfilling
      ? (cursor?.backfillWaitSince ?? this.now().toISOString())
      : undefined;
    const keepWaiting =
      backfilling && this.now().getTime() - Date.parse(waitSince!) < PLAID_BACKFILL_WAIT_MS;
    if (backfilling && !keepWaiting) {
      log.info(
        `Plaid item ${this.itemId} is still building its history ` +
          `(${page.transactions_update_status}); the rest arrives on the next sync`,
      );
    }

    const morePages = page.has_more || keepWaiting;
    const nextPhase: PlaidCursor["phase"] = morePages ? "transactions" : next;
    // The run continues while there are pages left, and also when the delta is
    // caught up but a snapshot leg still has to run this pass.
    const hasMore = morePages || SNAPSHOT_PHASES.has(nextPhase);
    // A page that asks to be called again while carrying nothing is a wait,
    // not progress: the collector loops structured pages with no pacing of its
    // own, so without this the wait becomes a request storm against Plaid's
    // per-item limit.
    if (keepWaiting) await this.pace(opts);
    log.debug(
      `Plaid item ${this.itemId} sync page: +${parsed.transactions.length}/-${page.removed.length}` +
        (hasMore ? " (more)" : " (complete)"),
    );

    return {
      analytics: {
        tableName: plaidTransactionsSchema.tableName,
        records,
        schema: plaidTransactionsSchema,
        // Named by the table's whole key rather than by the transaction id
        // alone: the id is unique per item, and addressing a row by half its
        // key would mean "and everything else that shares this value".
        ...(deletedKeys.length > 0 ? { deletedKeys } : {}),
      },
      documents,
      progress: {
        phase: nextPhase,
        processed: records.length,
        coverage: "unknown",
        detail: HISTORY_COVERAGE_DETAIL,
      },
      deletedExternalIds: deletedExternalIds.length > 0 ? deletedExternalIds : undefined,
      cursor: {
        phase: nextPhase,
        transactionsCursor: page.next_cursor,
        // The run's restart point: the cursor it began with, kept for as long
        // as the pagination run continues and dropped once it is caught up.
        loopStartCursor: morePages
          ? (cursor?.loopStartCursor ?? cursor?.transactionsCursor)
          : undefined,
        lastSnapshotDate: cursor?.lastSnapshotDate,
        backfillWaitSince: keepWaiting ? waitSince : undefined,
      },
      hasMore,
    };
  }
}

/**
 * Whether a `/transactions/sync` call failed because the run's pages stopped
 * agreeing with each other. Only Plaid's own code counts: every other failure
 * keeps its routing, so a validation failure or an institution outage can never
 * be mistaken for a pagination restart.
 */
function isPaginationMutation(err: unknown): boolean {
  return err instanceof PlaidApiError && err.errorCode === PLAID_SYNC_MUTATION_CODE;
}
