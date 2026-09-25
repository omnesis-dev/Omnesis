// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { createLogger } from "@omnesis/core";
import { mobilePermissionHealthReportSchema } from "@omnesis/core/mobile-permission-health";
import { bodyLimit } from "hono/body-limit";
import { SourceId } from "@omnesis/types";
import { enforceWriteScopeForSource, scope } from "../scope.js";
import { observeMalformedJson, validateJson } from "../validate.js";
import { ForbiddenError } from "../errors.js";
import type { MobilePermissionHealthService } from "../services/MobilePermissionHealthService.js";
import type { RouteApp } from "./types.js";

const log = createLogger("gateway:http:mobile-permission-health");
const PERMISSION_HEALTH_BODY_LIMIT_BYTES = 64 * 1024;
const permissionHealthBodyLimit = bodyLimit({
  maxSize: PERMISSION_HEALTH_BODY_LIMIT_BYTES,
  onError: (c) =>
    c.json(
      {
        error: `Permission-health body too large (max ${PERMISSION_HEALTH_BODY_LIMIT_BYTES} bytes)`,
        code: "PAYLOAD_TOO_LARGE",
      },
      413,
    ),
});

function malformedBodySummary(body: string): string {
  // Report enough to correlate repeated client failures without ever putting
  // protected-data labels, remediation text, or arbitrary malformed input in
  // a gateway log.
  return `${Buffer.byteLength(body)} bytes, sha256=${createHash("sha256").update(body).digest("hex")}`;
}

export function mountMobilePermissionHealthRoute(
  app: RouteApp,
  service: MobilePermissionHealthService,
): void {
  app.put(
    "/admin/sources/:id/permission-health",
    scope.writeAny(),
    permissionHealthBodyLimit,
    observeMalformedJson((body) => {
      log.warn(`Malformed permission-health JSON: ${malformedBodySummary(body)}`);
    }),
    validateJson(mobilePermissionHealthReportSchema),
    async (c) => {
      const sourceId = SourceId(c.req.param("id"));
      const auth = c.get("auth");
      if (!auth.deviceId) throw new ForbiddenError("a paired phone is required");
      enforceWriteScopeForSource(auth.scopes, sourceId);
      return c.json(await service.report(auth.deviceId, sourceId, c.req.valid("json")));
    },
  );
}
