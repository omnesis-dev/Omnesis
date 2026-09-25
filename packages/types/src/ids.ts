// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Branded string types for type-safe ID handling.
 *
 * The TypeScript compiler treats each brand as a distinct type so a
 * `SourceId` can't accidentally flow into a slot expecting a `ProviderId`.
 * At runtime they are plain strings — but the constructors here are NOT
 * zero-cost casts: each one validates shape, length, and character set,
 * and throws `BrandedIdError` on invalid input. The `tryX` parallel
 * (`trySourceId`, `tryProviderId`, …) returns `null` instead of throwing,
 * for parse-from-untrusted contexts (DB-row remap, HTTP-body remap).
 *
 * The pre-existing `as SourceId` / `as ProviderId` cast pattern bypasses
 * validation by construction and should be replaced with a constructor
 * call. The bundle that introduced this validator sweeps
 * the existing cast sites; new code must not reintroduce them.
 */

import type { Brand } from "./brand.js";

/** Base name of a provider, e.g. "google", "apple", "whatsapp" */
export type ProviderType = Brand<string, "ProviderType">;

/** Full provider identifier, e.g. "google:user@gmail.com", "system" */
export type ProviderId = Brand<string, "ProviderId">;

/** Base name of a source, e.g. "gmail", "apple-notes", "things" */
export type SourceType = Brand<string, "SourceType">;

/** Full source identifier, e.g. "gmail:user@gmail.com", "things" */
export type SourceId = Brand<string, "SourceId">;

/** Account identifier, e.g. "user@gmail.com", "+447700000000", "local" */
export type AccountId = Brand<string, "AccountId">;

/**
 * Thrown by every branded-ID constructor when the input fails validation.
 * The `kind` field names which brand rejected the input so error-reporting
 * code can format a useful message without scraping the message string.
 */
export class BrandedIdError extends Error {
  constructor(
    public readonly kind:
      | "ProviderType"
      | "ProviderId"
      | "SourceType"
      | "SourceId"
      | "AccountId"
      | "DeviceId"
      | "TokenId"
      | "Scope",
    public readonly input: string,
    public readonly reason: string,
  ) {
    super(`invalid ${kind}: ${reason} (input=${JSON.stringify(input.slice(0, 80))})`);
    this.name = "BrandedIdError";
  }
}

// ── Validators ──────────────────────────────────────────────────────────────
//
// `Type` brands (ProviderType, SourceType): lowercase ASCII alphanumeric +
// hyphens, must start with an alphanumeric. Length 1–64. The "no leading
// hyphen" rule mirrors the file-system convention that source-type strings
// double as directory / package names downstream.
const TYPE_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

// `AccountId`: a printable run with no whitespace and no colons. Colons
// are reserved as the `<type>:<account>` separator in {Source,Provider}Id;
// allowing them in the account half would make `parseSourceId` ambiguous.
// Length 1–256. Control characters (\u0000-\u001f, \u007f) are forbidden so
// a stray newline can't sneak past JSON.parse and into a DB row. Path
// separators (`/`, `\`) are forbidden because account IDs double as on-disk
// credential directory names (`<configDir>/<provider>/<accountId>/…`); a
// path-shaped account ID must not redirect credential reads/writes outside
// its provider directory. The standalone traversal segments `.` and `..`
// pass the char-class test, so they are rejected in `isValidAccountId`.
const ACCOUNT_ID_REGEX = /^[^\s:/\\\u0000-\u001f\u007f]{1,256}$/;

function isValidAccountId(s: string): boolean {
  return ACCOUNT_ID_REGEX.test(s) && s !== "." && s !== "..";
}

// `{Source,Provider}Id`: either bare `<type>` (matches TYPE_REGEX) OR
// `<type>:<account>` with at most one colon. Encoded as a single regex
// for speed — the overall length cap is implied by the two halves.
const COMPOUND_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}(?::[^\s:/\\\u0000-\u001f\u007f]{1,256})?$/;

function validateString(input: unknown, kind: BrandedIdError["kind"]): string {
  if (typeof input !== "string") {
    throw new BrandedIdError(kind, String(input), "must be a string");
  }
  return input;
}

