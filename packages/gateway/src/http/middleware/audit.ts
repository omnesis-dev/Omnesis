// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { tokenIdLogPrefix } from "../audit-format.js";
import { clientIp } from "../routes/admin/internals.js";
import type { GatewayAuditSettings } from "@omnesis/config";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../routes/types.js";

export const DEFAULT_AUDIT_ENABLED = false;
export const DEFAULT_AUDIT_INCLUDE_UNAUTHENTICATED = false;

const log = createLogger("gateway:http").child("audit");

/**
 * Per-token / per-endpoint access logging.
 *
 * Reads its config through a thunk so a hot reload takes effect on the next
 * request. Must run AFTER the auth + request-context middlewares so
 * `c.get("auth")` is populated by the time it logs.
 *
 * Off by default and cheap when off: it bails before computing anything when
 * `audit.enabled` is not set. When on, it emits exactly one INFO line per
 * request with the token prefix, device prefix, method, route TEMPLATE
 * (`c.req.routePath`, not the concrete path — avoids leaking ids/PII), status,
 * client IP, and elapsed ms. It never logs the raw token, query string, or
 * request body. Unauthenticated requests are skipped unless
 * `includeUnauthenticated` is set (then logged as `tok=anon dev=none`).
 */
export function auditMiddleware(
  getAudit: () => GatewayAuditSettings | undefined,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startMs = Date.now();
    await next();

    const audit = getAudit();
    if ((audit?.enabled ?? DEFAULT_AUDIT_ENABLED) === false) return;

    const auth = c.get("auth");
    if (!auth && !(audit?.includeUnauthenticated ?? DEFAULT_AUDIT_INCLUDE_UNAUTHENTICATED)) return;

    const tookMs = Date.now() - startMs;
    const dev = auth?.deviceId ? auth.deviceId.slice(0, 8) : "none";
    const route = c.req.routePath;
    const reqId = c.get("requestId") ?? "?";

    log.info(
      `${c.req.method} ${route} ${c.res.status} tok=${tokenIdLogPrefix(auth?.tokenId)} dev=${dev} ip=${clientIp(c)} in ${tookMs}ms [req=${reqId}]`,
    );
  };
}
