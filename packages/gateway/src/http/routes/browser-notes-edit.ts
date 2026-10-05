// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { experimentalEnabled } from "@omnesis/core";
import { scope } from "../scope.js";
import { validateJson, validateQuery } from "../validate.js";
import {
  authorizationBody,
  browserNoteEditBody,
  browserNotesPageQuery,
} from "../schemas/browser-notes.js";
import type { RouteApp } from "./types.js";
import type { BrowserNotesEditService } from "../services/BrowserNotesEditService.js";

export function mountBrowserNotesEditRoutes(app: RouteApp, service: BrowserNotesEditService): void {
  app.use("/browser/notes/edit", async (c, next) =>
    experimentalEnabled() ? next() : c.notFound(),
  );
  app.use("/browser/notes/edit/*", async (c, next) =>
    experimentalEnabled() ? next() : c.notFound(),
  );
  app.post(
    "/browser/notes/edit/enable",
    scope.deviceSelf(),
    validateJson(authorizationBody),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await service.enable(c.get("auth"), c.req.valid("json").id));
    },
  );
  app.get("/browser/notes/edit", scope.deviceSelf(), validateQuery(browserNotesPageQuery), (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(service.list(c.get("auth"), c.req.valid("query").url));
  });
  app.patch(
    "/browser/notes/edit/:id",
    scope.deviceSelf(),
    validateJson(browserNoteEditBody),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const { version: _version, ...input } = c.req.valid("json");
      return c.json(await service.edit(c.get("auth"), c.req.param("id"), input));
    },
  );
}
