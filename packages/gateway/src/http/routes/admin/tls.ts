// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The served certificate, for operators.
 *
 *   GET  /admin/tls          what is served, what waits on disk, how it renews
 *   POST /admin/tls/reload   activate material replaced on disk, without a restart
 *   POST /admin/tls/renew    mint, verify, write and activate a replacement now
 *
 * All three answer with the lifecycle snapshot; `renew` wraps it in the
 * attempt's outcome so a refusal carries its reason.
 */

import { scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { tlsRenewBody } from "../../schemas/index.js";
import { DEFAULT_TLS_LIFECYCLE_TIMEOUT_MS } from "../../../tls-lifecycle/task.js";
import type { RouteApp } from "../types.js";
import type { AdminRoutesDeps } from "./internals.js";

export function mountTlsRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  const { tlsLifecycle } = deps;
  if (!tlsLifecycle) return;

  app.get("/admin/tls", scope.admin(), (c) => c.json(tlsLifecycle.snapshot()));

  app.post("/admin/tls/reload", scope.admin(), (c) => {
    tlsLifecycle.activateFromDisk();
    return c.json(tlsLifecycle.snapshot());
  });

  app.post("/admin/tls/renew", scope.admin(), validateJson(tlsRenewBody), async (c) => {
    const { force } = c.req.valid("json");
    const outcome = await tlsLifecycle.renew(
      AbortSignal.timeout(DEFAULT_TLS_LIFECYCLE_TIMEOUT_MS),
      {
        force: force === true,
      },
    );
    return c.json(outcome);
  });
}
