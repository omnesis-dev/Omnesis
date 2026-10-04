// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { notesRateLimiter } from "../../rate-limit.js";
import { experimentalEnabled } from "@omnesis/core";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { authorizationBody, browserNoteBody } from "../schemas/browser-notes.js";
import { clientIp, isLoopbackRequest } from "./admin/internals.js";
import type { RouteApp } from "./types.js";
import type { BrowserNotesService } from "../services/BrowserNotesService.js";

export function mountBrowserNotesRoutes(app: RouteApp, service: BrowserNotesService): void {
  app.use("/browser/notes", async (c, next) => {
    if (!experimentalEnabled()) return c.notFound();
    await next();
  });
  app.use("/browser/notes/*", async (c, next) => {
    if (!experimentalEnabled()) return c.notFound();
    await next();
  });
  app.use("/admin/browser-notes/*", async (c, next) => {
    if (!experimentalEnabled()) return c.notFound();
    await next();
  });
  const captureLimiter = notesRateLimiter();
  app.post(
    "/browser/notes/authorization",
    scope.deviceSelf(),
    validateJson(authorizationBody),
    (c) => c.json(service.createAuthorization(c.get("auth"), c.req.valid("json").id), 201),
  );
  app.get("/browser/notes/authorization/:id", scope.deviceSelf(), (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(service.poll(c.get("auth"), c.req.param("id")));
  });
  app.get("/admin/browser-notes/authorizations/:id", scope.admin(), (c) =>
    c.json(service.authorization(c.req.param("id"))),
  );
  app.post("/admin/browser-notes/authorizations/:id/approve", scope.portalAdmin(), async (c) => {
    await service.approve(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/browser/notes", scope.deviceSelf(), (c) => c.json(service.status(c.get("auth"))));
  app.post("/browser/notes", scope.deviceSelf(), validateJson(browserNoteBody), async (c) => {
    if (!isLoopbackRequest(c) && captureLimiter.consume(clientIp(c))) {
      return c.json({ error: "Too many capture requests — try again later" }, 429, {
        "Retry-After": "60",
      });
    }
    const { version: _version, ...input } = c.req.valid("json");
    return c.json(await service.capture(c.get("auth"), input), 201);
  });
}
