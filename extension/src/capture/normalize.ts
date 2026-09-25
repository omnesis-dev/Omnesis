// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * URL normalization for the browser-capture content plane.
 *
 * The normalized URL feeds the content document's `externalId` (the upsert key
 * is `SHA256(normalizeUrl(url))`), so two browsings of the "same" page must
 * normalize identically while two genuinely different pages must not collide —
 * and the extension must agree byte-for-byte with the gateway's canonical
 * normalizer, or the same page lands under two identities.
 *
 * This is a thin wrapper over the single canonical normalizer in
 * `@omnesis/core/url-normalize`, a dependency-free subpath that bundles into a
 * browser content script (it imports no `node:crypto`). Both sides therefore
 * strip the same tracking-param set, preserve slash-bearing fragments (SPA
 * hash-route identity), and normalize trailing slashes and parameter order the
 * same way; `identity-parity.test.ts` asserts the agreement.
 */

import { normalizeUrl } from "@omnesis/core/url-normalize";

/**
 * Normalize a page URL into its stable capture key. Returns the input
 * unchanged if it is not a parseable http(s) URL (the caller skips such pages
 * anyway — there is no readable page behind a non-http URL).
 *
 * The browser bundle passes no canonicalizer registry: the only declared
 * canonicalizer hosts are `ownedWebDomains` the capture path already skips, so
 * per-host rewriting is a gateway-only concern applied at re-normalization /
 * lookup time.
 */
export function normalizeCaptureUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      return normalizeUrl(url.toString());
    }
  } catch {
    // Preserve the normalizer's established fallback for unparseable input.
  }
  return normalizeUrl(rawUrl);
}

/**
 * Lowercased hostname of a URL, or `""` if it won't parse. Used for the
 * capture policy's host checks and the `page_visits.domain` column.
 */
export function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Choose the capture key for a page: prefer its declared `<link rel="canonical">`
 * URL over the live address, but only when the canonical is a trustworthy, MORE
 * specific identity.
 *
 * Why prefer it: some single-page apps (ChatGPT, …) render a page while the
 * address bar is still the bare site root, then settle the real URL a beat
 * later. Captured at that instant, every such page collapses onto the root URL
 * and overwrites the previous one. The canonical link names the stable per-page
 * identity even then (e.g. `https://chatgpt.com/c/<id>` while `location` is
 * still `https://chatgpt.com/`), so adopting it keeps distinct pages distinct.
 *
 * Guarded against the well-known canonical footgun — sites that point
 * `rel=canonical` at a broad URL (the homepage, a section) on many distinct
 * pages, which would MERGE them. The canonical is adopted only when it is:
 *   - a parseable http(s) URL (resolved relative to the live URL),
 *   - same HTTPS origin as the live page (scheme, host, and effective port),
 *   - NOT less path-specific than the live URL (at least as many path segments).
 *
 * So a canonical may *sharpen* a vague URL (`/` → `/c/<id>`) but never
 * *generalise* a specific one (`/article/123` → `/`), which is the collapse
 * case. Returns the raw chosen URL; the caller still runs it through
 * {@link normalizeCaptureUrl}.
 */
export function preferCanonicalUrl(
  liveUrl: string,
  canonicalUrl: string | null | undefined,
): string {
  if (!canonicalUrl) return liveUrl;
  let live: URL;
  try {
    live = new URL(liveUrl);
  } catch {
    return liveUrl;
  }
  let canon: URL;
  try {
    // Resolve relative canonicals (`<link rel=canonical href="/c/123">`).
    canon = new URL(canonicalUrl, liveUrl);
  } catch {
    return liveUrl;
  }
  if (live.protocol !== "https:" || canon.protocol !== "https:") return liveUrl;
  if (canon.username || canon.password) return liveUrl;
  if (canon.origin !== live.origin) return liveUrl;
  if (pathDepth(canon.pathname) < pathDepth(live.pathname)) return liveUrl;
  return canon.toString();
}

/** Count of non-empty path segments — the page's path "specificity". */
function pathDepth(pathname: string): number {
  return pathname.split("/").filter(Boolean).length;
}
