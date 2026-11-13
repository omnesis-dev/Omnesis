// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { domainToASCII } from "node:url";
import { normalizeEmail } from "@omnesis/core";
import type { ScopeIdentifier } from "@omnesis/types";

const UNICODE_DASHES = /[‐-―−﹘﹣－]/g;
const PHONE = /^\+[1-9][0-9]{6,14}$/;
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
  return PHONE.test(value) ? value : null;
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
 * The one spelling of an identifier that source filters compare. A filter
 * matches a document when a saved identifier equals a stored fact exactly, so
 * the value a person types or picks, the value a source declares and the value
 * the gateway stores all pass through here; two spellings of one address that
 * were canonicalized by different rules would silently never match, which
 * under a "hide" filter shares what the owner meant to withhold.
 *
 * Phone numbers are international (`+` then 7 to 15 digits): separators and a
 * leading `00` are read, a number with no country code is not guessed at.
 * Email addresses fold case, the provider aliases `normalizeEmail` knows, and
 * an internationalized domain to its ASCII form. A domain is one exact host
 * name, never a suffix. Null means the value names nothing a filter can match.
 */
export function canonicalScopeIdentifier(
  type: ScopeIdentifier["type"],
  raw: string,
): ScopeIdentifier | null {
  if (raw.length > 512) return null;
  const value =
    type === "phone"
      ? canonicalPhone(raw)
      : type === "email"
        ? canonicalEmail(raw)
        : canonicalDomain(raw);
  return value === null ? null : { type, value };
}
