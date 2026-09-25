// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scope } from "../../scope.js";
import type { RouteApp } from "../types.js";
import type { AdminRoutesDeps } from "./internals.js";

/** Source-level V1 coverage records. This route deliberately exposes no raw upstream cuts. */
export function mountWatermarkRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  app.get("/admin/watermarks", scope.admin(), (c) => {
    const sourceId = c.req.query("sourceId");
    return c.json({ items: deps.watermarkService.list(sourceId) });
  });
}
