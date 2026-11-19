// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where a Plaud account's API lives.
 *
 * Plaud runs regional deployments (`api.plaud.ai`, `api-euc1.plaud.ai`,
 * `api-apse1.plaud.ai`, and the separate mainland China one on
 * `api.plaud.cn`). The sign-in call answers an account that lives elsewhere
 * with the regional host to use, and that host is stored with the account.
 * Because the host comes from a response, it is accepted only when it is an
 * https origin under Plaud's own domains: anything else would let a response
 * point the collector, and the account's token, at an arbitrary server.
 */

/** Where sign-in starts; Plaud redirects an account to its own region from here. */
export const DEFAULT_API_BASE = "https://api.plaud.ai";

/** A browser-like agent: Plaud's API serves its own web app and refuses unfamiliar clients. */
export const PLAUD_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * The origin of a Plaud API host, or `undefined` when `input` is not an https
 * URL on `plaud.ai` / `plaud.cn` (or a subdomain of either) with no
 * credentials, query or path beyond `/`.
 */
export function plaudApiBase(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  const host = url.hostname.toLowerCase();
  const onPlaud = ["plaud.ai", "plaud.cn"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  return onPlaud ? url.origin : undefined;
}
