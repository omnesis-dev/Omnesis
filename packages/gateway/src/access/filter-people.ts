// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Who a stored record involves, as a person filter compares it.
 *
 * A record's `people` hold whatever the source wrote, in either stored form:
 * the per-kind arrays (`emails`, `phones`) and the `identifiers` list. Each
 * identifier is read by the same reader as an identifier typed into a filter
 * (`canonicalFilterIdentifier`), so the two sides of a comparison are always
 * spelled by one rule.
 *
 * The answer is either the set of people-keys the record involves, or
 * "unknown": the record cannot be said to involve nobody else. Unknown is
 * never an empty set. A filter treats an unknown record as hidden whatever it
 * says, because under "hide this person" a record whose people cannot be read
 * may be one of theirs.
 *
 * The readers are exposed to SQL as two functions, registered per connection
 * by {@link registerFilterSqlFunctions}. A statement compiled by
 * `filter-sql.ts` on a connection without them fails to prepare; it never
 * runs without the check.
 */

import { canonicalFilterIdentifier, filterIdentifierDomain } from "@omnesis/core";
import {
  personIdentifiers,
  type FilterIdentifierType,
  type PersonFilterSpec,
} from "@omnesis/types";
import type { Db } from "../data/types.js";

/** Identifiers one mention may carry before the record counts as unknown. */
export const FILTER_MENTION_IDENTIFIER_LIMIT = 16;

/** How a record's people are read, derived from the source's declaration. */
export interface FilterPeopleSpec {
  /** Person roles that count as involvement. */
  roles: readonly string[];
  /** Identifier kinds the source declares. */
  kinds: readonly FilterIdentifierType[];
  /** A `people` array of this length may have been cut short. */
  maxPeople: number | null;
  /**
   * Whether a record must itself name someone. False when the people of a
   * record also come from the member list of the chat it belongs to.
   */
  requireParticipant: boolean;
}

export function filterPeopleSpec(filter: PersonFilterSpec): FilterPeopleSpec {
  return {
    roles: [...filter.roles],
    kinds: [...filter.identifiers],
    maxPeople: filter.maxPeople ?? null,
    requireParticipant: filter.membersOf === undefined,
  };
}

/** The key a saved identifier and a stored one are compared by. */
export function filterPersonKey(type: FilterIdentifierType, value: string): string {
  return `${type}:${value}`;
}

const CANONICAL_CACHE_LIMIT = 50_000;
const canonicalCache = new Map<string, string | null>();

/** `canonicalFilterIdentifier`, remembered: a corpus names the same few people on most of its records. */
function canonicalValue(type: "phone" | "email", raw: string): string | null {
  const cacheKey = `${type}\n${raw}`;
  const cached = canonicalCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const value = canonicalFilterIdentifier(type, raw)?.value ?? null;
  if (canonicalCache.size >= CANONICAL_CACHE_LIMIT) canonicalCache.clear();
  canonicalCache.set(cacheKey, value);
  return value;
}

/**
 * The keys of one identifier of a declared kind: itself, and for an email
 * address its domain when the source declares domains. `null` when the value
 * cannot be read.
 */
function identifierKeys(
  type: "phone" | "email",
  raw: string,
  kinds: readonly FilterIdentifierType[],
): string[] | null {
  const value = canonicalValue(type, raw);
  if (value === null) return null;
  const keys = [filterPersonKey(type, value)];
  if (type === "email" && kinds.includes("domain")) {
    const domain = filterIdentifierDomain(value);
    if (domain) keys.push(filterPersonKey("domain", domain));
  }
  return keys;
}

/**
 * The people-keys a record involves, or `null` when that is not known.
 *
 * Unknown when `people` is not a list, when the list is as long as the
 * source's cap (it may have been cut), when an entry is not a mention, when a
 * mention in a declared role carries an identifier of a declared kind that
 * cannot be read, carries none at all, or carries more than
 * {@link FILTER_MENTION_IDENTIFIER_LIMIT}, and when the record names nobody
 * although the spec requires it to.
 *
 * A mention of the account's owner with no identifier is passed over: the
 * owner is in every record of their own account, so not being able to address
 * them leaves nothing unknown about who else is there.
 */
export function projectFilterPeople(people: unknown, spec: FilterPeopleSpec): string[] | null {
  if (!Array.isArray(people)) return null;
  if (spec.maxPeople !== null && people.length >= spec.maxPeople) return null;
  const keys = new Set<string>();
  let participants = 0;
  for (const mention of people as unknown[]) {
    if (typeof mention !== "object" || mention === null || Array.isArray(mention)) return null;
    const { role, isSelf } = mention as { role?: unknown; isSelf?: unknown };
    if (typeof role !== "string") return null;
    if (role === "mentioned" || !spec.roles.includes(role)) continue;
    let raw;
    try {
      raw = personIdentifiers(mention);
    } catch {
      return null;
    }
    let readable = 0;
    for (const identifier of raw) {
      if (typeof identifier !== "object" || identifier === null) return null;
      const { kind, value } = identifier as { kind?: unknown; value?: unknown };
      if (kind !== "phone" && kind !== "email") continue;
      if (!spec.kinds.includes(kind)) continue;
      if (typeof value !== "string") return null;
      const found = identifierKeys(kind, value, spec.kinds);
      if (found === null) return null;
      readable++;
      if (readable > FILTER_MENTION_IDENTIFIER_LIMIT) return null;
      for (const key of found) keys.add(key);
    }
    if (readable === 0) {
      if (isSelf === true) continue;
      return null;
    }
    participants++;
  }
  if (participants === 0 && spec.requireParticipant) return null;
  return [...keys];
}

