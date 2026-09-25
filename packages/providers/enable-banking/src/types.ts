// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { makeCursorValidator } from "@omnesis/source-sdk";
import type { SyncCursor } from "@omnesis/source-sdk";
import type { z } from "zod";
import type {
  ebAspspSchema,
  ebBalanceSchema,
  ebSessionAccountSchema,
  ebSessionResponseSchema,
  ebTransactionSchema,
  ebTransactionsPageSchema,
  storedSessionAccountSchema,
  storedSessionSchema,
} from "./schemas.js";
import type { EnableBankingClient } from "./client.js";

// ── Raw API shapes (inferred from the boundary schemas) ─────────────

export type EbAspsp = z.infer<typeof ebAspspSchema>;
export type EbSessionAccount = z.infer<typeof ebSessionAccountSchema>;
export type EbSessionResponse = z.infer<typeof ebSessionResponseSchema>;
export type EbBalance = z.infer<typeof ebBalanceSchema>;
export type EbTransaction = z.infer<typeof ebTransactionSchema>;
export type EbTransactionsPage = z.infer<typeof ebTransactionsPageSchema>;

// ── Local session persistence shapes ────────────────────────────────

export type StoredSessionAccount = z.infer<typeof storedSessionAccountSchema>;
export type StoredSession = z.infer<typeof storedSessionSchema>;

// ── Provider context ────────────────────────────────────────────────

export interface EnableBankingContext {
  client: EnableBankingClient;
  accountId: string;
  dataCutoff?: string;
  /** Injectable clock (tests); defaults to the real clock. */
  now: () => Date;
  /** Config dir override (tests); defaults to `DEFAULT_CONFIG_DIR`. */
  configDir?: string;
}

// ── Sync cursor ─────────────────────────────────────────────────────

/**
 * Phase machine:
 *
 * - `accounts` — first page ever: emit one `bank_accounts` row per session
 *   account (no API call; the session file is the truth).
 * - `bootstrap` — per account (by `accountIndex`): drain the raw pages the
 *   auth flow prefetched into the bootstrap cache (full history, captured
 *   inside Revolut's 5-minute post-SCA window); when no complete cache
 *   exists, fall back to fetching the last 90 days from the network.
 * - `balances` — one initial balance snapshot for every account, then flip
 *   to `incremental` and end the tick.
 * - `incremental` — every tick: per-account transactions with a 7-day
 *   overlap window (`date_from = lastBookingDate − 7d`); on the first tick
 *   of each UTC day, an accounts-refresh page and a balances snapshot run
 *   first (`incStage` tracks the in-tick stage).
 *
 * Identity note: everything is keyed by `account_key` (Enable Banking's
 * `identification_hash`) — stable across sessions. The session-scoped `uid`
 * is looked up fresh from `session.json` on every page, so a re-consent
 * that replaces the session re-maps handles without touching identity.
 */
export interface EnableBankingCursor extends SyncCursor {
  phase: "accounts" | "bootstrap" | "balances" | "incremental";
  /** Bootstrap: index into the session's accounts of the account being walked. */
  accountIndex?: number;
  /** Bootstrap: next cached page index to drain for the current account. */
  cachePageIndex?: number;
  /**
   * Bootstrap: consent epoch (the cache marker's session_id) the drain
   * started against. A re-consent mid-drain rewrites the cache under the
   * cursor; the drain detects the epoch mismatch and restarts the bootstrap
   * walk from the first account instead of reading renumbered pages.
   */
  bootstrapSessionId?: string;
  /** In-progress transactions continuation key (bootstrap network fallback / incremental). */
  continuationKey?: string;
  /** Max booking_date seen in the current account window; promoted at window end. */
  windowMaxBookingDate?: string;
  /**
   * Occurrence counters for hash-fallback transaction keys within the
   * current account window (only tuples that actually lacked
   * entry_reference/transaction_id — normally empty).
   */
  windowHashCounts?: Record<string, number>;
  /** Per-account (by account_key) latest fully-ingested booking_date. */
  lastBookingDates?: Record<string, string>;
  /**
   * Per-account (by account_key) how far back this account's history reached
   * when it was first walked.
   *
   * Recorded because the absence of a watermark does not distinguish the two
   * accounts that lack one: an account the 90-day fallback truncated, and an
   * account that simply holds no transactions. Both look identical from the
   * watermark alone, and reading the second as the first tells the operator
   * their bank's full-history capture failed when it succeeded.
   */
  bootstrapReach?: Record<string, "full" | "window">;
  /** UTC date (YYYY-MM-DD) of the last balances snapshot. */
  lastBalancesDate?: string;
  /** Incremental: in-tick stage. Unset = determine at tick start. */
  incStage?: "accounts-refresh" | "balances" | "transactions";
  /** Incremental: index of the account currently being fetched. */
  incrementalAccountIndex?: number;
}

const EB_PHASES: ReadonlySet<string> = new Set<EnableBankingCursor["phase"]>([
  "accounts",
  "bootstrap",
  "balances",
  "incremental",
]);

function isEnableBankingCursor(v: unknown): v is EnableBankingCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.phase === "string" && EB_PHASES.has(c.phase);
}

export const validateEnableBankingCursor = makeCursorValidator(isEnableBankingCursor);
