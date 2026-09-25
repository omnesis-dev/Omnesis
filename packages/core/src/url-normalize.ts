// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Dependency-free URL normalization — the single canonical path every web-page
 * writer and lookup runs through.
 *
 * This module is deliberately self-contained: it imports nothing (no
 * `node:crypto`, no zod, no source-sdk), so it bundles into a browser content
 * script under esbuild `platform: "browser"`. The browser-capture extension
 * imports it directly via the `@omnesis/core/url-normalize` subpath, and core's
 * `url-utils.ts` re-exports it. There is exactly ONE `normalizeUrl`
 * implementation in the tree; the extension is no longer a hand-maintained
 * mirror that can drift.
 *
 * Identity for the Web Pages dataset (epic #895) is
 * `external_id = SHA256(normalizeUrl(url, canonicalizers))`. The SHA-256 step
 * lives in `url-utils.ts` (`urlToExternalId`) because it needs crypto; the
 * normalization that feeds it lives here so every producer uses the identical
 * normalized string for the same URL, and therefore the identical
 * `external_id`.
 */

/**
 * Per-host URL-canonicalization rule.
 *
 * Sources declare a canonicalizer when their resource URL has several
 * user-visible flavors that all point to the same thing — Gmail
 * (`/mail/#inbox/<id>` vs `/mail/u/0/#all/<id>`), Google Drive
 * (`drive.google.com/file/d/<id>/view?usp=drivesdk` vs
 * `docs.google.com/document/d/<id>/edit`), etc. Each declares the hosts
 * it claims and an ordered list of regex rewrites. `normalizeUrl`
 * dispatches by host; the first rule whose `match` regex hits replaces
 * the URL with the `replacement` string (standard `$1`, `$2` backrefs).
 *
 * Kept as data (not functions) so the spec can travel from the
 * collector to the gateway over HTTP — see the `urlCanonicalizer`
 * field on `SourceDefinition` in `@omnesis/source-sdk`.
 */
export interface UrlCanonicalizerSpec {
  /** Hostnames (lowercase) this canonicalizer claims. Exact match. */
  hosts: readonly string[];
  /**
   * Ordered regex rules applied to the URL string. The first rule whose
   * `match` regex (matched as `new RegExp(match)`) hits is used to
   * rewrite the URL; subsequent rules are skipped. If no rule hits, the
   * URL goes through the generic normalization untouched.
   */
  rules: readonly UrlCanonicalizerRule[];
}

export interface UrlCanonicalizerRule {
  match: string;
  replacement: string;
  /**
   * Process-local safe executor. Never serialized; gateway registries attach
   * one after validating a declaration so document-controlled URLs do not run
   * through the native backtracking RegExp engine.
   */
  apply?: (input: string) => string | null;
}

/**
 * Well-known tracking / attribution query params, always stripped because they
 * never select page content. This is the UNION of the two lists that used to
 * live separately in core and the extension (#895 canonicalizer audit §1.5):
 * core's original 10 — crucially including the bare `ref` — plus the extension's
 * extra click-id / share params. Keeping the bare `ref` matters: dropping it
 * would split a page reached via `?ref=…` from the same page reached without it.
 */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  // core's original set (keep the bare `ref`)
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "fbclid",
  "gclid",
  "ref",
  "mc_cid",
  "mc_eid",
  // extension's extra click-id / share params
  "utm_id",
  "utm_reader",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "igshid",
  "yclid",
  "_ga",
  "ref_src",
  "ref_url",
  // ESP / newsletter per-recipient and click-id params. They identify the
  // recipient rather than the content, so stripping them keeps equivalent
  // links on one identity while removing the "who opened this" signal. Union
  // of the common providers (Mailchimp/Mandrill, HubSpot, Marketo, Oracle
  // Eloqua, Vero, Omeda, SendGrid/Sailthru, Adobe/Omniture, MailerLite).
  "mc_tc",
  "mkt_tok",
  "_hsenc",
  "_hsmi",
  "hsctatracking",
  "elqtrackid",
  "elqtrack",
  "elq",
  "elqcampaignid",
  "vero_id",
  "vero_conv",
  "oly_enc_id",
  "oly_anon_id",
  "spmailingid",
  "spuserid",
  "spreportid",
  "spjobid",
  "s_cid",
  "cmpid",
  "wt.mc_id",
  "ml_subscriber",
  "ml_subscriber_hash",
  "sc_campaign",
  "sc_channel",
  "trk",
  "trkcampaign",
]);

/**
 * Query parameters that carry a credential rather than select content: bearer
 * and API tokens, signatures on signed download links, one-time codes,
 * passwords and session ids. They are dropped from every normalized URL, so a
 * password-reset link or a signed file URL is recorded — and keyed — without
 * its secret, and equal pages reached through different secrets share one
 * identity. Matched case-insensitively on the exact name; any `x-amz-*`
 * parameter (a pre-signed request's credential, signature and expiry) is
 * dropped as well. `code` and `state` are dropped only when both are present,
 * the shape of an OAuth callback, since either alone is an ordinary parameter
 * on many sites.
 */
export const CREDENTIAL_PARAMS: ReadonlySet<string> = new Set([
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "auth_token",
  "authtoken",
  "api_key",
  "apikey",
  "api-key",
  "secret",
  "client_secret",
  "sig",
  "signature",
  "password",
  "passwd",
  "pwd",
  "otp",
  "session",
  "sessionid",
  "session_id",
  "jwt",
  "auth",
  "authorization",
]);

