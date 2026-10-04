// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { experimentalEnabled } from "@omnesis/core";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { browserFindSearchBody } from "../schemas/browser-find.js";
import { authorizationBody } from "../schemas/browser-notes.js";
import type { BrowserFindStreamService } from "../services/BrowserFindStreamService.js";
import type { RouteApp } from "./types.js";
import type { BrowserFindService } from "../services/BrowserFindService.js";

export function mountBrowserFindRoutes(
  app: RouteApp,
  service: BrowserFindService,
  searches: BrowserFindStreamService,
): void {
  app.use("/browser/find", async (c, next) => {
    if (!experimentalEnabled()) return c.notFound();
    return next();
  });
  app.use("/browser/find/*", async (c, next) => {
    if (!experimentalEnabled()) return c.notFound();
    return next();
  });
  app.use("/admin/browser-find/*", async (c, next) => {
    if (!experimentalEnabled()) return c.notFound();
    return next();
  });
  app.post(
    "/browser/find/enable",
    scope.deviceSelf(),
    validateJson(authorizationBody),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await service.enable(c.get("auth"), c.req.valid("json").id));
    },
  );
  app.post(
    "/browser/find/authorization",
    scope.deviceSelf(),
    validateJson(authorizationBody),
    (c) => c.json(service.createAuthorization(c.get("auth"), c.req.valid("json").id), 201),
  );
  app.get("/browser/find/authorization/:id", scope.deviceSelf(), (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(service.poll(c.get("auth"), c.req.param("id")));
  });
  app.get("/admin/browser-find/authorizations/:id", scope.admin(), (c) =>
    c.json(service.authorization(c.req.param("id"))),
  );
  app.post("/admin/browser-find/authorizations/:id/approve", scope.portalAdmin(), async (c) => {
    await service.approve(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/browser/find/search", scope.read(), validateJson(browserFindSearchBody), (c) =>
    searches.stream(c.get("auth"), c.req.valid("json"), c.req.raw.signal),
  );
  app.get("/browser/find", scope.deviceSelf(), (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(service.status(c.get("auth")));
  });
}
