// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Apple/Core Data epoch helpers.
 *
 * Apple's Core Data timestamps count seconds (or nanoseconds, in iMessage)
 * from 2001-01-01 UTC. This offset converts to/from the standard Unix epoch
 * (1970-01-01 UTC). Centralised here so the literal `978307200` doesn't
 * keep getting inlined across the package.
 */

/** Seconds between the Unix epoch (1970-01-01) and the Apple epoch (2001-01-01). */
export const APPLE_EPOCH_OFFSET_SECONDS = 978307200;

/** Convert a Core Data timestamp (seconds since 2001-01-01) to a JS Date. */
export function coreDataToDate(timestamp: number): Date {
  return new Date((timestamp + APPLE_EPOCH_OFFSET_SECONDS) * 1000);
}

/** Convert a Core Data timestamp to an ISO 8601 string. */
export function coreDataToISO(timestamp: number): string {
  return coreDataToDate(timestamp).toISOString();
}

/** Convert an ISO 8601 string to a Core Data timestamp (seconds since 2001-01-01). */
export function isoToCoreData(isoString: string): number {
  return new Date(isoString).getTime() / 1000 - APPLE_EPOCH_OFFSET_SECONDS;
}

/**
 * Convert an iMessage timestamp to a JS Date. iMessage stores seconds since
 * 2001-01-01 on macOS < 10.13 and nanoseconds since 2001-01-01 on macOS ≥
 * 10.13. The heuristic `> 1e12` reliably distinguishes the two formats for
 * any plausibly-valid date — 1e12 nanoseconds is ~16.6 minutes after the
 * Apple epoch, far below the smallest realistic message timestamp; 1e12
 * seconds is year 33630, far above any realistic message timestamp.
 *
 * Pre-10.13 backups eventually slip outside this heuristic if a value sits
 * very close to 1e12; that hasn't happened in practice, but the surface is
 * documented here so the next contributor doesn't have to reverse-engineer
 * the inline constant.
 */
export function imessageDateToDate(timestamp: number): Date {
  if (timestamp === 0) return new Date(0);
  const seconds = timestamp > 1e12 ? timestamp / 1e9 : timestamp;
  const unixSeconds = seconds + APPLE_EPOCH_OFFSET_SECONDS;
  return new Date(unixSeconds * 1000);
}

/** Convert an ISO 8601 string to an iMessage nanosecond timestamp. */
export function isoToImessageNs(isoString: string): number {
  const unixSeconds = new Date(isoString).getTime() / 1000;
  const appleSeconds = unixSeconds - APPLE_EPOCH_OFFSET_SECONDS;
  return appleSeconds * 1e9;
}
