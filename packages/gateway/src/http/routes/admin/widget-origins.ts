// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { enforceBroadWriteScope, scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { widgetOriginsBody } from "../../schemas/admin.js";
import { getWidgetOrigins, setWidgetOrigins } from "../../../widget-origins.js";
import { log as adminLog } from "./internals.js";
import type { RouteApp } from "../types.js";

const log = adminLog.child("widget-origins");

/**
 * Mount the widget-origins admin endpoint (#918).
 *
 * The collector POSTs the union of external widget-vendor origins declared by
 * *every known source type* (every loaded `link-widget` source descriptor's
 * `widgetOrigins`), derived at boot. The gateway holds the aggregate in memory
 * and folds it into the portal's Content-Security-Policy so a source's hosted
 * widget (Plaid Link, …) can load its vendor SDK + iframe in the browser —
 * which the portal's otherwise strict, zero-external-load CSP forbids.
 *
 * `scope.writeAny()` plus `write:*` refinement — same broad collector
 * capability as the other boot pushes (`owned-web-domains`,
 * `self-identity-sources`). This is a process-wide configuration push, not
 * per-source data.
 *
 * No source-specific logic lives here — the gateway treats every entry as an
 * opaque CSP source expression. Per-source widget-origin knowledge lives in
 * each source package on `defineSource`/`defineProvider`.
 */
export function mountWidgetOriginsRoutes(app: RouteApp): void {
  app.post("/admin/widget-origins", scope.writeAny(), validateJson(widgetOriginsBody), (c) => {
    enforceBroadWriteScope(c.get("auth").scopes);
    const { script, frame, connect } = c.req.valid("json");
    setWidgetOrigins({ script, frame, connect });
    const agg = getWidgetOrigins();
    log.info(
      `registered widget origins: ${agg.script.length} script, ${agg.frame.length} frame, ${agg.connect.length} connect`,
    );
    return c.json({
      ok: true,
      script: agg.script.length,
      frame: agg.frame.length,
      connect: agg.connect.length,
    });
  });
}
