// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { experimentalEnabled } from "@omnesis/core";
import { NotFoundError } from "../errors.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import type { LabService } from "../../lab/service.js";
import type { RouteApp } from "./types.js";

const featureId = z.enum(["brain", "tasks", "watches"]);
const update = z.object({ enabled: z.boolean() }).strict();

export function mountLabRoutes(app: RouteApp, service: LabService): void {
  for (const path of ["/admin/lab", "/admin/lab/*"])
    app.use(path, async (_c, next) => {
      if (!experimentalEnabled()) throw new NotFoundError("Omnesis Lab is unavailable");
      await next();
    });
  app.get("/admin/lab", scope.admin(), (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(service.snapshot());
  });
  app.put("/admin/lab/:id", scope.admin(), validateJson(update), async (c) => {
    const id = featureId.safeParse(c.req.param("id"));
    if (!id.success) throw new NotFoundError("Unknown experiment");
    c.header("Cache-Control", "no-store");
    return c.json(await service.set(id.data, c.req.valid("json").enabled));
  });
}
