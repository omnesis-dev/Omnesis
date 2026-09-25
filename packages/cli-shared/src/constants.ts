// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared CLI operational constants. Each value is referenced from exactly
 * one place in code; centralising them here makes the budget visible and
 * lets a reviewer adjust one knob without grep'ing for naked numbers.
 *
 * Convention: all durations are milliseconds (`MS` suffix).
 */

// ── Timeouts ────────────────────────────────────────────────────────────

/**
 * `creds set` waits for the auth subprocess to call back after the user
 * finishes the OAuth handshake. The collector's worker-side cap matches —
 * if you change this, update the collector's auth-worker timeout too so
 * one side doesn't hold a flow that the other has already given up on.
 */
export const AUTH_FLOW_TIMEOUT_MS = 16 * 60 * 1000;

/**
 * AbortController timeout for `omnesis index rebuild` and
 * `omnesis sources reindex-missing`. Matches the gateway-side
 * indexer-worker run cap so the CLI doesn't quit while the worker is
 * still making forward progress on a big rebuild. If the worker-side
 * timeout changes, update this in lock-step (and vice versa).
 */
export const INDEXER_WORKER_TIMEOUT_MS = 16 * 60 * 1000;

/** `status --watch` redraw cadence (websocket-driven, plus a safety tick). */
export const STATUS_WATCH_TICK_MS = 1000;

/** `cli devices pair` server-sent-event idle timeout. */
export const DEVICE_PAIR_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// ── Layout / table widths ──────────────────────────────────────────────

// ── Pagination defaults ────────────────────────────────────────────────

/** `recent` default --limit. */
export const RECENT_DEFAULT_LIMIT = 20;
