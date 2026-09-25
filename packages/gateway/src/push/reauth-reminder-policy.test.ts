// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  backoffDelayMs,
  isReminderDue,
  resolveReauthBackoffConfig,
  DEFAULT_REAUTH_REMINDER_INITIAL_DELAY,
  DEFAULT_REAUTH_REMINDER_MULTIPLIER,
  DEFAULT_REAUTH_REMINDER_MAX_DELAY,
  type ReauthBackoffConfig,
} from "./reauth-reminder-policy.js";
import type { ReauthReminderRow } from "../data/repositories/ReauthRemindersRepository.js";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

/** Shipped defaults: initial 1d, ×2, cap 7d (1 week). */
const DEFAULTS: ReauthBackoffConfig = resolveReauthBackoffConfig(undefined);

function row(over: Partial<ReauthReminderRow>): ReauthReminderRow {
  return {
    principal: "google:user@example.com",
    device_id: "device-fictional",
    first_needed_at: 0,
    last_notified_at: 0,
    notify_count: 1,
    ...over,
  };
}

describe("resolveReauthBackoffConfig", () => {
  test("defaults match the policy constants (1d → ×2 → cap 7d)", () => {
    expect(DEFAULT_REAUTH_REMINDER_INITIAL_DELAY).toBe("1d");
    expect(DEFAULT_REAUTH_REMINDER_MULTIPLIER).toBe(2);
    expect(DEFAULT_REAUTH_REMINDER_MAX_DELAY).toBe("7d");
    expect(DEFAULTS).toEqual({
      initialDelayMs: DAY,
      multiplier: 2,
      maxDelayMs: WEEK,
      reservationTtlMs: 5 * 60_000,
    });
  });

  test("operator overrides win per-field; unset fields fall back", () => {
    const cfg = resolveReauthBackoffConfig({ initialDelay: "2h", multiplier: 3 });
    expect(cfg).toEqual({
      initialDelayMs: 2 * 60 * 60 * 1000,
      multiplier: 3,
      maxDelayMs: WEEK,
      reservationTtlMs: 5 * 60_000,
    });
  });

  test.each(["initialDelay", "maxDelay", "reservationTtl"] as const)(
    "rejects a zero %s even when runtime settings bypass schema parsing",
    (field) => {
      expect(() => resolveReauthBackoffConfig({ [field]: "0ms" })).toThrow(/greater than zero/);
    },
  );
});

describe("backoffDelayMs — the 1d → 2d → 4d → 7d ladder", () => {
  test("grows by the multiplier per reminder, clamped to the cap", () => {
    // notify_count is "reminders sent so far"; the delay is for the NEXT one.
    expect(backoffDelayMs(1, DEFAULTS)).toBe(1 * DAY); // after 1st → wait 1d
    expect(backoffDelayMs(2, DEFAULTS)).toBe(2 * DAY); // after 2nd → wait 2d
    expect(backoffDelayMs(3, DEFAULTS)).toBe(4 * DAY); // after 3rd → wait 4d
    expect(backoffDelayMs(4, DEFAULTS)).toBe(WEEK); // 8d clamped to 7d
    expect(backoffDelayMs(5, DEFAULTS)).toBe(WEEK); // stays at the cap
    expect(backoffDelayMs(50, DEFAULTS)).toBe(WEEK); // never unbounded
  });
});

describe("isReminderDue", () => {
  test("an uncommitted first attempt remains immediately due", () => {
    const cfg = resolveReauthBackoffConfig(undefined);
    expect(
      isReminderDue(
        {
          principal: "fictional:account",
          device_id: "device-fictional",
          first_needed_at: 1_000,
          last_notified_at: 0,
          notify_count: 0,
        },
        1_001,
        cfg,
      ),
    ).toBe(true);
  });

  test("no prior record → due (the immediate first reminder)", () => {
    expect(isReminderDue(null, 1_000, DEFAULTS)).toBe(true);
  });

  test("not due until the backoff interval has elapsed since the last reminder", () => {
    const sent = row({ notify_count: 1, last_notified_at: 0 });
    // Wait for the 1st→2nd gap = 1d.
    expect(isReminderDue(sent, DAY - 1, DEFAULTS)).toBe(false);
    expect(isReminderDue(sent, DAY, DEFAULTS)).toBe(true);
  });

  test("the gap widens as notify_count climbs", () => {
    const afterThree = row({ notify_count: 3, last_notified_at: 100 });
    expect(isReminderDue(afterThree, 100 + 4 * DAY - 1, DEFAULTS)).toBe(false);
    expect(isReminderDue(afterThree, 100 + 4 * DAY, DEFAULTS)).toBe(true);
  });

  test("once past the cap, the gap settles at maxDelay", () => {
    const deepInBackoff = row({ notify_count: 10, last_notified_at: 0 });
    expect(isReminderDue(deepInBackoff, WEEK - 1, DEFAULTS)).toBe(false);
    expect(isReminderDue(deepInBackoff, WEEK, DEFAULTS)).toBe(true);
  });
});