function isCredentialParam(key: string, keys: ReadonlySet<string>): boolean {
  const lower = key.toLowerCase();
  if (CREDENTIAL_PARAMS.has(lower) || lower.startsWith("x-amz-")) return true;
  return (lower === "code" || lower === "state") && keys.has("code") && keys.has("state");
}

/**
 * Normalize a URL for stable comparison and hashing.
 *
 * Generic rules (no source-specific knowledge):
 * - Lowercase hostname
 * - Strip well-known tracking params ({@link TRACKING_PARAMS}) and
 *   credential-bearing params ({@link CREDENTIAL_PARAMS})
 * - Strip anchor-like fragments (`#section`, `#top`) but PRESERVE path-like
 *   fragments that contain a `/`. The latter are used as resource identifiers
 *   in some apps (Gmail, Calendar, single-page apps that route on the hash).
 *   Stripping them would collapse every routed resource to one bucket.
 * - Sort remaining query params; strip trailing slashes.
 * For other URI schemes: lowercase + trim only.
 *
 * Per-source canonicalization (Gmail/Drive/...) is opt-in: each source
 * declares its own `UrlCanonicalizerSpec` and the caller passes the
 * compiled host-keyed registry as the second arg. This module stays
 * source-agnostic; the gateway loads canonicalizers from `sync_state`
 * (where the collector ships them) and passes them in at every call. The
 * browser bundle calls it with no registry — the only declared hosts are
 * `ownedWebDomains` the capture path already skips.
 */
export function normalizeUrl(
  url: string,
  canonicalizers?: ReadonlyMap<string, UrlCanonicalizerSpec>,
): string {
  try {
    const parsed = new URL(url);

    // Non-HTTP schemes: just lowercase and trim
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return url.toLowerCase().trim();
    }

    // Remove tracking and credential params (case-insensitive on the key)
    const keys = new Set([...parsed.searchParams.keys()].map((key) => key.toLowerCase()));
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || isCredentialParam(key, keys)) {
        parsed.searchParams.delete(key);
      }
    }

    // Sort remaining params
    parsed.searchParams.sort();

    // Strip the fragment only when it looks like an anchor — a single
    // token with no slash. A `/`-bearing fragment is treated as
    // path-like and preserved.
    if (!parsed.hash.includes("/")) {
      parsed.hash = "";
    }

    // Build the generic-normalized URL.
    let normalized = parsed.toString();

    // Strip trailing slash (but not for root URLs like https://example.com/)
    if (normalized.endsWith("/") && parsed.pathname !== "/") {
      normalized = normalized.slice(0, -1);
    }

    // Apply the per-host canonicalizer if any source has claimed this
    // hostname. Rules are tried in order; the first match wins.
    const spec = canonicalizers?.get(parsed.hostname.toLowerCase());
    if (spec) {
      for (const rule of spec.rules) {
        if (rule.apply) {
          const rewritten = rule.apply(normalized);
          if (rewritten !== null) {
            normalized = rewritten;
            break;
          }
          continue;
        }
        const re = compileMatch(rule.match);
        if (!re) continue;
        if (re.test(normalized)) {
          normalized = normalized.replace(re, rule.replacement);
          break;
        }
      }
    }

    return normalized;
  } catch {
    // Invalid URL — return as-is
    return url;
  }
}

// Cache compiled RegExps so the hot path doesn't recompile each call.
// Cap is generous because canonicalizer specs are static per process.
const compiledMatchCache = new Map<string, RegExp | null>();
function compileMatch(pattern: string): RegExp | null {
  const cached = compiledMatchCache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(pattern);
  } catch {
    compiled = null;
  }
  compiledMatchCache.set(pattern, compiled);
  return compiled;
}

/**
 * Build a host-keyed lookup from a list of canonicalizer specs. Each
 * spec's `hosts` are flattened to one entry per host. Later specs
 * claiming the same host overwrite earlier ones — this can happen if
 * two sources declare the same host; gateway boot logs a warning so
 * the conflict surfaces.
 */
export function buildCanonicalizerRegistry(
  specs: readonly UrlCanonicalizerSpec[],
  compileRule?: (rule: Readonly<UrlCanonicalizerRule>) => UrlCanonicalizerRule["apply"],
): Map<string, UrlCanonicalizerSpec> {
  const out = new Map<string, UrlCanonicalizerSpec>();
  for (const spec of specs) {
    const runtimeSpec = compileRule
      ? {
          ...spec,
          rules: spec.rules.map((rule) => ({ ...rule, apply: compileRule(rule) })),
        }
      : spec;
    for (const host of spec.hosts) out.set(host.toLowerCase(), runtimeSpec);
  }
  return out;
}

/**
 * Decide whether a host is "owned" by an existing source — i.e. whether a
 * dedicated source already ingests this site, so a generic capture path
 * (the browser-capture source) should skip it rather than double-ingest.
 *
 * The owned set is the gateway-aggregated union of every source's declared
 * `ownedWebDomains` (each a bare lowercase hostname). A host matches an
 * entry `d` when it equals `d` or is a subdomain of `d`
 * (`host.endsWith("." + d)`), so declaring `notion.so` also covers
 * `www.notion.so` and any `*.notion.so` workspace host. Matching is
 * case-insensitive; the host is folded to lowercase before comparison.
 *
 * A pure function so both the gateway and the extension's capture engine can
 * call it against the same set with no source-specific logic.
 */
export function hostIsOwned(host: string, ownedDomains: Iterable<string>): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  for (const raw of ownedDomains) {
    const d = raw.trim().toLowerCase();
    if (!d) continue;
    if (h === d || h.endsWith("." + d)) return true;
  }
  return false;
}
