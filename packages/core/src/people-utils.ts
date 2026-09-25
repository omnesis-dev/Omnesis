// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  parsePhoneNumberFromString,
  findPhoneNumbersInText,
  isSupportedCountry,
} from "libphonenumber-js";
import { VALID_TLDS } from "./valid-tlds.js";
import { personIdentifierIsReadable, personIdentifiers } from "./document.js";
import type { CountryCode } from "libphonenumber-js";
import type { PersonMention } from "./document.js";

/** Gmail domains where dots in the local part are ignored. */
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Local-part tokens that mark an email as a shared "no-reply" / firehose
 * address — many distinct real authors fanned through a single SMTP From.
 * Such addresses must never become a person-identity alias — they would
 * collapse every unrelated sender into one bucket person (the live
 * symptom: Google Docs comment notifications from three different
 * commenters all attributed to whichever real person matched first;
 * LinkedIn connection invites fanned through `invitations@linkedin.com`
 * accreting one name alias per inviter).
 *
 * Treated as a non-identifying email when the local part, split on
 * `.`, `-`, `_`, `+`, contains any of these tokens as an isolated chunk.
 *
 * The `reply` token covers the separated reply-routing forms in one rule:
 * `no-reply`, `do-not-reply`, `hit-reply` (LinkedIn), `auto-reply`, and a
 * bare `reply`. The joined forms (`noreply`, `donotreply`, …) have no
 * separator so they stay as explicit single-chunk tokens. `invitations`
 * covers notification-fanout senders like `invitations@linkedin.com`.
 */
const NOREPLY_TOKENS = new Set([
  "noreply",
  "noreplies",
  "donotreply",
  "donotreplies",
  "reply",
  "invitation",
  "invitations",
]);

/**
 * Return true when `email` is a shared no-reply / firehose-style address
 * that must not be used as a person-identity key. The check looks at the
 * local part only (the domain may be any). Examples that match:
 *
 *   noreply@x.com
 *   no-reply@x.com
 *   donotreply@x.com
 *   do-not-reply@x.com
 *   hit-reply@linkedin.com
 *   comments-noreply@docs.google.com
 *   notifications-noreply@linkedin.com
 *   invitations@linkedin.com
 *
 * Examples that do NOT match:
 *
 *   replytojamesbond@x.com           (no isolated "reply" chunk)
 *   noreplay@x.com                (typo, not a noreply pattern)
 *   jamesbond@noreply.example.com    (domain only — local part is identifying)
 *
 * Idempotent and safe on already-normalized input; the comparison is
 * lowercase and tolerates any of the `.`, `-`, `_`, `+` separators.
 */
export function isNonIdentifyingEmail(email: string): boolean {
  if (!email) return false;
  const at = email.indexOf("@");
  if (at === -1) return false;
  const local = email.slice(0, at).toLowerCase();
  if (!local) return false;
  const chunks = local.split(/[.\-_+]/).filter(Boolean);
  for (const chunk of chunks) {
    if (NOREPLY_TOKENS.has(chunk)) return true;
  }
  return false;
}

/**
 * Local-part tokens that mark an email as an automated / no-reply sender —
 * a machine that generated the message and expects no human reply
 * (transactional notifications, CI alerts, bounce daemons). Broader than
 * {@link NOREPLY_TOKENS}: it adds the notification-fanout local parts
 * (`notifications@`, `notify@`) and delivery-daemon addresses
 * (`mailer-daemon@`, `postmaster@`, `bounce@`) that carry no unsubscribe
 * signal but are still obviously machine mail. The `reply` token covers the
 * separator forms (`no-reply`, `do-not-reply`, `auto-reply`) in one rule; the
 * `daemon` token covers `mailer-daemon` once split on `-`.
 */
const AUTOMATED_SENDER_TOKENS = new Set([
  "noreply",
  "noreplies",
  "donotreply",
  "donotreplies",
  "reply",
  "notification",
  "notifications",
  "notify",
  "postmaster",
  "mailerdaemon",
  "daemon",
  "bounce",
  "bounces",
  "automated",
]);

