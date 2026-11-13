// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { timingSafeEqual } from "node:crypto";
import { PORTAL_CSRF_HEADER } from "./cookies.js";
import type { GatewayCorsSettings } from "@omnesis/config";

/**
 * Cross-site request forgery boundary for the portal session cookie.
 *
 * The browser attaches the session cookie to any request aimed at the
 * gateway, including one a different page starts: `SameSite=Lax` keeps it off
 * cross-site POSTs but not off same-site ones, and two gateways under one
 * parent domain are the same site. So a cookie alone never proves the portal
 * itself sent a state-changing request. One of these does:
 *
 *   - the synchronizer token (`X-Omnesis-CSRF`), which only a page that could
 *     read `/portal/api/session` holds;
 *   - `Sec-Fetch-Site: same-origin` (or `none`, a request the user made
 *     directly), which a page cannot forge;
 *   - when the browser sends no `Sec-Fetch-Site`, an `Origin` naming this
 *     very host;
 *   - an `Origin` the operator listed in a credentialed CORS policy.
 *
 * Safe methods never change state and pass. Bearer-token requests never reach
 * this check: a browser cannot attach someone else's bearer token.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface SessionRequest {
  method: string;
  header(name: string): string | undefined;
}

/** Constant-time comparison of a presented synchronizer token with the session's. */
export function csrfTokenMatches(presented: string | undefined, expected: string): boolean {
  const presentedBytes = Buffer.from(presented ?? "", "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    presentedBytes.length === expectedBytes.length && timingSafeEqual(presentedBytes, expectedBytes)
  );
}

/**
 * Whether a request carrying a valid portal session cookie may act with that
 * session. `credentialedOrigins` are the exact origins an operator allowed to
 * make credentialed cross-origin requests (`gateway.cors` with
 * `allowCredentials`).
 */
export function portalSessionMayAct(
  req: SessionRequest,
  csrfToken: string,
  credentialedOrigins: readonly string[] = [],
): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  if (csrfTokenMatches(req.header(PORTAL_CSRF_HEADER), csrfToken)) return true;
  const origin = req.header("Origin");
  if (origin !== undefined && origin !== "null" && credentialedOrigins.includes(origin)) {
    return true;
  }
  const site = req.header("Sec-Fetch-Site")?.trim().toLowerCase();
  if (site !== undefined) return site === "same-origin" || site === "none";
  return origin !== undefined && originMatchesHost(origin, req.header("Host"));
}

/** The exact origins a `gateway.cors` policy lets make credentialed requests. */
export function credentialedCorsOrigins(cors: GatewayCorsSettings | undefined): readonly string[] {
  if (cors?.allowCredentials !== true) return [];
  return (cors.allowedOrigins ?? []).filter((origin) => origin !== "*");
}

function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    // Parse the Host under the Origin's scheme so an explicit default port
    // (`gw.example:443`) compares equal to the Origin's implicit one.
    return url.host === new URL(`${url.protocol}//${host.trim()}`).host;
  } catch {
    return false;
  }
}
