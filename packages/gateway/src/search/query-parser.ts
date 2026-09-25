// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Query parser — extracts structured filters from query text.
 * No LLM required, deterministic regex parsing.
 */

import { sameRoles } from "./filters.js";
import type { PersonFilter, SearchFilters, SearchNotice } from "./types.js";

/** One filter token the parser consumed, as typed, and the family it fed. */
export interface ParsedFilterToken {
  filter: SearchNotice["filter"];
  /** The token as it appeared in the query (`by:maya`, `#work`, `type:email`). */
  token: string;
}

export interface ParsedQuery {
  text: string;
  filters: SearchFilters;
  /**
   * Per-token feedback collected during parsing. The pipeline merges
   * these with its own resolution notices into `SearchResponse.notices`
   * so the caller learns about silently-dropped tokens (e.g.
   * `after:tomorrow` couldn't be parsed as a date).
   */
  notices: SearchNotice[];
  /**
   * Every filter token consumed, in query order. `filters` holds the
   * canonical form (`by:` lands in the same person bucket as `from:`), so a
   * caller that refuses a filter family reads the tokens here to name them
   * the way they were written.
   */
  tokens: ParsedFilterToken[];
}

// Relative date keywords
const RELATIVE_DATES: Record<string, () => string> = {
  today: () => new Date().toISOString().slice(0, 10),
  yesterday: () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  },
  "last week": () => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  },
  "last month": () => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  },
  "last year": () => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  },
};

/**
 * Resolve a date value — either an ISO date or a relative keyword.
 */
function resolveDate(value: string): string | null {
  // ISO date format (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const lower = value.toLowerCase();
  const resolver = RELATIVE_DATES[lower];
  return resolver ? resolver() : null;
}

const FROM_ROLES: readonly string[] = ["sender", "author", "owner"];
// `to:` covers the delivery side of a document: `recipient` (mail To/Cc,
// readers a file was shared with) and `attendee` (calendar invitees, people
// listed on a meeting note). `participant` stays out — it marks presence in
// a conversation, not delivery to a person.
const TO_ROLES: readonly string[] = ["recipient", "attendee"];

// Order-independent role-set equality. The from:/to: buckets are unordered
// OR-sets, so two role signatures match when they hold the same roles
// regardless of order.
function sameRoleSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && b.every((r) => a.includes(r));
}

/**
 * Reverse of the `from:`/`to:` intent→roles map: turn a `PersonFilter`'s
 * `roles` signature back into the user-facing token (`from` / `to` / `with`)
 * so error notices read the way the caller typed them. Derived from
 * `FROM_ROLES`/`TO_ROLES` here — the single source of truth for the
 * bijection — so the forward and reverse maps cannot drift (adding a role to
 * `FROM_ROLES` updates both directions). Unknown shapes fall back to the
 * generic `person` label.
 */
export function pillTokenForRoles(roles: readonly string[] | undefined): string {
  if (!roles) return "with";
  if (sameRoleSet(roles, TO_ROLES)) return "to";
  if (sameRoleSet(roles, FROM_ROLES)) return "from";
  return "person";
}

/**
 * Push a person ref into the parsed filters under the right role
 * bucket. Refs from the same intent (e.g. two `from:` tokens) share a
 * single bucket so they OR together; different intents stay in
 * separate buckets so they AND together — `from:alice to:bob` ends up
 * with one bucket per role rather than collapsing both refs into the
 * recipient bucket the way the old flat `personRoles` array did.
 */
function pushPersonRef(
  filters: SearchFilters,
  value: string,
  intent: "from" | "to" | "with",
): void {
  const buckets = (filters.personFilters ??= []);
  const desiredRoles: readonly string[] | undefined =
    intent === "from" ? FROM_ROLES : intent === "to" ? TO_ROLES : undefined;

  // Find an existing bucket whose role set matches this intent.
  const match = buckets.find((b) => sameRoles(b.roles, desiredRoles));
  if (match) {
    match.refs.push(value);
    return;
  }
  const next: PersonFilter = { refs: [value] };
  if (desiredRoles) next.roles = desiredRoles;
  buckets.push(next);
}

