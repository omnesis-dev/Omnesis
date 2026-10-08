// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { BadRequestError } from "../../http/errors.js";
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
  app.get("/admin/brain/knowledge/library", scope.admin(), (c) => {
    requireVisible();
    const kind = enumParam(c.req.query("kind"), "kind", [
      "wiki",
      "root",
      "loop",
      "brief",
      "doc_annotation",
      "person_annotation",
    ] as const);
    return c.json(
      query.library({
        kind,
        consistency: enumParam(c.req.query("consistency"), "consistency", [
          "strict",
          "live",
        ] as const),
        status: c.req.query("status"),
        cursor: c.req.query("cursor"),
        limit: limitParam(c.req.query("limit"), "limit", 30, 100),
      }),
    );
  });
  app.get("/admin/brain/knowledge/library/:id", scope.admin(), (c) => {
    requireVisible();
    return c.json(query.libraryRetirement(c.req.param("id")));
  });
  app.get("/admin/brain/knowledge/decisions/:id", scope.admin(), (c) => {
    requireVisible();
    return c.json(query.decision(c.req.param("id")));
  });
  app.get("/admin/brain/knowledge/decisions", scope.admin(), (c) => {
    requireVisible();
    return c.json(
      query.decisionsPage({
        limit: limitParam(c.req.query("limit"), "limit", 30, 100),
        purpose: enumParam(c.req.query("purpose"), "purpose", [
          "discovery",
          "impact",
          "review",
          "urgency",
          "worth-gate",
          "record-check",
        ] as const),
        cursor: c.req.query("cursor"),
      }),
    );
  });
  app.get("/admin/brain/knowledge/:id/decisions", scope.admin(), (c) => {
    requireVisible();
    return c.json(query.nodeDecisions(c.req.param("id")));
  });
  app.get("/admin/brain/knowledge/pending-work", scope.admin(), (c) => {
    requireVisible();
    const reason = enumParam(c.req.query("reason"), "reason", [
      "change",
      "discovery",
      "review",
      "root",
      "upgrade",
    ] as const);
    const tier = enumParam(c.req.query("tier"), "tier", ["immediate", "soon", "routine"] as const);
    if (!reason || !tier)
      throw new BadRequestError("Pending work requires an exact reason and tier");
    return c.json(
      query.pendingWork({
        reason,
        tier,
        readiness: c.req.query("readiness"),
        cursor: c.req.query("cursor"),
        limit: limitParam(c.req.query("limit"), "limit", 20, 50),
      }),
    );
  });
  app.get("/admin/brain/knowledge/status", scope.admin(), (c) => {
    requireVisible();
    return c.json(query.status());
  });
  app.get("/admin/brain/knowledge/batches", scope.admin(), (c) => {
    requireVisible();
    return c.json(
      query.batchesPage({
        reason: enumParam(c.req.query("reason"), "reason", [
          "change",
          "discovery",
          "review",
          "root",
          "upgrade",
        ] as const),
        tier: enumParam(c.req.query("tier"), "tier", ["immediate", "soon", "routine"] as const),
        status: enumParam(c.req.query("status"), "status", [
          "all",
          "active",
          "history",
          "pending",
          "running",
          "completed",
          "deferred",
          "abandoned",
        ] as const),
        cursor: c.req.query("cursor"),
        limit: limitParam(c.req.query("limit"), "limit", 30, 100),
      }),
    );
  });
  app.get("/admin/brain/knowledge/batches/:id", scope.admin(), (c) => {
    requireVisible();
    return c.json(query.batch(c.req.param("id")));
  });
  app.get("/admin/brain/knowledge/:id/connections", scope.admin(), (c) => {
    requireVisible();
    return c.json(
      query.connections(c.req.param("id"), {
        cursor: c.req.query("cursor"),
        limit: limitParam(c.req.query("limit"), "limit", 30, 100),
      }),
    );
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
