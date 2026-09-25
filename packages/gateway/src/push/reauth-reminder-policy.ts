// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Backoff policy for the built-in re-auth notification.
 *
 * Pure decision logic: given a principal's persisted reminder state and the
 * current time, decide whether a reminder is due now. The first reminder
 * fires immediately when a connection is first seen needing re-auth; each
 * subsequent reminder waits an exponentially growing interval since the last
 * one — `initialDelay`, then ×`multiplier` per reminder, clamped to
 * `maxDelay`. With the defaults that is the ladder 1d → 2d → 4d → 7d → 7d → …
 * (the cap stops it doubling unbounded), so a forgetful operator is still
 * nudged but rarely.
 *
 * The de-dup principal is the provider *connection* (`<providerType>:<accountId>`),
 * not the source: one re-auth fixes every source under it, so the reminder is
 * owed once per connection. See `ReauthRemindersRepository`.
 */

import { parseDuration } from "@omnesis/core";
import type { ReauthRemindersSettings } from "@omnesis/config";

import type { ReauthReminderRow } from "../data/repositories/ReauthRemindersRepository.js";

/** First reminder fires immediately; the second waits this long after it. */
export const DEFAULT_REAUTH_REMINDER_INITIAL_DELAY = "1d";
/** Each successive reminder waits this many times longer, until the cap. */
export const DEFAULT_REAUTH_REMINDER_MULTIPLIER = 2;
/** Ceiling on the backoff interval (1 week) — past it, reminders settle at this cadence. */
export const DEFAULT_REAUTH_REMINDER_MAX_DELAY = "7d";
export const DEFAULT_REAUTH_REMINDER_RESERVATION_TTL = "5m";

export interface ReauthBackoffConfig {
  /** Delay before the *second* reminder (after the immediate first), ms. */
  initialDelayMs: number;
  /** Growth factor applied per reminder already sent. */
  multiplier: number;
  /** Ceiling on the inter-reminder delay, ms. */
  maxDelayMs: number;
  reservationTtlMs: number;
}

/**
 * Resolve the runtime backoff config from the (optional) operator settings,
 * falling back to the policy defaults for each unset field. The crosscheck
 * test (`config-defaults.crosscheck.test.ts`) pins the display defaults to
 * these constants.
 */
export function resolveReauthBackoffConfig(
  settings: ReauthRemindersSettings | undefined,
): ReauthBackoffConfig {
  const resolved = {
    initialDelayMs: parseDuration(settings?.initialDelay ?? DEFAULT_REAUTH_REMINDER_INITIAL_DELAY),
    multiplier: settings?.multiplier ?? DEFAULT_REAUTH_REMINDER_MULTIPLIER,
    maxDelayMs: parseDuration(settings?.maxDelay ?? DEFAULT_REAUTH_REMINDER_MAX_DELAY),
    reservationTtlMs: parseDuration(
      settings?.reservationTtl ?? DEFAULT_REAUTH_REMINDER_RESERVATION_TTL,
    ),
  };
  if (resolved.initialDelayMs <= 0 || resolved.maxDelayMs <= 0 || resolved.reservationTtlMs <= 0)
    throw new Error("re-auth reminder durations must be greater than zero");
  return resolved;
}

/**
 * Required delay before the reminder *after* `notifyCount` reminders have
 * already been sent. `notifyCount === 1` (one sent) → `initialDelayMs`;
 * each further reminder multiplies by `multiplier`, clamped to `maxDelayMs`.
 */
export function backoffDelayMs(notifyCount: number, cfg: ReauthBackoffConfig): number {
  const steps = Math.max(0, notifyCount - 1);
  const raw = cfg.initialDelayMs * Math.pow(cfg.multiplier, steps);
  return Math.min(raw, cfg.maxDelayMs);
}

/**
 * Decide whether a re-auth reminder is due for a principal whose connection
 * is (still) in `needs-auth`.
 *
 * - No accepted reminder yet → due (the first, immediate reminder).
 * - Prior row → due only once `backoffDelayMs(notify_count)` has elapsed
 *   since `last_notified_at`.
 */
export function isReminderDue(
  existing: ReauthReminderRow | null,
  now: number,
  cfg: ReauthBackoffConfig,
): boolean {
  if (!existing || existing.notify_count === 0) return true;
  const wait = backoffDelayMs(existing.notify_count, cfg);
  return now - existing.last_notified_at >= wait;
}
