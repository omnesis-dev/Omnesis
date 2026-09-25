// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { makeCursorValidator } from "@omnesis/source-sdk";
import type { SyncCursor } from "@omnesis/source-sdk";
import type { CoinbaseClient } from "./client.js";

// ── Provider context ────────────────────────────────────────────────

export interface CoinbaseContext {
  client: CoinbaseClient;
  accountId: string;
  dataCutoff?: string;
  configDir?: string;
}

// ── Credentials ─────────────────────────────────────────────────────

/**
 * The pasted CDP API key — the per-account credential for an api-key source.
 * Stored at `<configDir>/coinbase-credentials.json` (mode 0600). There is no
 * shared OAuth client: the key id + private key ARE the credential.
 */
export interface CoinbaseCredentials {
  /** CDP key id (key name), e.g. `organizations/{org}/apiKeys/{id}`. */
  key_id: string;
  /** CDP private key, PEM. EC P-256 (ES256) or Ed25519 (EdDSA). */
  private_key: string;
}

// ── Raw API shapes (validation surface) ─────────────────────────────

/**
 * The discrete read/trade/transfer permissions surfaced by
 * `GET /api/v3/brokerage/key_permissions`. A read-only key has
 * `can_view: true` with both `can_trade` and `can_transfer` false;
 * `authFlow()` refuses anything that can trade or transfer.
 */
export interface CoinbaseKeyPermissions {
  can_view: boolean;
  can_trade: boolean;
  can_transfer: boolean;
  /** Stable portfolio identity used as the source's AccountId. */
  retail_portfolio_id?: string;
  portfolio_type?: string;
}

/** A single account entry from `GET /api/v3/brokerage/accounts`. */
export interface CoinbaseAccount {
  uuid: string;
  currency: string;
  retail_portfolio_id?: string;
}

/** The `accounts` list response (paged via `has_next` + `cursor`). */
export interface CoinbaseAccountsResponse {
  accounts: CoinbaseAccount[];
  has_next: boolean;
  cursor?: string;
  size?: number;
}

// ── Sync cursor ─────────────────────────────────────────────────────

/**
 * Phase machine for the structured sync.
 *
 * Balances + holdings are point-in-time snapshots; orders, fills, and
 * the v2 transaction ledger are current-state APPEND-ONLY activity walks.
 *
 * Flow: `snapshot-balances` (paginate `GET /accounts`) → `snapshot-holdings`
 * (iterate portfolios, breakdown each) → `orders` (cursor-walk historical
 * orders) → `fills` (cursor-walk fills) → `transactions` (v2 ledger, skipped
 * gracefully if the grant is absent) → `incremental` (idle until a new UTC day,
 * then re-run the snapshots and append-only walks). A new day appends a fresh
 * snapshot; a same-day re-sync overwrites the day's snapshot rows idempotently
 * (composite PK), while orders/fills/transactions dedupe on their stable
 * upstream id and only fetch rows newer than a persisted watermark.
 */
export type CoinbasePhase =
  | "snapshot-balances"
  | "snapshot-holdings"
  | "orders"
  | "fills"
  | "transactions"
  | "incremental";

export interface CoinbaseCursor extends SyncCursor {
  phase: CoinbasePhase;
  /** Opaque Coinbase pagination cursor for the in-progress phase. */
  pageCursor?: string;
  /**
   * UTC day (YYYY-MM-DD) the snapshot phases are writing to for this pass. Held
   * across pages so a multi-page snapshot that straddles UTC midnight keeps
   * writing to ONE consistent day (set on the first balances page, cleared when
   * the holdings phase completes) — see the midnight-boundary note in snapshot.ts.
   */
  snapshotDate?: string;
  /** Index into the portfolio list during the `snapshot-holdings` phase. */
  portfolioIndex?: number;
  /** Portfolio UUIDs resolved once at the start of the holdings phase. */
  portfolioUuids?: string[];
  /** UTC day of the last completed snapshot — `incremental` re-snapshots when the day rolls over. */
  lastSnapshotDate?: string;

  // ── append-only activity watermarks ───────────────────────
  /**
   * Watermark for the orders walk: the `created_time` of the newest order
   * ingested so far. The next walk fetches only orders at/after this time, so
   * settled history is never re-walked. Held as the page-walk's running max and
   * promoted when the phase completes (an interrupted walk re-covers from the
   * old watermark; the stable-`order_id` PK makes the overlap idempotent).
   */
  ordersWatermark?: string;
  /** Running max `created_time` observed during the in-progress orders walk. */
  ordersSweepMax?: string;
  /** Watermark for the fills walk: newest `trade_time` ingested (see ordersWatermark). */
  fillsWatermark?: string;
  /** Running max `trade_time` observed during the in-progress fills walk. */
  fillsSweepMax?: string;

  // ── v2 ledger state ────────────────────────────────────────
  /** v2 wallet account ids to walk, resolved once at the start of the transactions phase. */
  ledgerAccountIds?: string[];
  /** Index into `ledgerAccountIds` during the transactions phase. */
  ledgerAccountIndex?: number;
  /**
   * Per-wallet watermark map (wallet account id → newest `created_at` ingested).
   * The v2 ledger has no server-side time filter, so the walk stops paging a
   * wallet once it reaches rows at/before its watermark (newest-first order).
   */
  ledgerWatermarks?: Record<string, string>;
  /** Running max `created_at` for the wallet currently being walked. */
  ledgerSweepMax?: string;
  /**
   * Set once the v2 ledger has been confirmed absent (CoinbaseScopeError) for
   * this context, so later passes skip the grant probe entirely until re-auth
   * rebuilds the context.
   */
  ledgerUnavailable?: boolean;
}

export const COINBASE_PHASES: ReadonlySet<string> = new Set<CoinbasePhase>([
  "snapshot-balances",
  "snapshot-holdings",
  "orders",
  "fills",
  "transactions",
  "incremental",
]);

function isCoinbaseCursor(v: unknown): v is CoinbaseCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.phase === "string" && COINBASE_PHASES.has(c.phase);
}

export const validateCoinbaseCursor = makeCursorValidator(isCoinbaseCursor);