// ── Constructors (throwing) ─────────────────────────────────────────────────

export function ProviderType(s: string): ProviderType {
  const v = validateString(s, "ProviderType");
  if (!TYPE_REGEX.test(v)) {
    throw new BrandedIdError(
      "ProviderType",
      v,
      "must be 1–64 lowercase a-z/0-9/-, starting with a-z/0-9",
    );
  }
  return v as ProviderType;
}

export function SourceType(s: string): SourceType {
  const v = validateString(s, "SourceType");
  if (!TYPE_REGEX.test(v)) {
    throw new BrandedIdError(
      "SourceType",
      v,
      "must be 1–64 lowercase a-z/0-9/-, starting with a-z/0-9",
    );
  }
  return v as SourceType;
}

export function AccountId(s: string): AccountId {
  const v = validateString(s, "AccountId");
  if (!isValidAccountId(v)) {
    throw new BrandedIdError(
      "AccountId",
      v,
      "must be 1–256 chars: no whitespace, colons, control chars, or path separators, and not '.'/'..'",
    );
  }
  return v as AccountId;
}

export function ProviderId(s: string): ProviderId {
  const v = validateString(s, "ProviderId");
  if (!COMPOUND_ID_REGEX.test(v)) {
    throw new BrandedIdError(
      "ProviderId",
      v,
      "must be `<type>` or `<type>:<account>` with at most one colon",
    );
  }
  return v as ProviderId;
}

export function SourceId(s: string): SourceId {
  const v = validateString(s, "SourceId");
  if (!COMPOUND_ID_REGEX.test(v)) {
    throw new BrandedIdError(
      "SourceId",
      v,
      "must be `<type>` or `<type>:<account>` with at most one colon",
    );
  }
  return v as SourceId;
}

// ── Constructors (non-throwing parallel) ────────────────────────────────────
//
// Use these at trust boundaries where a malformed input is a soft signal
// (a DB row written by an older version, a request body that hasn't been
// validated yet) rather than a programmer error. Returns `null` when the
// input would have thrown.

export function tryProviderType(s: unknown): ProviderType | null {
  return typeof s === "string" && TYPE_REGEX.test(s) ? (s as ProviderType) : null;
}

export function trySourceType(s: unknown): SourceType | null {
  return typeof s === "string" && TYPE_REGEX.test(s) ? (s as SourceType) : null;
}

export function tryAccountId(s: unknown): AccountId | null {
  return typeof s === "string" && isValidAccountId(s) ? (s as AccountId) : null;
}

export function tryProviderId(s: unknown): ProviderId | null {
  return typeof s === "string" && COMPOUND_ID_REGEX.test(s) ? (s as ProviderId) : null;
}

export function trySourceId(s: unknown): SourceId | null {
  return typeof s === "string" && COMPOUND_ID_REGEX.test(s) ? (s as SourceId) : null;
}

// ── Builders + parsers ──────────────────────────────────────────────────────

/** Build a full SourceId from a source type and account ID. */
export function makeSourceId(sourceType: SourceType, accountId: AccountId): SourceId {
  return SourceId(`${sourceType}:${accountId}`);
}

/** Build a full ProviderId from a provider type and account ID. */
export function makeProviderId(providerType: ProviderType, accountId: AccountId): ProviderId {
  return ProviderId(`${providerType}:${accountId}`);
}

/**
 * Parse a full SourceId into its type and account parts.
 * E.g. "gmail:user@gmail.com" → { sourceType: "gmail", accountId: "user@gmail.com" }
 * E.g. "things" → { sourceType: "things", accountId: "local" }
 */
export function parseSourceId(id: SourceId): { sourceType: SourceType; accountId: AccountId } {
  const colonIdx = id.indexOf(":");
  if (colonIdx === -1) return { sourceType: SourceType(id), accountId: AccountId("local") };
  return {
    sourceType: SourceType(id.slice(0, colonIdx)),
    accountId: AccountId(id.slice(colonIdx + 1)),
  };
}

