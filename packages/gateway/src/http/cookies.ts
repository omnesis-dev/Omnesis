// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

/**
 * Single owner of the portal session cookie format. Both the read side
 * (`getSessionCookie`) and the write side (`buildSessionCookieHeader`,
 * `clearSessionCookieHeader`) live here so that the auth middleware in
 * `server.ts` and the portal API routes in `routes/portal.ts` cannot
 * drift on Max-Age, Secure, SameSite, HttpOnly, or Path. The gateway always
 * serves HTTPS, so `Secure` is set unconditionally — the browser must never
 * send the bearer session cookie over plaintext.
 *
 * The parser walks the Cookie header by `;` segments and compares the
 * key with `===` against the literal cookie name — no regex interpolation
 * of the name (the prior implementation used `new RegExp(...${name}...)`,
 * which was safe in practice because every caller passed a hardcoded
 * literal but would have admitted regex-metacharacter injection if a
 * caller ever forwarded an attacker-controlled name).
 */

/**
 * Base session cookie name. RFC 6265 scopes cookies by host but NOT by
 * port, so when two gateways run on the same host (e.g. `localhost:7600`
 * and `localhost:27600`), a bare `__omnesis_session` cookie set by one
 * overwrites the cookie set by the other in the browser. The user then
 * gets silently logged out of the first gateway. `sessionCookieName(port)`
 * appends the listen port so the two gateways carry independent cookies.
 */
export const SESSION_COOKIE_BASE = "__omnesis_session";

/**
 * @deprecated Prefer `sessionCookieName(port)` so multi-gateway-on-same-host
 * setups don't clobber each other's session cookies. Retained for tests and
 * any caller that genuinely doesn't care which gateway is talking.
 */
export const SESSION_COOKIE_NAME = SESSION_COOKIE_BASE;

/** Header required by portal-only mutation guards. */
export const PORTAL_CSRF_HEADER = "X-Omnesis-CSRF";

/**
 * Derive a browser-readable synchronizer token without exposing the HttpOnly
 * session id. The session id is already high-entropy secret material; domain
 * separation prevents this digest from being confused with any other use of
 * the same value.
 */
export function portalCsrfToken(sessionId: string): string {
  return createHash("sha256")
    .update("omnesis:portal-csrf:v1\0", "utf8")
    .update(sessionId, "utf8")
    .digest("hex");
}

/**
 * Resolve the session cookie name for this gateway instance. Pass the
 * gateway's listen port to scope the cookie per-port; omit it for the
 * single-gateway default.
 */
export function sessionCookieName(port?: number): string {
  if (port === undefined || !Number.isFinite(port)) return SESSION_COOKIE_BASE;
  return `${SESSION_COOKIE_BASE}_${port}`;
}

/**
 * Fallback `Max-Age` (seconds) when no operator override is supplied.
 * `mountPortalRoutes` derives the value from `gateway.timings.sessionTtl`
 * and threads it through `buildSessionCookieHeader(sessionId, maxAgeS)`;
 * the bare-default exists for tests and any caller that doesn't have
 * the resolved runtime settings in scope.
 */
export const DEFAULT_SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1);
    }
  }
  return undefined;
}

export function getSessionCookie(
  header: string | undefined,
  name: string = SESSION_COOKIE_BASE,
): string | undefined {
  return parseCookie(header, name);
}

/**
 * Build the `Set-Cookie` header for a fresh portal session. Pass the
 * configured `gateway.timings.sessionTtl` (in seconds) to honour the
 * operator's override; omit the second argument and the
 * `DEFAULT_SESSION_MAX_AGE_S` (30d) fallback applies.
 */
export function buildSessionCookieHeader(
  sessionId: string,
  maxAgeS: number = DEFAULT_SESSION_MAX_AGE_S,
  name: string = SESSION_COOKIE_BASE,
): string {
  return `${name}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeS}`;
}

export function clearSessionCookieHeader(name: string = SESSION_COOKIE_BASE): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
