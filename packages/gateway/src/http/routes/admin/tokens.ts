// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildPage, scopesAllowedForDeviceKind, tryDeviceId, tryTokenId } from "@omnesis/types";
import { scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { NotFoundError } from "../../errors.js";
import { createTokenBody } from "../../schemas/index.js";
import { log, type AdminRoutesDeps } from "./internals.js";
import type { RouteApp } from "../types.js";

/**
 * Block 1.10 — token CRUD.
 *
 *   GET    /admin/tokens
 *   POST   /admin/tokens
 *   DELETE /admin/tokens/:id
 */
export function mountTokenRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  const { writeGate: w, deviceService } = deps;

  // `?deviceId=` filters the list. Per http-conventions.md "Param
  // placement and naming": deviceId rides in the query for GET filters
  // (matches GET /admin/sources?deviceId=, GET /admin/credentials?deviceId=).
  app.get("/admin/tokens", scope.admin(), (c) => {
    const raw = c.req.query("deviceId");
    const deviceId = raw === undefined ? undefined : tryDeviceId(raw);
    if (raw !== undefined && !deviceId) {
      return c.json(buildPage([], { hasMore: false, limit: 0 }));
    }
    const tokens = deviceService.listTokens(deviceId ?? undefined);
    return c.json(buildPage(tokens, { hasMore: false, limit: tokens.length }));
  });

  app.post("/admin/tokens", scope.admin(), validateJson(createTokenBody), async (c) => {
    const { deviceId, scopes, name, ttlMs } = c.req.valid("json");
    const did = tryDeviceId(deviceId);
    if (!did) throw new NotFoundError("device not found");
    const device = deviceService.getById(did);
    if (!device) throw new NotFoundError("device not found");
    if (device.revokedAt !== null) {
      // A revoked device's access is dead by definition; a fresh token
      // would silently resurrect it. Reclaiming the identity goes through
      // pairing (same name adopts the row and clears the revocation).
      return c.json(
        {
          code: "DEVICE_REVOKED",
          error: `device "${device.name}" is revoked — pair it again to reclaim it, or forget it`,
        },
        409,
      );
    }

    // An integration reads the corpus only through its access level, so its
    // tokens carry nothing wider (the token store enforces the same).
    if (!scopesAllowedForDeviceKind(device.kind, scopes)) {
      return c.json(
        {
          code: "INTEGRATION_SCOPES",
          error: `"${device.name}" is an integration, so its tokens can carry only the answer scope (and write scopes)`,
        },
        409,
      );
    }

    const { id, token } = await w.createToken(
      did,
      scopes,
      name ?? null,
      ttlMs !== undefined ? { ttlMs } : {},
    );
    // `expires_at` derives from ttlMs at mint time; echo the resolved instant
    // so the caller can show "expires …" without re-deriving it.
    const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : null;
    // Audit trail — the raw token value is omitted intentionally; the
    // device id + scope set is enough to reconstruct who got what.
    log.info(
      `Token issued: id=${id} device=${deviceId} scopes=[${scopes.join(",")}] name=${name ?? "(unnamed)"} expiry=${expiresAt === null ? "never" : new Date(expiresAt).toISOString()}`,
    );
    return c.json({ id, deviceId, scopes, name: name ?? null, token, expiresAt });
  });

  app.delete("/admin/tokens/:id", scope.admin(), async (c) => {
    const id = tryTokenId(c.req.param("id"));
    if (!id) return c.json({ error: "token not found" }, 404);
    const ok = await w.revokeToken(id);
    if (!ok) throw new NotFoundError("token not found");
    log.info(`Token revoked: id=${id}`);
    return c.json({ ok: true });
  });
}