/**
 * Whether one id addresses another.
 *
 * A source is named at one of two specificities. A bare type — `gmail` —
 * covers every account of that type; a qualified id — `gmail:someone@example.com`
 * — covers exactly one. So naming a type widens, and naming an account is
 * exact. That asymmetry is the whole rule, and it is written here once because
 * it had been written five times.
 *
 * Two properties are load-bearing, and each has failed in production when a
 * copy got them wrong.
 *
 * It compares on the type component, not as a string prefix: a prefix test
 * makes `gmail` swallow `gmail-archive:…`, which is a different source.
 *
 * And it is total. A malformed id answers false rather than throwing, because
 * every caller is inside a loop over things it did not choose — config keys, a
 * drain batch, a teardown pass — and a throw there abandons the rest of the
 * batch rather than skipping one entry.
 *
 * The failure this replaces was equality alone: every fixture universe names
 * its sources by bare type, so equality passed a whole test suite and then
 * matched nothing on an install that had ever added an account. The watch
 * validated, installed, sat active and never fired, because "nothing matched
 * the filter" is not an error anyone reports.
 */
export function sourceIdAddresses(named: string, sourceId: string): boolean {
  if (named === sourceId) return true;
  // An id that already names an account matches only itself, so an exact miss
  // above is final.
  if (named.includes(":")) return false;
  return sourceId.startsWith(`${named}:`);
}

/**
 * The type half of a source id — everything before the first colon, or the
 * whole id when it names no account.
 *
 * Total, unbranded, and deliberately separate from {@link parseSourceId}: that
 * one brands both halves and therefore throws on an id it cannot parse. Every
 * caller here is iterating something it did not choose — a config key, a
 * `SELECT DISTINCT source_id`, a drain batch, a catalog row — where one
 * malformed entry must cost that entry and not the rest of the pass.
 *
 * An id that begins with a colon has no usable type half. It answers with
 * itself rather than the empty string, so that a malformed id keeps addressing
 * only itself: an empty type would collide with every other malformed id, and
 * `sourceIdAddresses("", ":account")` is true, so `""` would silently address
 * a whole class of them.
 */
export function sourceTypeOf(sourceId: string): string {
  const colon = sourceId.indexOf(":");
  return colon <= 0 ? sourceId : sourceId.slice(0, colon);
}

/**
 * The account half of a source id, or the empty string when it names no
 * account.
 *
 * The twin of {@link sourceTypeOf}, with the same totality. Both `type` and
 * `type:` answer `""`, and so does an id beginning with a colon — a caller
 * that needs an account tests the result rather than the shape of the id.
 */
export function sourceAccountOf(sourceId: string): string {
  const colon = sourceId.indexOf(":");
  return colon <= 0 ? "" : sourceId.slice(colon + 1);
}

/**
 * Parse a full ProviderId into its type and account parts.
 * E.g. "google:user@gmail.com" → { providerType: "google", accountId: "user@gmail.com" }
 * E.g. "system" → { providerType: "system", accountId: "local" }
 */
export function parseProviderId(id: ProviderId): {
  providerType: ProviderType;
  accountId: AccountId;
} {
  const colonIdx = id.indexOf(":");
  if (colonIdx === -1) return { providerType: ProviderType(id), accountId: AccountId("local") };
  return {
    providerType: ProviderType(id.slice(0, colonIdx)),
    accountId: AccountId(id.slice(colonIdx + 1)),
  };
}

/**
 * Validate that `segment` is safe to use as a single on-disk path
 * component, and return it unchanged. Throws `BrandedIdError` when it
 * contains a path separator (`/`, `\`), a NUL/control character, or is
 * empty or one of the traversal segments `.` / `..`. The branded-ID
 * constructors already reject these for account IDs; call this as
 * defense-in-depth wherever an account ID (or any externally-influenced
 * string) is joined into a credential/storage path, so a path-shaped
 * value that bypassed the brand can't redirect reads/writes out of the
 * intended directory.
 */
export function safePathSegment(segment: string): string {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    /[/\\\u0000-\u001f\u007f]/.test(segment)
  ) {
    throw new BrandedIdError("AccountId", segment, "is not a safe path segment");
  }
  return segment;
}
