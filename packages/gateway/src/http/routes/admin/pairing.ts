// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { BadRequestError, ConflictError, HttpError } from "../../errors.js";
import { consumePairingBody } from "../../schemas/index.js";
import { pairingRateLimiter } from "../../../rate-limit.js";
import { clientIp, log, type AdminRoutesDeps } from "./internals.js";
import type { RouteApp } from "../types.js";

/**
 * Block 1.15 — public pairing endpoint.
 *
 *   POST /devices/pair          (public, rate-limited)
 *
 * The admin-side `/admin/devices/pair` (which mints a pairing CODE) lives in
 * `devices.ts`; this module hosts the consumer-side endpoint that exchanges
 * a pairing code for a device + token.
 */
export function mountPairingRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  // `/devices/pair` is unauthenticated by design (the
  // pairing code IS the credential). A 40-bit code is brute-forceable
  // from the LAN inside its 10-minute TTL under stress; the
  // per-source-IP token-bucket here makes that infeasible. The
  // limiter doesn't echo refusal detail to the client — operators see
  // failed attempts in the gateway log, not in the response.
  const pairLimiter = pairingRateLimiter();

  app.post("/devices/pair", scope.public(), validateJson(consumePairingBody), async (c) => {
    const ip = clientIp(c);
    const refusal = pairLimiter.consume(ip);
    if (refusal) {
      return c.json({ error: "Too many pairing attempts — try again later" }, 429, {
        "Retry-After": "60",
      });
    }
    const { pairingCode, capabilities, agentIntegration, continuityCredential, idempotencyKey } =
      c.req.valid("json");
    const result = await deps.pairingService.redeem({
      pairingCode,
      ...(capabilities ? { capabilities } : {}),
      ...(agentIntegration ? { agentIntegration } : {}),
      ...(continuityCredential ? { continuityCredential } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (result.outcome === "invalid") {
      log.warn(`Failed pairing attempt from ${ip}: ${result.error}`);
      throw new BadRequestError(result.error);
    }
    if (result.outcome === "conflict") {
      throw result.code
        ? new HttpError(409, result.code, result.error)
        : new ConflictError(result.error);
    }
    if (result.outcome === "paired-agent") {
      return c.json({
        device: result.device,
        reconnected: result.reconnected,
        credentials: result.credentials,
      });
    }
    return c.json({
      device: result.device,
      tokenId: result.tokenId,
      token: result.token,
      scopes: result.scopes,
    });
  });
}
