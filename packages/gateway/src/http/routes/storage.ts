// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { SourceId } from "@omnesis/types";
import { BadRequestError } from "../errors.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import type { StorageService } from "../../storage/service.js";
import type { RouteApp } from "./types.js";

const sourceId = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    try {
      SourceId(value);
      return true;
    } catch {
      return false;
    }
  }, "Invalid source id");
const policy = z
  .object({
    maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    maxDiskUsedPercent: z.number().min(50).max(99).optional(),
    resumeMarginPercent: z.number().min(0.1).max(10).optional(),
  })
  .strict();
const retention = z
  .object({ sourceId, maxAgeDays: z.number().int().min(1).max(36_500).nullable() })
  .strict();
const trim = z.object({ sourceId, before: z.iso.datetime() }).strict();

const cleanupCutoff = z.iso
  .datetime()
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    "Choose a canonical UTC cutoff",
  );
const cleanup = z.discriminatedUnion("target", [
  z.object({ target: z.literal("brain-transcripts"), before: cleanupCutoff }).strict(),
  z.object({ target: z.literal("conversations"), before: cleanupCutoff }).strict(),
  z
    .object({
      target: z.literal("backups"),
      before: cleanupCutoff,
      keepNewest: z.boolean().default(true),
    })
    .strict(),
]);

export function mountStorageRoutes(app: RouteApp, service: StorageService): void {
  app.get("/admin/storage/jobs/:id", scope.admin(), (c) => {
    c.header("Cache-Control", "no-store");
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) throw new BadRequestError("Invalid storage job id");
    return c.json(service.job(id.data));
  });
  app.get("/admin/storage/cleanup/jobs", scope.admin(), (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(service.cleanupJobs());
  });
  app.post("/admin/storage/cleanup/jobs", scope.admin(), validateJson(cleanup), async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await service.startCleanup(c.req.valid("json")), 202);
  });
  app.post(
    "/admin/storage/cleanup/jobs/:id/cancel",
    scope.admin(),
    validateJson(z.object({}).strict()),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const id = z.uuid().safeParse(c.req.param("id"));
      if (!id.success) throw new BadRequestError("Invalid cleanup job id");
      return c.json(await service.cancelCleanup(id.data));
    },
  );
  app.get("/admin/storage", scope.admin(), (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(service.snapshot());
  });
  app.post(
    "/admin/storage/refresh",
    scope.admin(),
    validateJson(z.object({}).strict()),
    async (c) => c.json(await service.refresh()),
  );
  app.patch("/admin/storage/policy", scope.admin(), validateJson(policy), async (c) =>
    c.json(await service.setPolicy(c.req.valid("json"))),
  );
  app.patch("/admin/storage/retention", scope.admin(), validateJson(retention), async (c) => {
    const input = c.req.valid("json");
    return c.json(await service.setRetention(input.sourceId, input.maxAgeDays));
  });
  app.post("/admin/storage/trim/jobs", scope.admin(), validateJson(trim), async (c) => {
    const input = c.req.valid("json");
    c.header("Cache-Control", "no-store");
    return c.json(await service.startTrim(input.sourceId, input.before), 202);
  });
}