/**
 * Return true when `email`'s local part signals an automated / no-reply sender
 * — a machine that generated the message and expects no human reply. Used by
 * mail-like sources to project the generic `automatedSender` document marker so
 * shared consumers (the background agent's wake heuristics) can skip obvious
 * machine notifications without re-deriving mail headers. Examples that match:
 *
 *   noreply@example.com
 *   no-reply@example.com
 *   notifications@example.org
 *   mailer-daemon@example.com
 *   postmaster@example.com
 *   bounces+abc@example.org
 *
 * Examples that do NOT match:
 *
 *   alice@example.com
 *   bob.smith@example.com
 *   sales@example.com            (a monitored role address, not a no-reply one)
 *
 * The check looks at the local part only (the domain may be any); the
 * comparison is lowercase and tolerates any of the `.`, `-`, `_`, `+`
 * separators, matching a token only as an isolated chunk.
 */
export function isAutomatedSenderAddress(email: string): boolean {
  if (!email) return false;
  const at = email.indexOf("@");
  if (at === -1) return false;
  const local = email.slice(0, at).toLowerCase();
  if (!local) return false;
  for (const chunk of local.split(/[.\-_+]/).filter(Boolean)) {
    if (AUTOMATED_SENDER_TOKENS.has(chunk)) return true;
  }
  return false;
}

/**
 * Normalize an email address: lowercase, trim, strip angle brackets.
 * For Gmail addresses, also strips dots from the local part and removes +suffix
 * (Gmail ignores both: a.b+tag@gmail.com = ab@gmail.com).
 */
export function normalizeEmail(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("<") && s.endsWith(">")) {
    s = s.slice(1, -1);
  }
  s = s.toLowerCase().trim();

  const atIdx = s.indexOf("@");
  if (atIdx === -1) return s;

  let local = s.slice(0, atIdx);
  const domain = s.slice(atIdx + 1);

  if (GMAIL_DOMAINS.has(domain)) {
    // Strip dots from local part
    local = local.replace(/\./g, "");
    // Strip +suffix
    const plusIdx = local.indexOf("+");
    if (plusIdx !== -1) local = local.slice(0, plusIdx);
  }

  return `${local}@${domain}`;
}

/**
 * RFC 2606 / RFC 6761 special-use TLDs. Reserved (so not in the IANA root zone)
 * but legitimate placeholders — not extraction artifacts — so `@host.example`
 * documentation/test fixtures and special-use addresses aren't treated as junk.
 */
const RESERVED_TLDS = new Set(["example", "test", "invalid", "localhost"]);

/**
 * True when an email's domain ends in a real, IANA-registered top-level domain
 * (or an RFC special-use TLD). The identity-boundary guard against extraction
 * artifacts: a parser (PDF text, email body) that glues trailing text onto an
 * address produces a domain whose final label is not a real TLD — a non-existent
 * "…vous" / "…comcourriel" suffix — and that must never become an identity key.
 *
 * Returns false when the string has no `@`, no domain, or no dot in the domain
 * (a bare `localhost`) — none of which is a usable public identity key. Only the
 * final domain label is checked; the rest of the domain is not validated, so a
 * mangled-but-real TLD (an Exchange-internal `…prod.outlook.com`) still passes.
 * Internationalized TLDs match in their punycode (`xn--…`) form. Safe on
 * already-normalized input.
 */
export function hasValidEmailTld(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  const dot = domain.lastIndexOf(".");
  if (dot < 0) return false;
  const tld = domain.slice(dot + 1);
  return VALID_TLDS.has(tld) || RESERVED_TLDS.has(tld);
}

/**
 * Pick a sensible default region for phone parsing. The collector configures
 * this once from its operating system; processes without collector context
 * fall back to their runtime locale, then US. Cached so we don't pay for
 * `Intl.DateTimeFormat().resolvedOptions()` per phone.
 */
let _systemRegionCache: CountryCode | undefined;
let _configuredPhoneRegion: CountryCode | undefined;

/** Configure the process-wide default used when a caller has no stronger region hint. */
export function setDefaultPhoneRegion(region: string | undefined): void {
  const upper = region?.trim().toUpperCase();
  _configuredPhoneRegion =
    upper && isSupportedCountry(upper as CountryCode) ? (upper as CountryCode) : undefined;
}

