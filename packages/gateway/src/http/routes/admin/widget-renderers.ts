// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { widgetRenderersBody } from "../../schemas/admin.js";
import { getWidgetRenderers, setWidgetRenderers } from "../../../widget-renderers.js";
import { log as adminLog } from "./internals.js";
import type { RouteApp } from "../types.js";

const log = adminLog.child("widget-renderers");

/**
 * Mount the widget-renderers admin endpoint (#984).
 *
 * The collector POSTs the provider-owned browser modules declared by every
 * loaded hosted-widget source/provider. The gateway holds the registry in
 * memory and exposes each module through a same-origin `/portal/*` route.
 * Shared portal code imports by opaque widget `kind`; vendor SDK details stay
 * inside the declaring provider package.
 */
export function mountWidgetRenderersRoutes(app: RouteApp): void {
  app.post("/admin/widget-renderers", scope.writeAny(), validateJson(widgetRenderersBody), (c) => {
    const { renderers } = c.req.valid("json");
    setWidgetRenderers(renderers);
    const count = getWidgetRenderers().length;
    log.info(`registered ${count} widget renderer(s)`);
    return c.json({ ok: true, renderers: count });
  });
}
