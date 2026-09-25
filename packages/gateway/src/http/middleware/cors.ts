// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { GatewayCorsSettings } from "@omnesis/config";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../routes/types.js";

export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [];
export const DEFAULT_ALLOW_CREDENTIALS = false;
export const DEFAULT_ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
export const DEFAULT_ALLOWED_HEADERS = ["Authorization", "Content-Type", "X-Request-Id"];
export const DEFAULT_MAX_AGE_SECONDS = 600;

/**
 * Cross-origin request policy for browser clients behind a reverse proxy.
 *
 * Reads its config through a thunk so a hot config reload takes effect on the
 * next request without re-mounting the middleware. Off by default: with no
 * `cors` block — or an empty/absent `allowedOrigins` — the request flows
 * through untouched, emitting no `Access-Control-*` headers, which preserves
 * the gateway's same-origin-only posture.
 *
 * An origin is allowed when it exact-matches an entry of `allowedOrigins`, or
 * when `allowedOrigins` contains the wildcard `"*"`. When `allowCredentials`
 * is set, the concrete request `Origin` is always echoed (never the literal
 * `"*"`, which the Fetch spec rejects alongside credentials) and `Vary: Origin`
 * is added; otherwise the matched origin is echoed, or `"*"` for a wildcard
 * policy without credentials.
 *
 * Preflight (`OPTIONS` carrying `Access-Control-Request-Method`) is answered
 * here with `204` and the method/header/max-age headers, and short-circuits —
 * no `OPTIONS` routes are mounted, so falling through would 404. A disallowed
 * origin still gets a bare `204` with no CORS headers.
 */
export function corsMiddleware(
  getCors: () => GatewayCorsSettings | undefined,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cors = getCors();
    const allowedOrigins = cors?.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
    const isPreflight =
      c.req.method === "OPTIONS" && c.req.header("Access-Control-Request-Method") !== undefined;

    // No policy configured → inert. Preflight still must not fall through to a
    // 404 (no OPTIONS routes), so answer it with a bare 204.
    if (!allowedOrigins || allowedOrigins.length === 0) {
      return isPreflight ? c.body(null, 204) : next();
    }

    const origin = c.req.header("Origin");
    const wildcard = allowedOrigins.includes("*");
    const allowed = origin !== undefined && (wildcard || allowedOrigins.includes(origin));

    if (!allowed) {
      // Disallowed origin: answer preflight with a bare 204 (still no CORS
      // headers), else let the request proceed without CORS headers.
      return isPreflight ? c.body(null, 204) : next();
    }

    const credentials = cors?.allowCredentials ?? DEFAULT_ALLOW_CREDENTIALS;
    // With credentials the concrete origin must be echoed (the Fetch spec
    // forbids the literal "*" alongside Allow-Credentials: true). Echoing the
    // concrete origin also means the response varies by Origin.
    const echoConcrete = credentials || !wildcard;
    const allowOriginValue = echoConcrete ? (origin as string) : "*";

    c.header("Access-Control-Allow-Origin", allowOriginValue);
    if (echoConcrete) c.header("Vary", "Origin");
    if (credentials) c.header("Access-Control-Allow-Credentials", "true");

    if (isPreflight) {
      const methods = cors?.allowedMethods ?? DEFAULT_ALLOWED_METHODS;
      const headers = cors?.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS;
      const maxAge = cors?.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
      c.header("Access-Control-Allow-Methods", methods.join(", "));
      c.header("Access-Control-Allow-Headers", headers.join(", "));
      c.header("Access-Control-Max-Age", String(maxAge));
      return c.body(null, 204);
    }

    return next();
  };
}