function getSystemRegion(): CountryCode {
  if (_configuredPhoneRegion) return _configuredPhoneRegion;
  if (_systemRegionCache) return _systemRegionCache;
  try {
    // Locale shape: "en-GB", "fr-FR", "en". The region is the segment
    // after the dash (if any).
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
    const region = locale.split("-")[1]?.toUpperCase();
    if (region && /^[A-Z]{2}$/.test(region)) {
      _systemRegionCache = region as CountryCode;
      return _systemRegionCache;
    }
  } catch {
    // Intl unavailable — fall through.
  }
  _systemRegionCache = "US" as CountryCode;
  return _systemRegionCache;
}

/**
 * Map common country names to ISO-2 country codes. Sources like Apple
 * Contacts store the country as a localized display name ("United Kingdom",
 * "France") rather than an ISO code, so callers that want to feed the
 * address country into `normalizePhone` as a region hint need to translate
 * first. Covers the ~30 most common destinations; unknown names return
 * undefined and the caller falls back to the system-locale chain.
 *
 * Match is case-insensitive on the trimmed input. We deliberately keep the
 * map small and hand-curated rather than pulling in a full i18n dataset —
 * the long tail is handled by the existing system-region/US fallbacks in
 * `normalizePhone`, and shipping a 200-country lookup with localized
 * variants would be far more maintenance for a small win.
 */
const COUNTRY_NAME_TO_ISO2: Record<string, CountryCode> = {
  // Europe
  france: "FR",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  germany: "DE",
  deutschland: "DE",
  spain: "ES",
  españa: "ES",
  italy: "IT",
  italia: "IT",
  netherlands: "NL",
  "the netherlands": "NL",
  holland: "NL",
  belgium: "BE",
  switzerland: "CH",
  ireland: "IE",
  portugal: "PT",
  austria: "AT",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  poland: "PL",
  russia: "RU",
  "russian federation": "RU",
  greece: "GR",
  "czech republic": "CZ",
  czechia: "CZ",
  hungary: "HU",
  romania: "RO",
  // North America
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  "u.s.a.": "US",
  "u.s.": "US",
  canada: "CA",
  mexico: "MX",
  méxico: "MX",
  // South America
  brazil: "BR",
  brasil: "BR",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  // Asia
  japan: "JP",
  china: "CN",
  india: "IN",
  "south korea": "KR",
  korea: "KR",
  "republic of korea": "KR",
  singapore: "SG",
  "hong kong": "HK",
  taiwan: "TW",
  thailand: "TH",
  vietnam: "VN",
  indonesia: "ID",
  philippines: "PH",
  malaysia: "MY",
  "united arab emirates": "AE",
  uae: "AE",
  israel: "IL",
  turkey: "TR",
  türkiye: "TR",
  // Oceania
  australia: "AU",
  "new zealand": "NZ",
  // Africa
  "south africa": "ZA",
  egypt: "EG",
  nigeria: "NG",
  morocco: "MA",
  kenya: "KE",
};

/**
 * Translate a country display name (as found on a contact's address card)
 * into an ISO-2 region code. Returns undefined for unknown names; the
 * caller should pass `undefined` through to `normalizePhone` and rely on
 * the existing system-locale fallback.
 *
 * Already-ISO-2 inputs (e.g. Google's `addresses[].countryCode` which is
 * sometimes populated directly) round-trip: a 2-letter all-alpha string is
 * returned uppercased without a map lookup.
 */
export function countryNameToISO2(name: string | undefined): CountryCode | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  // Check the explicit map first — handles common synonyms ("UK" → "GB")
  // that would otherwise be mis-treated as a literal ISO-2 by the
  // two-letter short-circuit below.
  const mapped = COUNTRY_NAME_TO_ISO2[trimmed.toLowerCase()];
  if (mapped) return mapped;
  // Already an ISO-2 code? Round-trip uppercased.
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const upper = trimmed.toUpperCase() as CountryCode;
    return isSupportedCountry(upper) ? upper : undefined;
  }
  return undefined;
}

