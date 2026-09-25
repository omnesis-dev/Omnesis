// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { makeCursorValidator } from "@omnesis/source-sdk";
import type { SyncCursor } from "@omnesis/source-sdk";
import type { z } from "zod";
import type {
  lunchflowAccountSchema,
  lunchflowBalanceSchema,
  lunchflowTransactionSchema,
} from "./schemas.js";
import type { LunchflowClient } from "./client.js";

// ── Raw API shapes (inferred from the boundary schemas) ─────────────

export type LunchflowAccount = z.infer<typeof lunchflowAccountSchema>;
export type LunchflowTransaction = z.infer<typeof lunchflowTransactionSchema>;
export type LunchflowBalance = z.infer<typeof lunchflowBalanceSchema>;

// ── Provider context ────────────────────────────────────────────────

export interface LunchflowContext {
  client: LunchflowClient;
  /**
   * This connection's account id. Derived from the API key, so several keys
   * can be connected side by side; installs made before that keep the literal
   * `"default"`.
   */
  accountId: string;
  /** ISO 8601 — transactions older than this are skipped on backfill. */
  dataCutoff?: string;
  /** Collector config dir, threaded so per-account credential reads honour it. */
  configDir?: string;
  /** Injectable clock (tests); defaults to the real clock. */
  now: () => Date;
}

// ── Per-account context carried through a tick ──────────────────────

/**
 * The slice of a connected account the transactions/balances phases need to
 * fan out — captured in the cursor by the `accounts` phase so the subsequent
 * phases don't re-list every page. Small and JSON-serializable.
 */
export interface LunchflowCursorAccount {
  /** Lunch Flow numeric account id, as a string. */
  id: string;
  name: string | null;
  institutionName: string | null;
  currency: string | null;
}

// ── Sync cursor ─────────────────────────────────────────────────────

/**
 * Phase machine (one Lunch Flow connection, fanned out over its accounts):
 *
 * - `accounts` — tick start: `GET /accounts`, emit one `lunchflow_accounts`
 *   row per connected account, and capture the syncable accounts (ACTIVE or
 *   status-less) into `accounts` to drive the rest of the tick.
 * - `transactions` — per account (by `accountIndex`): fetch the window
 *   `from = lastDate − overlap` (or the data cutoff on first backfill) in a
 *   single unpaginated call, emit `lunchflow_transactions` rows + a
 *   searchable document per transaction, and promote the per-account
 *   watermark.
 * - `balances` — once per UTC day: per account, snapshot the balance into
 *   `lunchflow_balances`, then end the tick.
 *
 * Identity is the Lunch Flow account id throughout; transactions are keyed by
 * the Lunch Flow transaction id when present, else a content hash.
 *
 * See #36 — a future `holdings` phase (GET /accounts/{id}/holdings) would
 * snapshot investment positions for brokerage accounts.
 */
export interface LunchflowCursor extends SyncCursor {
  phase: "accounts" | "transactions" | "balances";
  /** Syncable accounts captured by the `accounts` phase; drives the fanout. */
  accounts?: LunchflowCursorAccount[];
  /** Index into `accounts` of the account currently being walked. */
  accountIndex?: number;
  /** Per-account (by account id) latest ingested transaction date (YYYY-MM-DD). */
  lastDates?: Record<string, string>;
  /** UTC date (YYYY-MM-DD) of the last balances snapshot. */
  lastBalancesDate?: string;
  /**
   * Per-account (by account id) currency, learned from the account's
   * transactions/balance. Lunch Flow's `GET /accounts` carries no currency, so
   * the `accounts` phase stamps it onto each `lunchflow_accounts` row from this
   * map — populated by the transactions and balances phases — which means an
   * account's currency lands on the cycle after its money is first fetched.
   */
  currencies?: Record<string, string>;
}

const LUNCHFLOW_PHASES: ReadonlySet<string> = new Set<LunchflowCursor["phase"]>([
  "accounts",
  "transactions",
  "balances",
]);

function isLunchflowCursor(v: unknown): v is LunchflowCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.phase === "string" && LUNCHFLOW_PHASES.has(c.phase);
}

export const validateLunchflowCursor = makeCursorValidator(isLunchflowCursor);
