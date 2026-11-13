// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one reader of the identifiers a source filter matches people by: a
 * phone number, an email address, a mail domain.
 *
 * A filter matches a record when an identifier saved in the filter equals an
 * identifier of someone the record involves. What a person types or picks,
 * what a source lists as a chat's members and what a stored record holds all
 * pass through {@link canonicalFilterIdentifier} before they are compared, so
 * two spellings of one address can never be read by two different rules. Under
 * a "hide" filter a spelling read differently on the two sides would share
 * what the owner meant to withhold.
 */

import { domainToASCII, domainToUnicode } from "node:url";
import { lazyRequire } from "./lazy-require.js";
import { normalizeEmail } from "./people-utils.js";
import type { FilterIdentifier, FilterIdentifierType } from "@omnesis/types";

// Loaded on the first phone number read, as in `people-utils.ts`.
const phoneNumbers = lazyRequire<typeof import("libphonenumber-js")>(
  import.meta.url,
  "libphonenumber-js",
);

/** What a client shows when a typed identifier is refused. */
export const FILTER_IDENTIFIER_ERRORS: Record<FilterIdentifierType, string> = {
  phone: "Enter a valid phone number. Include the international country code.",
  email: "Enter an email address such as person@example.org.",
  domain: "Enter a domain such as example.org.",
};

/** Longest raw value read; anything longer names nothing a filter can match. */
const MAX_RAW_LENGTH = 512;
const UNICODE_DASHES = /[‐-―−﹘﹣－]/g;
const INTERNATIONAL_DIGITS = /^\+[1-9][0-9]{6,14}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** One mailbox provider under two names: an address at either is the same mailbox. */
const DOMAIN_ALIASES: Record<string, string> = { "googlemail.com": "gmail.com" };

function asciiDomain(raw: string): string {
  const value = raw.toLowerCase().replace(/\.+$/, "");
  // eslint-disable-next-line no-control-regex
  const ascii = /[^\x00-\x7f]/.test(value) ? domainToASCII(value) || value : value;
  return DOMAIN_ALIASES[ascii] ?? ascii;
}

function canonicalPhone(raw: string): string | null {
  let value = raw.normalize("NFKC").trim().replace(/^tel:/i, "");
  // "+44 (0)20 …" writes a trunk prefix some countries drop and others keep
  // after the country code; no single number can be read from it.
  if (/\(\s*0\s*\)/.test(value)) return null;
  value = value.replace(UNICODE_DASHES, "-").replace(/[\s().-]/g, "");
  // "00" is the international call prefix written where "+" was meant.
  if (/^00[1-9]/.test(value)) value = `+${value.slice(2)}`;
  // Only a full international number is read: no country is guessed for a
  // national one, and nothing but digits may follow the "+", so an extension
  // or a messaging address is refused rather than cut down to a number.
  if (!INTERNATIONAL_DIGITS.test(value)) return null;
  const parsed = phoneNumbers().parsePhoneNumberFromString(value);
  // "Possible" rather than "valid": the length fits the country's numbering
  // plan. A messaging service can hand out a number the published ranges do
  // not list yet, and an owner must still be able to hide it.
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number;
}

function canonicalEmail(raw: string): string | null {
  let value = raw.normalize("NFKC").trim();
  const angle = /<([^<>]*)>$/.exec(value);
  if (angle) value = angle[1]!;
  value = normalizeEmail(value.trim().replace(/^mailto:/i, ""));
  const at = value.indexOf("@");
  if (at <= 0) return null;
  value = `${value.slice(0, at)}@${asciiDomain(value.slice(at + 1))}`;
  return value.length <= 320 && EMAIL.test(value) ? value : null;
}

function canonicalDomain(raw: string): string | null {
  const value = asciiDomain(raw.normalize("NFKC").trim().replace(/^@/, ""));
  return value.length <= 253 && DOMAIN.test(value) ? value : null;
}

/**
 * The one spelling of an identifier that filters compare, or `null` when the
 * value names nothing a filter can match.
 *
 * - A phone number is international: `+` then the digits, as E.164. Spaces,
 *   dashes, dots, parentheses, a leading `00` and a `tel:` prefix are read. A
 *   number without a country code is not guessed at, and `+44 (0)…` is
 *   refused because it does not say which number it means.
 * - An email address folds case, the provider rules `normalizeEmail` knows,
 *   and an internationalized domain to its ASCII form. A display name around
 *   `<…>` and a `mailto:` prefix are read.
 * - A domain is one exact host name, never a suffix.
 *
 * Reading a canonical value again returns it unchanged.
 */
export function canonicalFilterIdentifier(
  type: FilterIdentifierType,
  raw: string,
): FilterIdentifier | null {
  if (typeof raw !== "string" || raw.length > MAX_RAW_LENGTH) return null;
  const value =
    type === "phone"
      ? canonicalPhone(raw)
      : type === "email"
        ? canonicalEmail(raw)
        : type === "domain"
          ? canonicalDomain(raw)
          : null;
  return value === null ? null : { type, value };
}

/**
 * Read an identifier a person typed: the canonical identifier, or the sentence
 * to show them when it cannot be read.
 */
export function readTypedFilterIdentifier(
  type: FilterIdentifierType,
  raw: string,
): { identifier: FilterIdentifier } | { error: string } {
  const identifier = canonicalFilterIdentifier(type, raw);
  return identifier ? { identifier } : { error: FILTER_IDENTIFIER_ERRORS[type] };
}

/** The mail domain of a canonical email address, as a domain filter spells it. */
export function filterIdentifierDomain(canonicalEmailValue: string): string | null {
  const at = canonicalEmailValue.lastIndexOf("@");
  return at < 0 ? null : canonicalDomain(canonicalEmailValue.slice(at + 1));
}

function domainSpellings(domain: string): string[] {
  const spellings = [domain];
  for (const [alias, canonical] of Object.entries(DOMAIN_ALIASES)) {
    if (canonical === domain) spellings.push(alias);
  }
  if (domain.split(".").some((label) => label.startsWith("xn--"))) {
    const unicode = domainToUnicode(domain);
    if (unicode && unicode !== domain) spellings.push(unicode);
  }
  return spellings;
}

/**
 * Every value a stored record may hold for the identity a canonical
 * identifier names. Used only where a saved filter is compiled into the check
 * applied to records, never to decide what is saved or shown.
 *
 * The first entry is the canonical value. The others are spellings of the same
 * mailbox or host that a record written by a source can carry: the second name
 * of a mailbox provider, and the Unicode form of an internationalized domain.
 * A phone number has one spelling; a rule for a messaging service that writes
 * a country's numbers differently from their standard form belongs here.
 */
export function storedSpellings(identifier: FilterIdentifier): string[] {
  if (identifier.type === "phone") return [identifier.value];
  if (identifier.type === "domain") return domainSpellings(identifier.value);
  const at = identifier.value.lastIndexOf("@");
  if (at < 0) return [identifier.value];
  const local = identifier.value.slice(0, at);
  return domainSpellings(identifier.value.slice(at + 1)).map((domain) => `${local}@${domain}`);
}