/**
 * Parse a query string, extracting structured filters.
 *
 * Supported filters:
 * - `from:john` / `by:john` → person filter (sender/author/owner role)
 * - `to:john` → person filter (recipient/attendee role)
 * - `with:john` → person filter (any role)
 * - `type:email` / `in:email` → document type filter
 * - `after:2026-01-01` / `since:last week` → date from filter
 * - `before:2026-01-01` / `until:2026-01-01` → date to filter
 * - `#tag` / `tag:work` → tag filter
 * - `source:gmail` → source filter (bare type, full source ID, provider type,
 *   or provider ID; expansion happens in `pipeline.expandSourcePatterns`)
 *
 * Remaining text becomes the search query.
 *
 * Filters that are still missing or weak — negation, `has:` / `is:`
 * content-and-state predicates, person-graph traversal (`cc:`, `bcc:`,
 * `mentions:`, `replies-to:`), `sort:`, boolean grouping, saved
 * aliases — are not yet supported. Add new tokens here only after
 * settling on a syntax.
 */
export function parseQuery(input: string): ParsedQuery {
  const filters: SearchFilters = {};
  const notices: SearchNotice[] = [];
  const tokens: ParsedFilterToken[] = [];
  let remaining = input;

  // Extract key:value filters (handles "key:value" and key:"multi word value")
  const kvPattern =
    /\b(from|by|to|with|type|in|after|since|before|until|tag|source):(?:"([^"]+)"|(\S+))/gi;
  remaining = remaining.replace(
    kvPattern,
    (token: string, key: string, quotedVal: string, plainVal: string) => {
      const value = quotedVal || plainVal;
      const lowerKey = key.toLowerCase();

      switch (lowerKey) {
        case "from":
        case "by":
          tokens.push({ filter: "person", token });
          pushPersonRef(filters, value, "from");
          break;
        case "to":
          tokens.push({ filter: "person", token });
          pushPersonRef(filters, value, "to");
          break;
        case "with":
          tokens.push({ filter: "person", token });
          pushPersonRef(filters, value, "with");
          break;
        case "type":
        case "in":
          tokens.push({ filter: "type", token });
          (filters.documentTypes ??= []).push(value);
          break;
        case "after":
        case "since": {
          tokens.push({ filter: "date", token });
          const date = resolveDate(value);
          if (date) filters.dateFrom = date;
          else notices.push(unparseableDateNotice(lowerKey, value));
          break;
        }
        case "before":
        case "until": {
          tokens.push({ filter: "date", token });
          const date = resolveDate(value);
          if (date) filters.dateTo = date;
          else notices.push(unparseableDateNotice(lowerKey, value));
          break;
        }
        case "tag":
          tokens.push({ filter: "tag", token });
          (filters.tags ??= []).push(value);
          break;
        case "source":
          tokens.push({ filter: "source", token });
          (filters.sourceIds ??= []).push(value);
          break;
      }

      return ""; // Remove matched filter from text
    },
  );

  // Extract hashtags (#tag)
  remaining = remaining.replace(/#(\w+)/g, (token: string, tag: string) => {
    tokens.push({ filter: "tag", token });
    (filters.tags ??= []).push(tag);
    return "";
  });

  // Clean up remaining text
  const text = remaining.replace(/\s+/g, " ").trim();

  return { text, filters, notices, tokens };
}

function unparseableDateNotice(key: string, value: string): SearchNotice {
  return {
    filter: "date",
    level: "error",
    token: `${key}:${value}`,
    message: `Couldn't parse "${value}" as a date — expected ISO YYYY-MM-DD or one of: today, yesterday, "last week", "last month", "last year". Filter dropped.`,
  };
}
