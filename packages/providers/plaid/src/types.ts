// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { makeCursorValidator } from "@omnesis/source-sdk";
import type { SyncCursor } from "@omnesis/source-sdk";
import type { PlaidClient } from "./client.js";

// ── Plaid environment ───────────────────────────────────────────────

/**
 * Plaid serves each developer app from one of two isolated environments. The
 * operator's secret is environment-specific, so the environment is part of the
 * app credential (a credential created in `sandbox` does not authenticate
 * against `production`). `sandbox` drives all tests against Plaid's synthetic
 * institutions; `production` is the live AIS environment. Plaid retired the
 * separate `development` environment, so it is intentionally absent.
 */
export type PlaidEnvironment = "sandbox" | "production";

export const PLAID_ENVIRONMENTS: readonly PlaidEnvironment[] = ["sandbox", "production"];

/**
 * Names both the operator's app-credential file (`plaid-credentials.json`) and
 * the directory the per-item credentials live under.
 */
export const PLAID_FILE_KEY = "plaid";

/** Map an environment to its API host (no trailing slash). */
export function plaidHost(env: PlaidEnvironment): string {
  return env === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";
}

// ── Credentials ─────────────────────────────────────────────────────

/**
 * The operator's Plaid developer-app credential — configured once, like an
 * OAuth client, and shared across every Plaid item the operator connects.
 * Stored as a provider-credentials file (mode 0600); **never logged**. This is
 * distinct from the per-item `access_token` (the per-account credential), which
 * lives in the per-account token store.
 */
export interface PlaidCredentials {
  /** Plaid `client_id` — identifies the developer app. */
  client_id: string;
  /** Environment-scoped secret. Never logged, never embedded in an id. */
  secret: string;
  /** Which Plaid environment the secret authenticates against. */
  environment: PlaidEnvironment;
  /**
   * ISO 3166-1 alpha-2 codes of the countries whose institutions Link offers.
   * Plaid lists only institutions in these countries, so this is the
   * operator's choice of market, not a filter Omnesis applies afterwards.
   */
  countries: readonly string[];
}

/** Countries offered when the credential does not name any. */
export const PLAID_DEFAULT_COUNTRIES: readonly string[] = ["US", "CA"];

/** Parse the wizard's comma-separated country list; empty → the default. */
export function parseCountries(raw: string | undefined): readonly string[] {
  const codes = (raw ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
  return codes.length > 0 ? codes : PLAID_DEFAULT_COUNTRIES;
}

// ── Per-item (per-account) credential ───────────────────────────────

/**
 * The per-item credential minted by `/item/public_token/exchange`. One per
 * connected institution (Plaid "item"). The stable account id is the Plaid
 * `item_id` (stable across re-consent). Stored in the per-account token dir;
 * **never logged**.
 */
export interface PlaidItemCredential {
  /** Opaque per-item access token used on every subsequent data request. */
  access_token: string;
  /** Stable Plaid item id — used verbatim as the Omnesis AccountId. */
  item_id: string;
  /** Institution display name captured at Link time, for the instance label. */
  institution_name?: string;
  /** Plaid institution id captured at Link time; identifies the bank. */
  institution_id?: string;
  /** Base64 PNG of the institution's mark, for the instance icon. */
  institution_logo?: string;
  /** The institution's brand colour (hex), for the instance icon. */
  institution_color?: string;
}

// ── Provider context ────────────────────────────────────────────────

export interface PlaidContext {
  client: PlaidClient;
  /** The connected item's account id (the Plaid `item_id`). */
  accountId: string;
  /** ISO 8601 — data older than this is skipped on backfill. */
  dataCutoff?: string;
  configDir?: string;
}

// ── Sync cursor ─────────────────────────────────────────────────────

/**
 * Phase machine for the structured sync. Transactions use Plaid's
 * delta-cursor (`/transactions/sync`): the SAME endpoint serves both the
 * initial history (no cursor — as many days as the item requested at Link
 * time) and every later incremental delta (with the stored cursor), so
 * transactions are a single self-paginating `transactions` phase rather than
 * separate bootstrap/incremental phases. Balances and holdings are
 * point-in-time day-folded snapshots with their own phases; every phase is
 * declared here so the cursor validator is the single source of truth.
 */
export type PlaidPhase = "transactions" | "snapshot-balances" | "snapshot-holdings" | "incremental";

export interface PlaidCursor extends SyncCursor {
  phase: PlaidPhase;
  /**
   * Plaid `/transactions/sync` delta cursor — omitted on the very first sync of
   * an item (the history requested at Link time), then advanced ONLY after a page durably
   * ingests so an at-least-once retry re-fetches the same page idempotently.
   */
  transactionsCursor?: string;
  /** UTC day (YYYY-MM-DD) the snapshot phases are writing to this pass. */
  snapshotDate?: string;
  /** UTC day of the last completed snapshot — `incremental` re-snapshots on rollover. */
  lastSnapshotDate?: string;
  /**
   * The delta cursor the current pagination run began with. Plaid invalidates a
   * run whose data changed underneath it and asks for a restart from here.
   */
  loopStartCursor?: string;
  /** Consecutive pagination restarts this run has absorbed. */
  paginationRestarts?: number;
  /**
   * ISO instant the transactions phase first saw Plaid's history pull still
   * in progress on a caught-up page. Bounds how long one tick keeps polling
   * for the rest of the history before leaving it to the next scheduled run.
   */
  backfillWaitSince?: string;
}

export const PLAID_PHASES: ReadonlySet<string> = new Set<PlaidPhase>([
  "transactions",
  "snapshot-balances",
  "snapshot-holdings",
  "incremental",
]);

/**
 * Every field the sync dereferences is checked, not just the phase. A cursor
 * whose `transactionsCursor` is not a string would be sent to Plaid as-is and
 * rejected on every call with nothing to clear it; a non-string
 * `lastSnapshotDate` would never equal today and would re-snapshot on every
 * tick. Failing the guard re-bootstraps instead, which both recover from.
 */
export function isPlaidCursor(v: unknown): v is PlaidCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (typeof c.phase !== "string" || !PLAID_PHASES.has(c.phase)) return false;
  return (
    isOptionalString(c.transactionsCursor) &&
    isOptionalString(c.loopStartCursor) &&
    isOptionalString(c.snapshotDate) &&
    isOptionalString(c.lastSnapshotDate) &&
    isOptionalString(c.backfillWaitSince) &&
    (c.paginationRestarts === undefined || typeof c.paginationRestarts === "number")
  );
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

export const validatePlaidCursor = makeCursorValidator(isPlaidCursor);