/**
 * Normalize a phone number to E.164 format. Tries region hints in order,
 * then the system locale's region, then "US" as a last resort.
 *
 * @param raw — the raw phone string (national or international format).
 * @param regionOrHints — either a single `CountryCode` (back-compat with
 *   the original two-arg signature) or an array of region hints to try
 *   in order. Useful for sources that can infer a likely region from
 *   context (e.g. contact's address country) without committing to one.
 *
 * Returns null if no parse strategy yields a valid number — the caller
 * decides whether to keep the raw string or drop it. Strategies:
 *   1. Already-international (`+...`) — parsed without a region hint.
 *   2. Each region hint in order.
 *   3. System locale's region.
 *   4. "US" fallback.
 */
export function normalizePhone(
  raw: string,
  regionOrHints?: CountryCode | CountryCode[],
): string | null {
  let cleaned = raw.trim();
  if (!cleaned) return null;

  // Pre-step: rewrite the "00" international gateway prefix (E.123) to "+".
  // Many regions (most of Europe, Russia) use "00" as the IDD prefix when
  // dialing internationally, so users save contacts as e.g.
  // "00 33 6 39 98 00 33" or "00447700000000". libphonenumber doesn't
  // strip a leading "00" the way it strips a leading "+", so without this
  // pre-pass these numbers fall through to region-hint parsing and get
  // mis-attributed (or rejected entirely).
  //
  // We only rewrite when "00" is followed (after optional whitespace) by a
  // digit — otherwise we'd corrupt national-format numbers that legitimately
  // start with one "0" (e.g. German "030 12345" or French "06 39 98 00 33"),
  // which only have a single leading zero. "00" is unambiguously the
  // international gateway code in E.123.
  const ooMatch = cleaned.match(/^00\s?(\d.*)$/);
  if (ooMatch) {
    cleaned = "+" + ooMatch[1];
  }

  // Strategy 1: already-international. Skip hints since `+` prefix
  // disambiguates the country.
  if (cleaned.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(cleaned);
    if (parsed && parsed.isValid()) {
      return parsed.format("E.164");
    }
  }

  // Build the region candidate list: hints first, then system locale,
  // then "US". Dedupe so we don't try "US" twice on a US-locale machine.
  const hints = Array.isArray(regionOrHints) ? regionOrHints : regionOrHints ? [regionOrHints] : [];
  const seen = new Set<string>();
  const regions: CountryCode[] = [];
  for (const r of [...hints, getSystemRegion(), "US" as CountryCode]) {
    if (!r) continue;
    const upper = r.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    regions.push(upper as CountryCode);
  }

  for (const region of regions) {
    const parsed = parsePhoneNumberFromString(cleaned, region);
    if (parsed && parsed.isValid()) {
      return parsed.format("E.164");
    }
  }
  return null;
}

/**
 * Heuristic: does `s` look like a phone number (only digits, optional
 * leading `+`, spaces, dashes, parens)? Used by sources to avoid
 * accidentally storing a phone-shaped handle as a `PersonMention.name`,
 * which then leaks into `person_aliases` typed as `name` and breaks
 * cross-source phone matching.
 */
export function looksLikePhone(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  // Must contain at least one digit and only "phone-shaped" characters.
  if (!/\d/.test(trimmed)) return false;
  return /^\+?[\d\s\-().]+$/.test(trimmed);
}

/**
 * True when `name` is a machine-generated placeholder headline rather than a
 * human-provided name: phone-shaped, a bare email address, or the literal
 * "Unknown" sentinel. These are exactly the values the people resolver falls
 * back to for `canonical_name` when a person is first seen without a trusted
 * name (`trustedName(mention) ?? mention.emails[0] ?? mention.phones[0] ??
 * "Unknown"`).
 *
 * The predicate lets a later trusted name self-heal such a headline: only a
 * placeholder may be overwritten, so a real name is never clobbered. The
 * email-shape branch (`@` with no internal space) mirrors `cleanPersonName`'s
 * own rejection of bare addresses as display names, keeping the two notions
 * consistent.
 */
export function isPlaceholderPersonName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (trimmed === "Unknown") return true;
  if (looksLikePhone(trimmed)) return true;
  if (trimmed.includes("@") && !trimmed.includes(" ")) return true;
  return false;
}

/**
 * Strip a single layer of surrounding quotes (`"`, `'`, `` ` ``) from a string.
 * Idempotent; safe to call on already-clean input.
 */
