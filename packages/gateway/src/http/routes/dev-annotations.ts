// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { createLogger, devModeEnabled } from "@omnesis/core";
import {
  DEV_ANNOTATION_TARGET_TYPES,
  listDevAnnotations,
  type DevAnnotationStatus,
  type DevAnnotationTargetType,
} from "../../dev-annotations/store.js";
import { NotFoundError } from "../errors.js";
import { scope } from "../scope.js";
import { createDevAnnotationBody, resolveDevAnnotationBody } from "../schemas/index.js";
import { validateJson } from "../validate.js";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, RouteApp } from "./types.js";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

// Stable body a gated-off gateway returns. The CLI recognises the phrase
// "developer mode" in a 404 body to print its dev-mode-off hint (it can't
// import this constant across packages), so keep the wording in sync.
const DEV_MODE_DISABLED_MESSAGE = "developer mode is disabled";

type Db = Database.Database;

const log = createLogger("gateway:http").child("routes:dev-annotations");

export interface DevAnnotationRoutesDeps {
  db: Db;
  writeGate: WriteGate;
}

/**
 * Developer-annotations routes (`/dev/annotations`) — the operator → engineer
 * data-quality feedback channel. The whole surface is gated behind
 * `OMNESIS_DEV_MODE`: a gate middleware runs FIRST on every route and 404s
 * when developer mode is off — before the scope guard and body validation — so
 * with dev mode off the routes are indistinguishable from absent (no 401 for a
 * missing token, no 400 for a malformed body). Defense in depth alongside the
 * clients hiding the capture affordance.
 *
 * Writes flow through the single-writer `WriteGate`; reads hit the store
 * directly. The note's `context` snapshot is client-supplied — captured from
 * exactly what the operator was looking at — so it stays legible even after
 * the target entity is edited or deleted.
 *
 * Auth: `scope.read()`. The `OMNESIS_DEV_MODE` env var is the real boundary
 * (operator-only), so any authenticated read-scope client (the portal session
 * or a paired iOS token) may file notes without a bespoke write scope.
 */
export function mountDevAnnotationsRoutes(app: RouteApp, deps: DevAnnotationRoutesDeps): void {
  const { db, writeGate } = deps;

  // First middleware on every route: 404 unless developer mode is on. Runs
  // before the scope guard and body validation so a gated-off gateway never
  // leaks the routes' existence through a 401/400/403. Read fresh on every
  // request (matching `devModeEnabled()`), so a runtime env toggle takes
  // effect without a restart.
  const requireDevMode: MiddlewareHandler<AppEnv> = async (_c, next) => {
    if (!devModeEnabled()) throw new NotFoundError(DEV_MODE_DISABLED_MESSAGE);
    await next();
  };

  app.post(
    "/dev/annotations",
    requireDevMode,
    scope.read(),
    validateJson(createDevAnnotationBody),
    async (c) => {
      const body = c.req.valid("json");
      const created = await writeGate.createDevAnnotation(
        {
          id: randomUUID(),
          targetType: body.targetType,
          targetId: body.targetId ?? null,
          note: body.note,
          context: body.context ?? null,
          deepLink: body.deepLink ?? null,
          client: body.client ?? null,
        },
        Date.now(),
      );
      log.info(
        `filed dev annotation ${created.id} on ${created.targetType} ${created.targetId ?? "-"}`,
      );
      return c.json(created, 201);
    },
  );

  app.get("/dev/annotations", requireDevMode, scope.read(), async (c) => {
    const statusRaw = c.req.query("status");
    const status: DevAnnotationStatus | "all" =
      statusRaw === "all" || statusRaw === "resolved" || statusRaw === "open" ? statusRaw : "open";
    const typeRaw = c.req.query("targetType");
    const targetType =
      typeRaw && (DEV_ANNOTATION_TARGET_TYPES as readonly string[]).includes(typeRaw)
        ? (typeRaw as DevAnnotationTargetType)
        : undefined;
    const annotations = listDevAnnotations(db, { status, targetType });
    return c.json({ annotations });
  });

  app.post(
    "/dev/annotations/:id/resolve",
    requireDevMode,
    scope.read(),
    validateJson(resolveDevAnnotationBody),
    async (c) => {
      const id = c.req.param("id");
      const body = c.req.valid("json");
      const resolved = await writeGate.resolveDevAnnotation(id, Date.now(), body.note ?? null);
      if (!resolved) throw new NotFoundError(`dev annotation ${id} not found`);
      return c.json(resolved);
    },
  );

  app.delete("/dev/annotations/:id", requireDevMode, scope.read(), async (c) => {
    const id = c.req.param("id");
    const removed = await writeGate.deleteDevAnnotation(id);
    if (!removed) throw new NotFoundError(`dev annotation ${id} not found`);
    return c.json({ ok: true });
  });
}
