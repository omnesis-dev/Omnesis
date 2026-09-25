// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scope } from "../../scope.js";
import { hostFleetUpdateStartBody } from "../../schemas/index.js";
import { validateJson } from "../../validate.js";
import { ServiceUnavailableError } from "../../errors.js";
import type { RouteApp } from "../types.js";
import type { AdminRoutesDeps } from "./internals.js";

/** Portal-session-only gateway-host update plan, start, and durable status. */
export function mountHostFleetUpdateRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  app.get("/admin/fleet/host-update", scope.portalAdmin(), (c) => {
    if (!deps.hostFleetUpdateService) {
      throw new ServiceUnavailableError("Gateway-host fleet updates are not configured.");
    }
    return c.json(deps.hostFleetUpdateService.snapshot());
  });

  app.post(
    "/admin/fleet/host-update",
    scope.portalAdmin(),
    validateJson(hostFleetUpdateStartBody),
    async (c) => {
      if (!deps.hostFleetUpdateService) {
        throw new ServiceUnavailableError("Gateway-host fleet updates are not configured.");
      }
      const operation = await deps.hostFleetUpdateService.start(c.req.valid("json").planId);
      return c.json({ operation }, 202);
    },
  );
}