function stripSurroundingQuotes(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^(['"`])(.*)\1$/);
  return m ? m[2].trim() : trimmed;
}

/**
 * Parse an RFC 5322-style email header into name and email.
 * Handles formats like:
 *   "John Smith" <john@example.com>
 *   'John Smith' <john@example.com>
 *   John Smith <john@example.com>
 *   John<john@example.com>           (no space before <)
 *   James Bond <>                (name with empty address)
 *   john@example.com (John Smith)
 *   john@example.com
 *   <john@example.com>
 *
 * Either `name` or `email` may be undefined — callers should treat both as
 * optional. Malformed inputs yield a name-only record rather than a fake
 * email (the old behavior shoved the whole string into the email field,
 * polluting the person_aliases table with strings like `james bond <>`).
 */
export function parseEmailHeader(raw: string): { name?: string; email?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  // Format: `Name <email>` or `"Name" <email>` or `Name<email>` (no space).
  // The `\s*` (not `\s+`) before `<` matches gmail quirks that emit
  // `"sender"<addr>` with no whitespace. The inner `[^>]*` (not `[^>]+`)
  // allows the empty address form `Name <>` — we treat that as name-only.
  const angleMatch = trimmed.match(/^(.+?)\s*<([^>]*)>$/);
  if (angleMatch) {
    const name = stripSurroundingQuotes(angleMatch[1].trim());
    const inner = angleMatch[2].trim();
    const email = inner.includes("@") ? normalizeEmail(inner) : undefined;
    return { name: name || undefined, email };
  }

  // Format: <email>
  const bareAngleMatch = trimmed.match(/^<([^>]+)>$/);
  if (bareAngleMatch) {
    return { email: normalizeEmail(bareAngleMatch[1]) };
  }

  // Format: email (Name)
  const parenMatch = trimmed.match(/^([^\s(]+@[^\s(]+)\s*\((.+?)\)$/);
  if (parenMatch) {
    return { name: parenMatch[2].trim(), email: normalizeEmail(parenMatch[1]) };
  }

  // Bare email
  if (trimmed.includes("@")) {
    return { email: normalizeEmail(trimmed) };
  }

  // Just a name, no email — return name only, no synthetic email alias.
  return { name: trimmed };
}

/**
 * Normalize a display name: strip surrounding quotes, collapse whitespace,
 * and drop values that are really an email address (contain `@`, no space).
 * Safe to call at ingest time AND at DB insert time — idempotent.
 */
export function cleanPersonName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const stripped = stripSurroundingQuotes(name).replace(/\s+/g, " ").trim();
  if (!stripped) return undefined;
  if (stripped.includes("@") && !stripped.includes(" ")) return undefined;
  return stripped;
}

/**
 * Split a comma-separated email list respecting quoted names.
 * e.g. '"Smith, John" <j@ex.com>, other@ex.com' → ['"Smith, John" <j@ex.com>', 'other@ex.com']
 */
export function splitEmailList(raw: string): string[] {
  const results: string[] = [];
  let current = "";
  let inQuotes = false;
  let depth = 0; // angle bracket depth

  for (const ch of raw) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "<" && !inQuotes) {
      depth++;
      current += ch;
    } else if (ch === ">" && !inQuotes) {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === "," && !inQuotes && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) results.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed) results.push(trimmed);

  return results;
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

/**
 * Strip Turndown-style markdown backslash escapes from a text block.
 *
 * The Gmail / Outlook / Drive normalizers convert HTML bodies to markdown
 * via Turndown, which prefixes a backslash to any markdown-meaningful
 * punctuation (the canonical set:
 * `\` `` ` `` `*` `_` `{` `}` `[` `]` `(` `)` `#` `+` `-` `!` `.` `<` `>` `~` `|`).
 * That escaping is fine for *display* but breaks downstream regex
 * extraction — `lopez_c@example.org` arrives as `lopez\_c@example.org` and the
 * email regex (which doesn't consider `\` a local-part char) loses
 * everything before the underscore, yielding the bogus `_c@example.org`.
 *
 * This helper is pre-applied inside `extractEmailsFromText` and
 * `extractPhonesFromText` so callers don't have to think about it. It is
 * NOT applied to URL extraction — Turndown wraps URLs as
 * `[text](url)` markdown links rather than escaping characters in-flow,
 * so the URL extractor sidesteps this problem by design.
 */
function unescapeMarkdownPunct(text: string): string {
  return text.replace(/\\([\\`*_{}\[\]()#+\-!.<>~|])/g, "$1");
}

/**
 * Cut a glued-on word from the end of a matched email's domain.
 *
 * Text extracted from form-style PDFs and HTML→markdown email bodies often
 * concatenates an address directly with the following word, with no
 * whitespace — e.g. `jlopez@example.comWhat is their email address?` or
 * `alerts@example.comInvoice`. The email regex then greedily swallows the
 * word into the TLD, yielding `example.comwhat`. A real domain is
 * effectively lowercase — DNS is case-insensitive and nobody writes
 * `example.comX` — so an internal lowercase→uppercase transition in the
 * domain marks the word-join, and we cut there.
 *
 * The cut is taken only when the kept portion is still a complete domain
 * ending in a TLD-shaped label (`.` + 2–24 lowercase letters). Without that
 * guard the heuristic would also fire on legitimately mixed-case domains
 * whose uppercase falls before any TLD — `Maya.Reeves@bookHarbor.com`
 * (domain `bookharbor.com`) would be butchered to `…@book`. Only the domain
 * is inspected; the local part legitimately carries mixed case
 * (`John.Smith@example.com`) and is left untouched.
 */
function trimGluedDomainSuffix(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) return email;
  const domain = email.slice(at + 1);
  const boundary = domain.match(/[a-z0-9][A-Z]/);
  if (!boundary || boundary.index === undefined) return email;
  const cut = email.slice(0, at + 1 + boundary.index + 1);
  return /\.[a-z]{2,24}$/.test(cut.slice(at + 1)) ? cut : email;
}

function extractEmailsFromUnescaped(unescaped: string): string[] {
  const matches = unescaped.match(EMAIL_REGEX);
  if (!matches) return [];

  // Domains that look like emails but aren't (WhatsApp JIDs, etc.)
  const excludedDomains = ["s.whatsapp.net", "g.us", "broadcast", "lid"];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of matches) {
    const m = trimGluedDomainSuffix(raw);
    const domain = m.split("@")[1]?.toLowerCase();
    if (domain && excludedDomains.some((d) => domain === d)) continue;
    const normalized = normalizeEmail(m);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function extractPhonesFromUnescaped(unescaped: string, defaultCountry: CountryCode): string[] {
  const numbers = findPhoneNumbersInText(unescaped, defaultCountry);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const num of numbers) {
    if (num.number.isValid()) {
      const e164 = num.number.format("E.164");
      if (!seen.has(e164)) {
        seen.add(e164);
        result.push(e164);
      }
    }
  }

  return result;
}

/**
 * Extract all email addresses from free text.
 * Returns normalized, unique emails.
 */
export function extractEmailsFromText(text: string): string[] {
  return extractEmailsFromUnescaped(unescapeMarkdownPunct(text));
}

/**
 * Extract all phone numbers from free text using libphonenumber-js.
 * Returns normalized E.164 unique phone numbers.
 *
 * Same Turndown-unescape pre-pass as `extractEmailsFromText` — Turndown
 * occasionally escapes `+` (and other phone-relevant punctuation) when
 * converting HTML to markdown, which can confuse libphonenumber's
 * tokenizer.
 */
export function extractPhonesFromText(text: string, defaultCountry?: CountryCode): string[] {
  return extractPhonesFromUnescaped(
    unescapeMarkdownPunct(text),
    defaultCountry ?? getSystemRegion(),
  );
}

/**
 * One-pass extractor for callers that need both emails and phones from
 * the same text. Pre-fix, `derivePeopleForAttachment` ran the
 * Turndown-unescape pass twice (once inside each extractor); for a
 * 512KB attachment that meant ~1MB of throwaway transformed text per
 * doc per ingest. Sharing the unescape collapses that to one pass.
 */
export function extractEmailsAndPhonesFromText(
  text: string,
  defaultCountry?: CountryCode,
): { emails: string[]; phones: string[] } {
  const unescaped = unescapeMarkdownPunct(text);
  return {
    emails: extractEmailsFromUnescaped(unescaped),
    phones: extractPhonesFromUnescaped(unescaped, defaultCountry ?? getSystemRegion()),
  };
}

/**
 * Derive an author display string from a people array.
 * Finds the first person with a "sender", "author", or "owner" role
 * and returns their name or first email.
 */
export function deriveAuthor(people?: PersonMention[]): string | undefined {
  if (!people) return undefined;
  const authorRoles = ["sender", "author", "owner"];
  const person = people.find((p) => authorRoles.includes(p.role));
  if (!person) return undefined;
  if (person.name) return person.name;
  // The first identifier a reader would recognise, in the kind order the
  // contract declares — so an author named only by the newer spelling still
  // has a byline, and one named only by a platform id still has none.
  const readable = personIdentifiers(person).find(({ kind }) => personIdentifierIsReadable(kind));
  return readable?.value;
}

// ─── Platform identifiers ───────────────────────────────────────────────────

/**
 * A platform identifier, written so it says which platform issued it.
 *
 * The `lid` alias type holds identifiers that are unique on one platform and
 * meaningless off it — a GitHub login, a Strava athlete number, a WhatsApp
 * linked-identity id. Two of the three producers already prefixed theirs and
 * one did not, so the type held a mixture of `github:jlopez` and bare digits,
 * and nothing downstream could tell them apart.
 *
 * Two things follow from that, and the first is live. A guard written for
 * WhatsApp — whose identifiers are re-mappable and can attach to the wrong
 * phone — fires on any `lid`, so it taxes GitHub and Strava, whose identifiers
 * are stable. And an automatic merge joins two people who share a `lid`
 * without review, so an unprefixed identifier from a fourth platform that
 * happened to collide with an unprefixed one from a third would fuse two
 * people silently.
 *
 * The prefix is a value convention rather than a column because the alias type
 * is what merge rules and candidates are keyed and sorted by: renaming it
 * would re-order stored pairs, and a stored pair that no longer matches the key
 * a detector computes is an operator's permanent veto quietly ceasing to veto.
 */
export function formatLid(platform: string, localId: string): string {
  return `${platform}:${localId}`;
}

/** The platform half and the identifier half, or `null` for an unprefixed value. */
export function parseLid(value: string): { platform: string; localId: string } | null {
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) return null;
  return { platform: value.slice(0, colon), localId: value.slice(colon + 1) };
}

/**
 * Whether this identifier can be re-pointed at a different person by the
 * platform that issued it.
 *
 * True only for WhatsApp today. Its linked-identity ids are a mapping the
 * platform maintains rather than a name a person holds, so one can come to
 * refer to a different phone — which is the whole reason the resolver holds
 * back new identifiers when a mention carrying one disagrees about the name.
 * A GitHub login and a Strava athlete number are not that, and were only
 * treated as such because nothing could tell the three apart.
 */
export function isUnstableLid(value: string): boolean {
  return parseLid(value)?.platform === WHATSAPP_LID_PLATFORM;
}

/** The platform half WhatsApp's linked-identity ids are written under. */
export const WHATSAPP_LID_PLATFORM = "whatsapp";

/**
 * A platform identifier as it is stored, whichever way it arrived.
 *
 * A collector that has not been upgraded still sends WhatsApp's linked-identity
 * ids unprefixed, and an operator upgrades the gateway first — it holds the
 * data. Left as it arrived, such a value matches none of the prefixed rows the
 * migration rewrote: the mention makes a second person, the bare value is
 * written as a second alias, and the guard that exists for exactly this
 * platform does not fire, because it can no longer tell what platform the
 * value came from.
 *
 * The rule is the migration's own, which is what makes it sound rather than a
 * guess: a `lid` that is all digits carries no platform, and WhatsApp is the
 * only producer that ever emitted one — which is the premise the migration
 * rewrote every stored row on.
 */
export function normalizeLid(value: string): string {
  const bare = value.length > 0 && /^[0-9]+$/.test(value);
  return bare ? formatLid(WHATSAPP_LID_PLATFORM, value) : value;
}
