// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scope } from "../../http/scope.js";
import { enumParam, limitParam } from "../admin-http-shared.js";
import type { RouteApp } from "../../http/routes/types.js";
import type { KnowledgeQueryService } from "./query-service.js";

export function mountKnowledgeAdminRoutes(
  app: RouteApp,
  query: KnowledgeQueryService,
  requireVisible: () => void,
): void {
  app.get("/admin/brain/knowledge", scope.admin(), (c) => {
    requireVisible();
    const kind = enumParam(c.req.query("kind"), "kind", [
      "wiki",
      "root",
      "loop",
      "doc_annotation",
      "person_annotation",
      "brief",
    ] as const);
    const limit = limitParam(c.req.query("limit"), "limit", 30, 100);
    return c.json({ items: query.list({ kind, afterId: c.req.query("afterId"), limit }) });
  });
  app.get("/admin/brain/knowledge/decisions", scope.admin(), (c) => {
    requireVisible();
    return c.json({ items: query.decisions(limitParam(c.req.query("limit"), "limit", 30, 100)) });
  });
  app.get("/admin/brain/knowledge/status", scope.admin(), (c) => {
    requireVisible();
    return c.json(query.status());
  });
  app.get("/admin/brain/knowledge/batches", scope.admin(), (c) => {
    requireVisible();
    return c.json({ items: query.batches(limitParam(c.req.query("limit"), "limit", 30, 100)) });
  });
  app.get("/admin/brain/knowledge/batches/:id", scope.admin(), (c) => {
    requireVisible();
    return c.json(query.batch(c.req.param("id")));
  });
  app.get("/admin/brain/knowledge/:id/history", scope.admin(), (c) => {
    requireVisible();
    return c.json({ items: query.history(c.req.param("id")) });
  });
  app.get("/admin/brain/knowledge/:id", scope.admin(), (c) => {
    requireVisible();
    return c.json(query.fetch(c.req.param("id"), c.req.query("editing") === "1"));
  });
}
