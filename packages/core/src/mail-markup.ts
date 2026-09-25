// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * schema.org email-markup promotion shared by mail-like sources.
 *
 * Transactional confirmation emails (flights, hotels, orders, reservations)
 * embed schema.org JSON-LD per Google's email-markup spec. Extracting the
 * planned-start / deadline dates promotes the typed `scheduledAt` / `dueAt`
 * document-metadata fields the steward waker keys its
 * actionable-transactional override off. Lives here so every mail-like
 * provider (Gmail, IMAP, …) shares one extraction contract instead of each
 * re-deriving it.
 */

/**
 * schema.org JSON-LD date keys that represent a planned START moment (an
 * appointment, a check-in, a departure) vs. a DEADLINE.
 */
const SCHEMA_SCHEDULED_KEYS = new Set([
  "startDate",
  "startTime",
  "checkinDate",
  "checkinTime",
  "departureTime",
  "expectedArrivalFrom",
]);
const SCHEMA_DUE_KEYS = new Set(["paymentDueDate", "dueDate", "expectedArrivalUntil"]);

/** Recursively collect schema.org date-key string values into the two buckets. */
function collectSchemaDates(node: unknown, scheduled: string[], due: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectSchemaDates(child, scheduled, due);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (SCHEMA_SCHEDULED_KEYS.has(key)) scheduled.push(value);
      else if (SCHEMA_DUE_KEYS.has(key)) due.push(value);
    } else if (value !== null && typeof value === "object") {
      collectSchemaDates(value, scheduled, due);
    }
  }
}

/** A calendar day with no time, and an instant carrying `Z` or a numeric offset. */
const SCHEMA_DAY = /^(\d{4}-\d{2}-\d{2})$/;
const SCHEMA_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Reduce a schema.org date to the shape `scheduledAt` / `dueAt` accept.
 *
 * schema.org's `Date` and `DateTime` both permit a bare calendar day, and
 * `DateTime` additionally permits a local wall clock with no zone. All three
 * arrive here, because the values are authored by airlines, hotels and
 * ticketing platforms rather than by us.
 *
 * A wall clock with no zone names no instant — whoever wrote `19:00` meant it
 * somewhere, and the email does not say where — so the day is the most it
 * establishes and the time is dropped. That is exactly what the metadata
 * contract asks for: a full date-time when a time is genuinely known, a
 * date-only string when it is a zone-less wall-clock day. Anything neither
 * shape describes is not a date we can place, and is left out.
 */
function normalizeSchemaDate(raw: string): string | undefined {
  const value = raw.trim();
  if (SCHEMA_INSTANT.test(value) && !Number.isNaN(Date.parse(value))) return value;
  // A day is round-tripped rather than merely parsed: Date.parse rolls an
  // impossible day such as `2026-02-30` into the next month rather than
  // refusing it, which would silently move the fact.
  const day = SCHEMA_DAY.exec(value.slice(0, 10))?.[1];
  if (!day) return undefined;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? day : undefined;
}

/** The earliest usable date in a bucket, reduced to the contract's shape. */
function earliestSchemaDate(values: string[]): string | undefined {
  const parsed = values
    .map((s) => normalizeSchemaDate(s))
    .filter((s): s is string => s !== undefined)
    .map((s) => [s, Date.parse(s)] as const)
    .filter(([, ms]) => !Number.isNaN(ms))
    .sort((a, b) => a[1] - b[1]);
  return parsed[0]?.[0];
}

/**
 * Whether an RFC 3834 `Auto-Submitted` header value marks the message as
 * machine-generated. The grammar allows parameters and CFWS comments after
 * the value (`no (sent by a human)`, `auto-replied; owner=…`), so only the
 * first token decides: absent or `no` means a human sent it; anything else
 * (`auto-generated`, `auto-replied`, extension tokens) means a machine did.
 */
export function isAutoSubmittedGenerated(value: string | undefined): boolean {
  const token = value
    ?.trim()
    .toLowerCase()
    .split(/[\s;(]/, 1)[0];
  return token !== undefined && token !== "" && token !== "no";
}

/**
 * Shared relevance penalty for the bulk/automation header signals every
 * mail-like source reads (List-Unsubscribe, Precedence, Auto-Submitted).
 * One table so Gmail and IMAP cannot drift: an unsubscribe header costs
 * 0.25, list/bulk precedence 0.15, a machine-generated Auto-Submitted 0.3.
 * Returns zero or a negative number for the caller to add to its base score.
 */
export function mailHeaderRelevancePenalty(headers: {
  listUnsubscribe?: string;
  precedence?: string;
  autoSubmitted?: string;
}): number {
  let penalty = 0;
  if (headers.listUnsubscribe) penalty -= 0.25;
  if (["bulk", "list"].includes(headers.precedence?.toLowerCase() ?? "")) penalty -= 0.15;
  if (isAutoSubmittedGenerated(headers.autoSubmitted)) penalty -= 0.3;
  return penalty;
}

/**
 * Parse schema.org JSON-LD (`<script type="application/ld+json">`) out of email
 * HTML and promote any booking / reservation / order dates to the typed
 * `scheduledAt` (earliest planned start) / `dueAt` (earliest deadline) fields
 * (#1168). Cheap + robust: regex the script blocks, JSON.parse each, walk for
 * the known date keys. Returns {} when the HTML carries no such markup.
 */
export function extractSchemaOrgDatesFromHtml(html: string): {
  scheduledAt?: string;
  dueAt?: string;
} {
  const scheduled: string[] = [];
  const due: string[] = [];
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      collectSchemaDates(JSON.parse(match[1]!.trim()), scheduled, due);
    } catch {
      // A malformed JSON-LD block — skip it, keep scanning the rest.
    }
  }
  const out: { scheduledAt?: string; dueAt?: string } = {};
  const s = earliestSchemaDate(scheduled);
  const d = earliestSchemaDate(due);
  if (s) out.scheduledAt = s;
  if (d) out.dueAt = d;
  return out;
}