/**
 * The people-keys of one member of a published list, or `null` when the
 * member cannot be read. A member of a kind the source does not declare has
 * no keys and is not an error: it is not something a filter on this source
 * can name.
 */
export function projectFilterMember(
  type: unknown,
  value: unknown,
  kinds: readonly FilterIdentifierType[],
): string[] | null {
  if (typeof type !== "string" || typeof value !== "string") return null;
  if (type === "domain") {
    if (!kinds.includes("domain")) return [];
    const domain = canonicalFilterIdentifier("domain", value)?.value;
    return domain ? [filterPersonKey("domain", domain)] : null;
  }
  if (type !== "phone" && type !== "email") return null;
  if (!kinds.includes(type)) return [];
  return identifierKeys(type, value, kinds);
}

/** SQL name of {@link projectFilterPeople}: `(people JSON text, spec JSON text)` → JSON array text or NULL. */
export const FILTER_PEOPLE_SQL_FUNCTION = "omnesis_filter_people";
/** SQL name of {@link projectFilterMember}: `(type, value, kinds JSON text)` → JSON array text or NULL. */
export const FILTER_MEMBER_SQL_FUNCTION = "omnesis_filter_member_keys";

const registered = new WeakSet<Db>();

/**
 * Make the two readers callable from SQL on this connection. Idempotent.
 *
 * Every connection that runs a predicate compiled by `filter-sql.ts` needs
 * it: the gateway's own handle, each read worker's, and each search worker's
 * handle on the index database.
 */
export function registerFilterSqlFunctions(db: Db): void {
  if (registered.has(db)) return;
  const specs = new Map<string, FilterPeopleSpec | null>();
  const readSpec = (text: unknown): FilterPeopleSpec | null => {
    if (typeof text !== "string") return null;
    let spec = specs.get(text);
    if (spec === undefined) {
      spec = parsePeopleSpec(text);
      if (specs.size >= 64) specs.clear();
      specs.set(text, spec);
    }
    return spec;
  };
  // A verdict asks for a record's people twice in a row, once to learn
  // whether they are known and once to match them; the second call is served
  // from the first.
  let last: { people: string; spec: string; result: string | null } | undefined;
  db.function(
    FILTER_PEOPLE_SQL_FUNCTION,
    { deterministic: true },
    (people: unknown, specText: unknown): string | null => {
      if (typeof people !== "string" || typeof specText !== "string") return null;
      if (last && last.people === people && last.spec === specText) return last.result;
      const spec = readSpec(specText);
      let result: string | null = null;
      if (spec) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(people);
        } catch {
          parsed = undefined;
        }
        const keys = projectFilterPeople(parsed, spec);
        result = keys === null ? null : JSON.stringify(keys);
      }
      last = { people, spec: specText, result };
      return result;
    },
  );
  const kindSets = new Map<string, FilterIdentifierType[] | null>();
  db.function(
    FILTER_MEMBER_SQL_FUNCTION,
    { deterministic: true },
    (type: unknown, value: unknown, kindsText: unknown): string | null => {
      if (typeof kindsText !== "string") return null;
      let kinds = kindSets.get(kindsText);
      if (kinds === undefined) {
        kinds = parseKinds(kindsText);
        if (kindSets.size >= 64) kindSets.clear();
        kindSets.set(kindsText, kinds);
      }
      if (!kinds) return null;
      const keys = projectFilterMember(type, value, kinds);
      return keys === null ? null : JSON.stringify(keys);
    },
  );
  registered.add(db);
}

/** The text {@link FILTER_PEOPLE_SQL_FUNCTION} takes as its second argument. */
export function encodeFilterPeopleSpec(spec: FilterPeopleSpec): string {
  return JSON.stringify({
    roles: spec.roles,
    kinds: spec.kinds,
    maxPeople: spec.maxPeople,
    requireParticipant: spec.requireParticipant,
  });
}

function parseKinds(text: string): FilterIdentifierType[] | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return null;
    return value.filter(
      (kind): kind is FilterIdentifierType =>
        kind === "phone" || kind === "email" || kind === "domain",
    );
  } catch {
    return null;
  }
}

function parsePeopleSpec(text: string): FilterPeopleSpec | null {
  try {
    const value = JSON.parse(text) as Partial<Record<keyof FilterPeopleSpec, unknown>>;
    if (typeof value !== "object" || value === null) return null;
    const kinds = parseKinds(JSON.stringify(value.kinds ?? null));
    if (!kinds || !Array.isArray(value.roles)) return null;
    if (value.maxPeople !== null && typeof value.maxPeople !== "number") return null;
    return {
      roles: value.roles.filter((role): role is string => typeof role === "string"),
      kinds,
      maxPeople: value.maxPeople,
      // Anything but an explicit `false` requires a participant: the stricter reading.
      requireParticipant: value.requireParticipant !== false,
    };
  } catch {
    return null;
  }
}
