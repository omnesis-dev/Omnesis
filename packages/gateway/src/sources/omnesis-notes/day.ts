// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Capture-local calendar-day math for omnesis-notes. The `day` string is
 * the ledger's grouping key and the projected document's `externalId`, so
 * every caller derives it here from the frozen capture offset. Legacy calls
 * with no offset use the gateway-local interpretation.
 */

/** `YYYY-MM-DD` shape guard for the HTTP `?day=` query param. */
export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The capture-local calendar day (`YYYY-MM-DD`) an ISO-8601 instant falls
 * on, using the supplied frozen UTC offset. With no offset it uses the host
 * timezone when capture context is absent. Throws on an unparsable input so a bad
 * timestamp can never silently key a `NaN-NaN-NaN` day.
 */
export function dayKeyFor(iso: string, utcOffsetSeconds?: number | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`dayKeyFor: unparsable ISO timestamp "${iso}"`);
  }
  if (utcOffsetSeconds !== undefined && utcOffsetSeconds !== null) {
    const local = new Date(d.getTime() + utcOffsetSeconds * 1_000);
    return `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Capture-local `HH:MM`, falling back to gateway-local when no offset exists. */
export function localHourMinute(iso: string, utcOffsetSeconds?: number | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`localHourMinute: unparsable ISO timestamp "${iso}"`);
  }
  if (utcOffsetSeconds !== undefined && utcOffsetSeconds !== null) {
    const local = new Date(d.getTime() + utcOffsetSeconds * 1_000);
    return `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
  }
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
