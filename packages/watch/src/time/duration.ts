// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Durations in the Watch DSL.
 *
 * A duration is written the way a person writes one — `"3 days"`,
 * `"5 business_days"`, `"90 minutes"` — and parsed into a structured value the
 * validator can type-check and the runtime can add to a semantic instant.
 *
 * `business_days` is a calendar unit, not a multiple of 24h: five business days
 * after a Friday is the following Friday. It carries no holiday calendar —
 * Mon–Fri on the evaluation timezone is the whole rule.
 */

import { lookup } from "../internal/lookup.js";

/**
 * Units a DSL duration may be written in. Declared as an array so `DurationUnit`
 * can be derived from it and the two can never disagree.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- read as a type
const DURATION_UNITS = ["seconds", "minutes", "hours", "days", "weeks", "business_days"] as const;

export type DurationUnit = (typeof DURATION_UNITS)[number];

export interface Duration {
  readonly amount: number;
  readonly unit: DurationUnit;
}

/** Singular spellings a human might write, mapped onto the canonical unit. */
const UNIT_ALIASES: Record<string, DurationUnit> = {
  second: "seconds",
  seconds: "seconds",
  minute: "minutes",
  minutes: "minutes",
  hour: "hours",
  hours: "hours",
  day: "days",
  days: "days",
  week: "weeks",
  weeks: "weeks",
  business_day: "business_days",
  business_days: "business_days",
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s+([a-z_]+)$/;

/**
 * Parse `"<amount> <unit>"`. Returns `null` rather than throwing so callers can
 * turn a bad duration into a diagnostic with a JSON path attached.
 */
export function parseDuration(text: string): Duration | null {
  const match = DURATION_PATTERN.exec(text.trim());
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = lookup(UNIT_ALIASES, match[2]!);
  if (!unit) return null;

  // Calendar units advance whole days; a fractional one has no meaning.
  if (unit === "business_days" && !Number.isInteger(amount)) return null;

  return { amount, unit };
}

const DAY_MS = 86_400_000;

/**
 * A duration as a span of milliseconds.
 *
 * `business_days` counts as plain days here. Adding one to an instant is a
 * calendar walk that skips weekends — see the engine's `addDuration` — but the
 * *length* of the span is what a comparison against an elapsed interval needs,
 * and there is no weekend in an elapsed interval.
 */
export function durationMs(duration: Duration): number {
  switch (duration.unit) {
    case "seconds":
      return duration.amount * 1000;
    case "minutes":
      return duration.amount * 60_000;
    case "hours":
      return duration.amount * 3_600_000;
    case "days":
    case "business_days":
      return duration.amount * DAY_MS;
    case "weeks":
      return duration.amount * 7 * DAY_MS;
  }
}
