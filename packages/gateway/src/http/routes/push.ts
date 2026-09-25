// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { notificationDeliveryHealthReportSchema } from "@omnesis/core/push";
import { DeviceId, tryDeviceId } from "@omnesis/types";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { scope } from "../scope.js";
import { validateJson, validateQuery } from "../validate.js";
import type { RouteApp } from "./types.js";
import type { PushAdminService } from "../services/PushAdminService.js";

const importCredentialBody = z
  .object({ platform: z.enum(["ios", "android"]), sourcePath: z.string().trim().min(1) })
  .strict();
const legacyImportBody = z.object({ sourcePath: z.string().trim().min(1) }).strict();
const pushTestQuery = z.object({ deviceId: z.string().uuid().optional() }).strict();

export function mountPushRoutes(app: RouteApp, service: PushAdminService): void {
  app.get("/admin/push/status", scope.admin(), (c) => c.json(service.status()));
  app.post("/admin/push/test", scope.admin(), validateQuery(pushTestQuery), async (c) => {
    const { deviceId } = c.req.valid("query");
    return c.json({ result: await service.sendTest(deviceId ? DeviceId(deviceId) : undefined) });
  });
  app.post(
    "/admin/push/import-credential",
    scope.admin(),
    validateJson(importCredentialBody),
    (c) => c.json({ path: service.importCredential(c.req.valid("json")) }),
  );
  app.post(
    "/admin/devices/:id/push-health",
    scope.admin(),
    validateJson(notificationDeliveryHealthReportSchema),
    async (c) => {
      const id = tryDeviceId(c.req.param("id"));
      if (!id) throw new NotFoundError("device not found");
      if (c.get("auth").deviceId !== id) {
        throw new ForbiddenError("a phone may report only its own delivery health");
      }
      return c.json(await service.reportDeliveryHealth(id, c.req.valid("json").status));
    },
  );

  // Legacy APNs aliases remain for older CLI/app versions.
  app.get("/admin/apns/status", scope.admin(), (c) => {
    const current = service.status();
    return c.json({
      configured: current.configured.apns,
      settings: current.settings.apns,
      deviceCount: current.devices.directApns,
    });
  });
  app.post("/admin/apns/test", scope.admin(), async (c) =>
    c.json({ result: await service.sendTest() }),
  );
  app.post("/admin/apns/import-key", scope.admin(), validateJson(legacyImportBody), (c) =>
    c.json({
      keyPath: service.importCredential({
        platform: "ios",
        sourcePath: c.req.valid("json").sourcePath,
      }),
    }),
  );
}
